/**
 * PDF 阅读视图（基于 pdf.js）
 *
 * 对外接口刻意与 BookReader 保持一致（open / goTo / next / prev / goFraction /
 * location / pageInfo / search / setAnnotations ...），这样 app.js 里书架、目录、
 * 书签、搜索、进度条、状态栏这些逻辑都能直接复用。
 *
 * PDF 与 EPUB 的本质差异：
 *  - 页面是固定版式，不能重排，所以采用「连续滚动 + 按视口渲染」
 *  - 没有 CFI，用 pdf:页码 作为定位标识，进度按页码百分比计算
 */
import * as pdfjs from '../lib/pdf/pdf.mjs'

const APP_BASE = new URL('../', import.meta.url)
pdfjs.GlobalWorkerOptions.workerSrc = new URL('lib/pdf/pdf.worker.mjs', APP_BASE).href
const CMAP_URL = new URL('lib/pdf/cmaps/', APP_BASE).href
const FONT_URL = new URL('lib/pdf/standard_fonts/', APP_BASE).href

const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

const pageOf = (value) => {
  if (typeof value === 'number') return Math.max(1, Math.round(value))
  const m = String(value || '').match(/(\d+)\s*$/)
  return m ? Math.max(1, parseInt(m[1], 10)) : 0
}

