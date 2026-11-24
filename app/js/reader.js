/**
 * 阅读引擎封装：基于 foliate-js（EPUB / MOBI / AZW3(KF8) / FB2 / CBZ）
 */
import '../lib/view.js'
import { Overlayer } from '../lib/overlayer.js'

const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

export const FONT_STACKS = {
  system: `"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif`,
}

/** 根据排版设置生成注入到书籍 iframe 的 CSS */
export function buildBookCSS (s) {
  const bg = s.bg
  const fg = s.fg
  const fontFamily = s.fontFamily === 'custom'
    ? (s.customFont || FONT_STACKS.system)
    : (s.fontFamily === 'system' ? FONT_STACKS.system : s.fontFamily)
  const indent = Number(s.textIndent) > 0 ? `${s.textIndent}em` : '0'
  const para = Number(s.paragraphSpacing) || 0
  const align = s.justify ? 'justify' : 'start'
  const dim = s.theme === 'night' || s.theme === 'gray'
  // 滚动模式下没有页眉页脚，需要自己留出上下呼吸空间
  const bodyPad = s.flow === 'scrolled' ? '18px 0 64px' : '0'
  return `
    @namespace epub "http://www.idpf.org/2007/ops";

    html, body {
      background: ${bg} !important;
      color: ${fg} !important;
    }
    body {
      font-family: ${fontFamily} !important;
      font-size: ${s.fontSize}px !important;
      font-weight: ${s.fontWeight} !important;
      line-height: ${s.lineHeight} !important;
      letter-spacing: ${s.letterSpacing}px !important;
      text-align: ${align};
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      padding: ${bodyPad} !important;
      margin: 0 !important;
      overflow-wrap: break-word;
      word-break: normal;
    }
    p, div, li, dd, dt, blockquote, td, th, span, section, article {
      color: ${fg};
      font-family: inherit !important;
      letter-spacing: inherit;
    }
    p, li, blockquote, dd, figcaption {
      line-height: ${s.lineHeight} !important;
      text-align: ${align};
      -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
      hyphens: ${s.hyphenate ? 'auto' : 'manual'};
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      -webkit-hyphenate-limit-lines: 2;
      hanging-punctuation: allow-end last;
      widows: 2;
      orphans: 2;
      margin: 0 !important;
    }
    p {
      text-indent: ${indent} !important;
      margin-block: 0 !important;
    }
    /* 段落之间留白（缩进为 0 时更自然） */
    p + p { margin-top: ${para}em !important; }
    /* 保留书里自带的居中/右对齐 */
    [align="left"] { text-align: left !important; }
    [align="right"] { text-align: right !important; }
    [align="center"] { text-align: center !important; }
    [align="justify"] { text-align: justify !important; }
    p[style*="text-align:center"], p[style*="text-align: center"] { text-indent: 0 !important; }
    h1, h2, h3, h4, h5, h6 {
      color: ${fg} !important;
      line-height: 1.35 !important;
      font-family: inherit !important;
      text-indent: 0 !important;
      margin: 1.1em 0 .7em !important;
      text-align: center;
      page-break-after: avoid;
      break-after: avoid;
    }
    h1 { font-size: 1.5em !important; }
    h2 { font-size: 1.28em !important; }
    h3 { font-size: 1.12em !important; }
    hr { border: 0; border-top: 1px solid ${fg}22; margin: 1.2em 0; }
    a, a:link, a:visited { color: ${s.link || '#9c6b3c'} !important; text-decoration: none; }
    img, svg, video { max-width: 100% !important; height: auto !important; ${dim ? 'filter: brightness(.86) contrast(.96);' : ''} }
    figure { margin: 1em 0 !important; text-align: center; }
    pre { white-space: pre-wrap !important; color: ${fg} !important; font-size: .92em; }
    code, kbd, samp { font-family: ui-monospace, Consolas, monospace !important; }
    table { border-color: ${fg}44 !important; max-width: 100% !important; }
    td, th { border-color: ${fg}33 !important; padding: 4px 7px; }
    ::selection { background: ${s.selection || 'rgba(240,180,99,.45)'}; color: inherit; }
    /* 书本自带的底色块（常见于封面页/引用块）会和主题冲突，统一去掉 */
    body :where(div, section, article, p, span, li, ul, ol, td, th, tr, table,
      h1, h2, h3, h4, h5, h6, blockquote, figure, header, footer, main) {
      background-color: transparent !important;
    }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"],
    aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `
}

export class BookReader extends EventTarget {
  #view = null
  #host
  #annotations = new Map()     // cfi -> {id, value, color, note}
  #lastLocation = null
  #selectionHandler = null
  #gotoTimer = null
  #reflowTimer = null
  #headText = ''

  constructor (host) {
    super()
    this.#host = host
  }

  get view () { return this.#view }
  get book () { return this.#view?.book }
  get location () { return this.#lastLocation }
  get renderer () { return this.#view?.renderer }

  get pageInfo () {
    const r = this.#view?.renderer
    if (!r) return { page: 0, pages: 0 }
    try { return { page: (r.page ?? 0) + 1, pages: r.pages ?? 0 } } catch { return { page: 0, pages: 0 } }
  }

  async open ({ url, name, cfi, settings, stageWidth, stageHeight, annotations }) {
    this.close()
    const res = await fetch(url)
    if (!res.ok) throw new Error('无法读取文件（' + res.status + '）')
    const blob = await res.blob()
    const file = new File([blob], name || 'book.epub')

    const view = document.createElement('foliate-view')
    this.#view = view
    view.style.cssText = 'display:block;width:100%;height:100%'
    this.#host.append(view)

    view.addEventListener('relocate', (e) => {
      this.#lastLocation = e.detail
      this.#updateMarginals()
      this.dispatchEvent(new CustomEvent('relocate', { detail: e.detail }))
    })
    view.addEventListener('load', (e) => {
      const { doc, index } = e.detail
      this.#attachDoc(doc, index)
      this.dispatchEvent(new CustomEvent('load', { detail: e.detail }))
      this.scheduleReflow(120)
    })
    view.addEventListener('create-overlay', (e) => {
      const { index } = e.detail
      for (const a of this.#annotations.values()) {
        if (a.index === index || a.index === undefined) view.addAnnotation(a).catch(() => {})
      }
    })
    view.addEventListener('draw-annotation', (e) => {
      const { draw, annotation } = e.detail
      draw(Overlayer.highlight, { color: annotation.color })
    })
    view.addEventListener('show-annotation', (e) => {
      this.dispatchEvent(new CustomEvent('annotation-click', { detail: e.detail }))
    })
    view.addEventListener('external-link', (e) => {
      e.preventDefault()
      this.dispatchEvent(new CustomEvent('external-link', { detail: e.detail }))
      return false
    })

    await view.open(file)

    // 先把划线塞进去，避免首次加载时漏画
    if (annotations?.length) this.setAnnotations(annotations)

    // 排版参数必须在首次定位之前设置，否则会闪一下默认样式
    if (settings) {
      this.applyLayout(settings, stageWidth, stageHeight)
      this.applyStyle(settings)
    }

    // 定位
    let placed = false
    if (cfi) {
      try {
        await view.init({ lastLocation: cfi })
        placed = true
      } catch (err) {
        console.warn('恢复阅读位置失败，从头开始', err)
      }
    }
    if (!placed) {
      try { await view.init({ showTextStart: true }) } catch {
        await view.goTo(0)
      }
    }
    this.#updateMarginals()
    // 首次排版时容器可能还没被撑开，等一帧后再按真实高度重排一次
    this.scheduleReflow()
    return this.#view.book
  }

  /** 容器尺寸稳定后重新分栏（解决“正文只占半页、上下留白巨大”的问题） */
  scheduleReflow (delay = 90) {
    clearTimeout(this.#reflowTimer)
    this.#reflowTimer = setTimeout(() => {
      const r = this.#view?.renderer
      if (!r) return
      try {
        r.render()
        this.#updateMarginals()
        this.setMarginalHead(this.#headText)
      } catch (err) { console.warn('reflow failed', err) }
    }, delay)
  }

  close () {
    if (!this.#view) return
    try { this.#view.close() } catch { /* ignore */ }
    try { this.#view.remove() } catch { /* ignore */ }
    this.#view = null
    this.#lastLocation = null
    this.#annotations.clear()
  }

  // ---------------------------------------------------------------- 排版
  applyStyle (settings) {
    const css = buildBookCSS(settings)
    try { this.#view?.renderer?.setStyles?.(css) } catch (e) { console.warn(e) }
    this.#updateMarginals()
  }

  applyLayout (settings, stageWidth, stageHeight) {
    const r = this.#view?.renderer
    if (!r) return
    const paginated = settings.flow !== 'scrolled'
    r.setAttribute('flow', paginated ? 'paginated' : 'scrolled')
    r.setAttribute('gap', '8%')
    const footer = settings.showMarginal && paginated ? 44 : 0
    r.setAttribute('margin', String(footer))

    // 文字栏宽度 = 可视宽度 - 两侧边距
    const margin = clamp(Number(settings.margin) || 0, 0, 200)
    const maxInline = Math.max(280, Math.round((stageWidth || 800) - margin * 2))
    r.setAttribute('max-inline-size', `${maxInline}px`)
    // 关键：分页高度必须给出确定值，否则内容会按“文字多少”自适应，
    // 导致正文只占上半页、上下大片留白
    if (stageHeight > 0) {
      const maxBlock = Math.max(200, Math.round(stageHeight - footer * 2))
      r.setAttribute('max-block-size', `${maxBlock}px`)
    }
    if (paginated) r.setAttribute('max-column-count', String(settings.columns || 1))
    else r.removeAttribute('max-column-count')

    this.#updateMarginals()
    this.scheduleReflow(140)
  }

  #updateMarginals () {
    const r = this.#view?.renderer
    if (!r || !this.#lastLocation) return
    const { tocItem } = this.#lastLocation
    const label = tocItem?.label || ''
    if (label) this.#headText = label
    const heads = r.heads
    const feet = r.feet
    if (heads?.length) for (const h of heads) h.textContent = label
    if (feet?.length) {
      const { page, pages } = this.pageInfo
      const text = pages ? `${page} / ${pages}` : ''
      for (const f of feet) f.textContent = text
    }
  }

  /** 手动设置页眉文字（重排后引擎会重建页眉元素，需要重新写入） */
  setMarginalHead (text) {
    this.#headText = text || ''
    const r = this.#view?.renderer
    if (!r?.heads?.length) return
    for (const h of r.heads) h.textContent = this.#headText
  }

  // ---------------------------------------------------------------- 导航
  async goTo (target) {
    if (!this.#view) return
    await this.#view.goTo(target)
  }
  async goToFraction (f) {
    if (!this.#view) return
    await this.#view.goToFraction(clamp(Number(f) || 0, 0, 1))
  }
  async next () { await this.#view?.next() }
  async prev () { await this.#view?.prev() }
  goLeft () { return this.book?.dir === 'rtl' ? this.next() : this.prev() }
  goRight () { return this.book?.dir === 'rtl' ? this.prev() : this.next() }

  // ---------------------------------------------------------------- 标注
  setAnnotations (list) {
    this.#annotations.clear()
    for (const a of list || []) this.#annotations.set(a.value, a)
  }

  async addAnnotation (a) {
    this.#annotations.set(a.value, a)
    await this.#view?.addAnnotation(a)
  }

  async removeAnnotation (a) {
    this.#annotations.delete(a.value)
    await this.#view?.deleteAnnotation(a)
  }

  clearSearchMarks () {
    try { this.#view?.clearSearch() } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- 选区
  #attachDoc (doc, index) {
    if (this.#selectionHandler) doc.removeEventListener('mouseup', this.#selectionHandler)
    const handler = () => {
      setTimeout(() => {
        const sel = doc.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          this.dispatchEvent(new CustomEvent('selection-clear'))
          return
        }
        const text = sel.toString().trim()
        if (!text) {
          this.dispatchEvent(new CustomEvent('selection-clear'))
          return
        }
        const range = sel.getRangeAt(0)
        let cfi = ''
        try { cfi = this.#view.getCFI(index, range) } catch { /* ignore */ }
        const rects = range.getClientRects()
        const rect = rects[rects.length - 1] || range.getBoundingClientRect()
        let frameRect = { left: 0, top: 0 }
        try {
          const fr = doc.defaultView.frameElement.getBoundingClientRect()
          frameRect = { left: fr.left, top: fr.top }
        } catch { /* ignore */ }
        this.dispatchEvent(new CustomEvent('selection', {
          detail: {
            text, cfi, index,
            x: frameRect.left + rect.left + rect.width / 2,
            y: frameRect.top + rect.top,
            bottom: frameRect.top + rect.bottom,
          },
        }))
      }, 10)
    }
    doc.addEventListener('mouseup', handler)
    this.#selectionHandler = handler
  }

  // ---------------------------------------------------------------- 搜索
  async * search (query) {
    if (!this.#view) return
    const gen = this.#view.search({ query })
    for await (const item of gen) yield item
  }
}