/** 取 PDF 元数据与首页封面（导入时用） */
export async function pdfMetaAndCover (url, maxWidth = 640) {
  const doc = await pdfjs.getDocument({
    url,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    isEvalSupported: false,
  }).promise
  let title = ''
  let author = ''
  try {
    const meta = await doc.getMetadata()
    title = String(meta?.info?.Title || '').trim()
    author = String(meta?.info?.Author || '').trim()
  } catch { /* ignore */ }
  let cover = null
  try {
    const page = await doc.getPage(1)
    const vp1 = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: Math.min(2, maxWidth / vp1.width) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(vp.width)
    canvas.height = Math.round(vp.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
    cover = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
  } catch { /* ignore */ }
  const pages = doc.numPages
  try { await doc.destroy() } catch { /* ignore */ }
  return { title, author, cover, pages }
}

export class PdfReader extends EventTarget {
  nativeScroll = true

  #host = null
  #doc = null
  #stage = null
  #list = null
  #items = []           // 每页：{ n, el, canvas, hl, text, height, rendered }
  #total = 0
  #zoom = 1             // 用户缩放倍率（相对“适宽”）
  #page = 1
  #toc = []
  #annos = new Map()    // page -> [{ value, color, rects }]
  #io = null
  #currentDoc = null
  #scrollRaf = 0
  #last = null
  #baseWidth = 612      // 首页宽高比基准
  #baseHeight = 792
  #ro = null
  #roTimer = 0

  constructor (host) {
    super()
    this.#host = host
  }

  get location () { return this.#last }
  get pageInfo () { return { page: this.#page, pages: this.#total } }

  // ------------------------------------------------------------ 打开
  async open ({ url, cfi, settings, annotations }) {
    this.close()
    const doc = await pdfjs.getDocument({
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise

    this.#doc = doc
    this.#total = doc.numPages

    const stage = document.createElement('div')
    stage.className = 'pdf-stage'
    const list = document.createElement('div')
    list.className = 'pdf-pages'
    stage.append(list)
    this.#host.append(stage)
    this.#stage = stage
    this.#list = list
    if (settings?.bg) stage.style.background = settings.bg

    const first = await doc.getPage(1)
    const vp1 = first.getViewport({ scale: 1 })
    this.#baseWidth = vp1.width
    this.#baseHeight = vp1.height

    // 等一帧，确保容器已经完成布局，否则 clientWidth 还是 0，
    // 会退化成 900px 兜底宽度导致页面右侧被裁掉
    await new Promise((r) => requestAnimationFrame(r))
    const width = this.#contentWidth()
    // 页壳：先把高度占住，滚动条与位置才不会跳
    const ratio = vp1.height / vp1.width
    for (let i = 1; i <= this.#total; i++) {
      const el = document.createElement('div')
      el.className = 'pdf-page'
      el.dataset.n = String(i)
      el.style.width = width + 'px'
      el.style.height = Math.round(width * ratio) + 'px'
      list.append(el)
      this.#items.push({
        n: i, el, canvas: null, hl: null, text: null,
        height: Math.round(width * ratio), rendered: false, busy: false,
      })
    }

    // 标注
    for (const a of (annotations || [])) this.#collect(a)

    // 目录（PDF 书签）
    this.#toc = await this.#buildToc()

    this.#io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const item = this.#items[Number(en.target.dataset.n) - 1]
        if (!item) continue
        if (en.isIntersecting) this.#render(item)
        else if (item.rendered && Math.abs(item.n - this.#page) > 5) this.#unrender(item)
      }
    }, { root: stage, rootMargin: '900px 0px' })
    for (const it of this.#items) this.#io.observe(it.el)

    stage.addEventListener('scroll', () => this.#onScroll(), { passive: true })
    stage.addEventListener('mouseup', (e) => this.#onMouseUp(e))
    stage.addEventListener('mousedown', () => this.dispatchEvent(new CustomEvent('selection-clear')))
    stage.addEventListener('keydown', (e) => this.#onKey(e), true)
    stage.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false })

    // 窗口尺寸变化时重新适宽
    this.#ro = new ResizeObserver(() => {
      clearTimeout(this.#roTimer)
      this.#roTimer = setTimeout(() => this.applyLayout({ bg: stage.style.background }, 0, 0), 180)
    })
    this.#ro.observe(stage)

    const start = pageOf(cfi) || 1
    this.#page = clamp(start, 1, this.#total)
    await this.#scrollToPage(this.#page, false)
    this.#emit()

    return { toc: this.#toc }
  }

  close () {
    try { this.#ro?.disconnect() } catch { /* ignore */ }
    this.#ro = null
    clearTimeout(this.#roTimer)
    try { this.#io?.disconnect() } catch { /* ignore */ }
    this.#io = null
    try { this.#doc?.destroy() } catch { /* ignore */ }
    this.#doc = null
    this.#host.innerHTML = ''
    this.#items = []
    this.#annos = new Map()
    this.#total = 0
    this.#last = null
  }

  #contentWidth () {
    const w = (this.#stage?.clientWidth || 900) - 28
    return Math.max(240, Math.round(w * this.#zoom))
  }

  // ------------------------------------------------------------ 渲染
  async #render (item) {
    if (!this.#doc || item.rendered || item.busy) return
    item.busy = true
    try {
      const page = await this.#doc.getPage(item.n)
      const vp1 = page.getViewport({ scale: 1 })
      const targetW = this.#contentWidth()
      const dprScale = window.devicePixelRatio > 1 ? Math.min(window.devicePixelRatio, 2) : 1
      const vp = page.getViewport({ scale: targetW / vp1.width })

      const canvas = item.canvas || document.createElement('canvas')
      canvas.className = 'pdf-canvas'
      canvas.width = Math.floor(vp.width * dprScale)
      canvas.height = Math.floor(vp.height * dprScale)
      canvas.style.width = vp.width + 'px'
      canvas.style.height = vp.height + 'px'
      const ctx = canvas.getContext('2d', { alpha: false })
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      await page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dprScale !== 1 ? [dprScale, 0, 0, dprScale, 0, 0] : null,
      }).promise

      item.el.style.width = Math.round(vp.width) + 'px'
      item.el.style.height = Math.round(vp.height) + 'px'
      if (!item.canvas) {
        item.el.append(canvas)
        item.canvas = canvas
      }

      // 文字层（用于选中/复制/搜索定位）
      if (!item.text) {
        const tl = document.createElement('div')
        tl.className = 'textLayer'
        tl.style.setProperty('--scale-factor', String(vp.width / vp1.width))
        tl.style.width = vp.width + 'px'
        tl.style.height = vp.height + 'px'
        item.el.append(tl)
        item.text = tl
        try {
          const layer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container: tl,
            viewport: vp,
          })
          await layer.render()
        } catch (err) { console.warn('文字层渲染失败', err) }
      }

      // 划线层
      if (!item.hl) {
        const hl = document.createElement('div')
        hl.className = 'pdf-hl'
        item.el.append(hl)
        item.hl = hl
      }
      this.#paintAnnotations(item)

      item.rendered = true
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('PDF 页面渲染失败', item.n, err)
    } finally {
      item.busy = false
    }
  }

  #unrender (item) {
    if (item.busy) return
    if (item.canvas) { item.canvas.width = 0; item.canvas.height = 0; item.canvas.remove(); item.canvas = null }
    if (item.text) { item.text.remove(); item.text = null }
    item.rendered = false
  }

  // ------------------------------------------------------------ 滚动与定位
  #onScroll () {
    if (this.#scrollRaf) return
    this.#scrollRaf = requestAnimationFrame(() => {
      this.#scrollRaf = 0
      const top = this.#stage.scrollTop + 8
      let cur = 1
      for (const it of this.#items) {
        if (it.el.offsetTop <= top + 4) cur = it.n
        else break
      }
      if (cur !== this.#page) {
        this.#page = cur
        this.#emit()
      }
    })
  }

  #emit () {
    const n = this.#page
    const fraction = this.#total > 1 ? clamp((n - 1) / (this.#total - 1), 0, 1) : 0
    const payload = {
      cfi: 'pdf:' + n,
      fraction,
      page: n,
      pages: this.#total,
      tocItem: this.#tocItemFor(n),
    }
    this.#last = payload
    this.dispatchEvent(new CustomEvent('relocate', { detail: payload }))
  }

  #tocItemFor (n) {
    let best = null
    const walk = (items) => {
      for (const it of items) {
        const p = pageOf(it.href)
        if (p && p <= n && (!best || p >= pageOf(best.href))) best = it
        if (it.subitems?.length) walk(it.subitems)
      }
    }
    walk(this.#toc)
    return best
  }

  async #scrollToPage (n, smooth = true) {
    const item = this.#items[n - 1]
    if (!item) return
    // 目标页还没排版时先渲染，避免落到占位高度上
    if (!item.rendered) await this.#render(item)
    const y = Math.max(0, item.el.offsetTop - 10)
    this.#stage.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' })
    this.#page = n
  }

  // ------------------------------------------------------------ 对外操作
  async goTo (target) {
    let n = pageOf(target)
    if (!n) return
    n = clamp(n, 1, this.#total)
    await this.#scrollToPage(n)
    this.#emit()
  }

  async goToFraction (f) {
    const n = this.#total > 1 ? Math.round(clamp(Number(f) || 0, 0, 1) * (this.#total - 1)) + 1 : 1
    await this.goTo(n)
  }

  async next () { await this.goTo(Math.min(this.#page + 1, this.#total)) }
  async prev () { await this.goTo(Math.max(this.#page - 1, 1)) }
  goLeft () { return this.prev() }
  goRight () { return this.next() }

  /** 按像素平滑滚动（方向键用） */
  scrollBy (dy) {
    if (!this.#stage) return
    this.#stage.scrollBy({ top: dy, behavior: 'auto' })
  }

  applyStyle (settings) {
    if (this.#stage && settings?.bg) this.#stage.style.background = settings.bg
  }

  applyLayout (settings, w, h) {
    if (!this.#stage) return
    this.applyStyle(settings)
    const width = this.#contentWidth()
    const firstW = this.#items[0]?.el.offsetWidth || 0
    if (Math.abs(width - firstW) < 2) return
    const ratio = this.#baseHeight / this.#baseWidth
    for (const it of this.#items) {
      this.#unrender(it)
      it.el.style.width = width + 'px'
      it.el.style.height = Math.round(width * ratio) + 'px'
    }
    const keep = this.#page
    requestAnimationFrame(async () => {
      await this.#scrollToPage(keep, false)
      for (let n = Math.max(1, keep - 2); n <= Math.min(this.#total, keep + 2); n++) {
        const it = this.#items[n - 1]
        if (it) this.#render(it)
      }
      this.#emit()
    })
  }

  setMarginalHead () { /* PDF 页面自带页眉，无需注入 */ }

  // 缩放（Ctrl+滚轮 / Ctrl 加减）
  zoomBy (delta) {
    const next = clamp(this.#zoom * (1 + delta), 0.5, 4)
    if (Math.abs(next - this.#zoom) < 0.001) return
    this.#zoom = next
    this.applyLayout({ bg: this.#stage?.style.background }, 0, 0)
    this.dispatchEvent(new CustomEvent('zoom', { detail: { zoom: this.#zoom } }))
  }

  get zoom () { return this.#zoom }

  resetZoom () {
    if (Math.abs(this.#zoom - 1) < 0.001) return
    this.#zoom = 1
    this.applyLayout({ bg: this.#stage?.style.background }, 0, 0)
    this.dispatchEvent(new CustomEvent('zoom', { detail: { zoom: 1 } }))
  }

  #onWheel (e) {
    if (!e.ctrlKey) return
    e.preventDefault()
    this.zoomBy(e.deltaY > 0 ? -0.1 : 0.1)
  }

  #onKey (e) {
    if (!e.ctrlKey) return
    if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopPropagation(); this.zoomBy(0.1) }
    else if (e.key === '-') { e.preventDefault(); e.stopPropagation(); this.zoomBy(-0.1) }
    else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); this.#zoom = 1; this.applyLayout({}, 0, 0); this.dispatchEvent(new CustomEvent('zoom', { detail: { zoom: 1 } })) }
  }

  // ------------------------------------------------------------ 目录
  async #buildToc () {
    const doc = this.#doc
    let outline = null
    try { outline = await doc.getOutline() } catch { /* ignore */ }
    if (!outline?.length) {
      if (this.#total <= 100) {
        return Array.from({ length: this.#total }, (_, i) => ({ label: `第 ${i + 1} 页`, href: 'pdf:' + (i + 1) }))
      }
      return []
    }
    const resolve = async (dest) => {
      try {
        let d = dest
        if (typeof d === 'string') d = await doc.getDestination(d)
        if (Array.isArray(d) && d[0]) {
          const idx = await doc.getPageIndex(d[0])
          return idx + 1
        }
      } catch { /* ignore */ }
      return 0
    }
    const walk = async (items) => {
      const out = []
      for (const it of items) {
        const p = await resolve(it.dest)
        const node = { label: String(it.title || '').trim() || '未命名', href: p ? 'pdf:' + p : '' }
        if (it.items?.length) {
          const kids = await walk(it.items)
          if (kids.length) node.subitems = kids
        }
        out.push(node)
      }
      return out
    }
    return walk(outline)
  }

  // ------------------------------------------------------------ 搜索
  async * search (query) {
    const q = String(query || '').trim()
    if (!q || !this.#doc) { yield 'done'; return }
    const needle = q.toLowerCase()
    let found = 0
    for (let n = 1; n <= this.#total; n++) {
      yield { progress: n / this.#total }
      let text = ''
      try {
        const page = await this.#doc.getPage(n)
        const tc = await page.getTextContent()
        text = tc.items.map(it => it.str || '').join(' ').replace(/\s+/g, ' ')
      } catch { continue }
      const lower = text.toLowerCase()
      let from = 0
      const hits = []
      while (hits.length < 12) {
        const at = lower.indexOf(needle, from)
        if (at < 0) break
        const s = Math.max(0, at - 28)
        hits.push({
          cfi: 'pdf:' + n,
          excerpt: text.slice(s, Math.min(text.length, at + needle.length + 42)),
        })
        from = at + needle.length
        found++
      }
      if (hits.length) yield { label: `第 ${n} 页`, subitems: hits }
      if (found > 400) break
    }
    yield 'done'
  }

  clearSearchMarks () { /* PDF 不做正文高亮 */ }

  // ------------------------------------------------------------ 标注
  setAnnotations (list) {
    this.#annos = new Map()
    for (const a of (list || [])) this.#collect(a)
    for (const it of this.#items) if (it.hl) this.#paintAnnotations(it)
  }

  #collect (a) {
    const n = pageOf(a.value || a.cfi || a.page)
    if (!n || !a.rects?.length) return
    if (!this.#annos.has(n)) this.#annos.set(n, [])
    this.#annos.get(n).push(a)
  }

  async addAnnotation (a) {
    const n = pageOf(a.value) || a.page
    if (!n || !a.rects?.length) return
    if (!this.#annos.has(n)) this.#annos.set(n, [])
    this.#annos.get(n).push(a)
    const item = this.#items[n - 1]
    if (item) {
      if (!item.rendered) await this.#render(item)
      if (!item.hl) {
        item.hl = document.createElement('div')
        item.hl.className = 'pdf-hl'
        item.el.append(item.hl)
      }
      this.#paintAnnotations(item)
    }
  }

  async removeAnnotation (a) {
    const n = pageOf(a.value) || a.page
    if (!n) return
    const list = (this.#annos.get(n) || []).filter(x => x.id !== a.id)
    this.#annos.set(n, list)
    const item = this.#items[n - 1]
    if (item) this.#paintAnnotations(item)
  }

  #paintAnnotations (item) {
    if (!item.hl) return
    item.hl.innerHTML = ''
    const list = this.#annos.get(item.n) || []
    for (const a of list) {
      for (const r of (a.rects || [])) {
        const d = document.createElement('div')
        d.className = 'pdf-mark'
        d.dataset.value = a.value
        d.style.left = (r.x * 100) + '%'
        d.style.top = (r.y * 100) + '%'
        d.style.width = (r.w * 100) + '%'
        d.style.height = (r.h * 100) + '%'
        d.style.background = a.color || 'rgba(255,214,10,.42)'
        if (a.note) d.title = a.note
        item.hl.append(d)
      }
    }
  }

  // ------------------------------------------------------------ 选中
  #onMouseUp () {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = (node.nodeType === 1 ? node : node.parentElement)
    const pageEl = el?.closest?.('.pdf-page')
    if (!pageEl) return
    const text = String(sel.toString() || '').replace(/\s+/g, ' ').trim()
    if (!text) return

    const pr = pageEl.getBoundingClientRect()
    if (pr.width < 1 || pr.height < 1) return
    const rects = []
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue
      rects.push({
        x: clamp((r.left - pr.left) / pr.width, 0, 1),
        y: clamp((r.top - pr.top) / pr.height, 0, 1),
        w: clamp(r.width / pr.width, 0, 1),
        h: clamp(r.height / pr.height, 0, 1),
      })
    }
    const first = range.getClientRects()[0]
    if (!first) return
    const n = Number(pageEl.dataset.n) || this.#page
    this.dispatchEvent(new CustomEvent('selection', {
      detail: {
        text,
        cfi: 'pdf:' + n,
        page: n,
        rects,
        x: first.left + first.width / 2,
        y: first.top,
        bottom: first.bottom,
      },
    }))
  }
}
