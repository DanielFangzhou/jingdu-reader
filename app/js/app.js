import { $, $$, uid, clamp, debounce, escapeHtml, fmtBytes, fmtDate, fmtDateTime, fmtDuration, langText, toast, dialog, confirmDialog, contextMenu, hideContextMenu } from './util.js'
import { BookReader } from './reader.js'
import { PdfReader, pdfMetaAndCover } from './pdfview.js'
import { txtToEpub } from './txt.js'
import { makeBook } from '../lib/view.js'

// ============================================================ 常量
const THEMES = {
  paper: { bg: '#fdfcf8', fg: '#33302b' },
  sepia: { bg: '#f6f1e6', fg: '#4a4132' },
  green: { bg: '#dbe7d5', fg: '#33452f' },
  night: { bg: '#16181a', fg: '#cfd4d8' },
  gray: { bg: '#38393b', fg: '#d9dbdd' },
}

const DEFAULT_SETTINGS = {
  theme: 'sepia',
  bg: THEMES.sepia.bg,
  fg: THEMES.sepia.fg,
  fontFamily: 'system',
  customFont: '',
  fontSize: 19,
  fontWeight: 400,
  lineHeight: 1.75,
  paragraphSpacing: 0.6,
  textIndent: 2,
  letterSpacing: 0,
  margin: 48,
  justify: true,
  hyphenate: false,
  flow: 'paginated',
  columns: 1,
  showMarginal: true,
  clickTurn: true,
  alwaysOnTop: false,
  quitOnClose: false,
  autoHideSeconds: 0,
  autoResume: true,
  hotkey: 'CommandOrControl+Alt+B',
  shelfSort: 'recent',
  sidebarOpen: true,
  lastBookId: '',
}

const SUPPORTED = ['epub', 'mobi', 'azw3', 'azw', 'prc', 'txt', 'fb2', 'fbz', 'cbz', 'pdf']
const FORMAT_LABEL = { epub: 'EPUB', mobi: 'MOBI', azw3: 'AZW3', azw: 'AZW', prc: 'PRC', txt: 'TXT', fb2: 'FB2', fbz: 'FB2', cbz: 'CBZ', pdf: 'PDF' }

const HIGHLIGHT_COLORS = ['#f5d76e', '#a8d8b9', '#9ec7e8', '#f2a7a0']

// ============================================================ 状态
const S = {
  info: null,
  settings: { ...DEFAULT_SETTINGS },
  books: [],
  current: null,
  reader: null,
  pane: 'toc',
  saveTimer: null,
  progressSaving: false,
  draggingSlider: false,
  pendingSelection: null,
  lastMouse: { x: 0, y: 0 },
  sessionSeconds: 0,
  searchToken: 0,
  searching: false,
}

const isDarkUI = () => S.settings.theme === 'night' || S.settings.theme === 'gray'

// ============================================================ 启动
init().catch((e) => {
  console.error(e)
  toast('初始化失败：' + e.message, 4000)
})

async function init () {
  S.info = await window.desktop.info()
  const savedSettings = await window.desktop.settings.load()
  S.settings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) }
  const lib = await window.desktop.library.load()
  S.books = Array.isArray(lib?.books) ? lib.books : []

  bindChrome()
  bindShelf()
  bindReaderChrome()
  bindStylePanel()
  bindKeyboard()
  bindDrops()
  bindStealth()

  applyUiTheme()
  syncStylePanel()
  renderShelf()

  const about = $('#about-line')
  if (about) about.textContent = `静读 v${S.info.version} · 本地离线 · 书籍与进度保存在 ${S.info.dataDir}`

  // 自动续读上次的书
  const last = S.books.find(b => b.id === S.settings.lastBookId)
  if (S.settings.autoResume && last && last.progress?.at) {
    setTimeout(() => openBook(last, { silent: true }).catch(() => {}), 220)
  }

  setInterval(tickReadingTime, 20000)
}

// ============================================================ 窗口外壳
function bindChrome () {
  $('#btn-min').onclick = () => window.desktop.win.minimizeToTray()
  $('#btn-close').onclick = () => window.desktop.win.hide()
  $('#btn-max').onclick = async () => { await window.desktop.win.toggleMaximize() }
  $('#btn-top').onclick = async () => {
    const on = !S.settings.alwaysOnTop
    await setSettings({ alwaysOnTop: on })
    window.desktop.win.setAlwaysOnTop(on)
    $('#btn-top').classList.toggle('on', on)
    toast(on ? '窗口已置顶' : '已取消置顶')
  }
  // 双击标题栏最大化
  const tb = $('#titlebar')
  tb.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select')) return
    window.desktop.win.toggleMaximize()
  })
  $('#btn-top').classList.toggle('on', !!S.settings.alwaysOnTop)
  if (S.settings.alwaysOnTop) window.desktop.win.setAlwaysOnTop(true)
  $('#btn-data-dir').onclick = () => window.desktop.fs.reveal('')

  window.addEventListener('beforeunload', () => { flushLibraryNow() })
}

// ============================================================ 设置
async function setSettings (patch, { rerender = false } = {}) {
  S.settings = { ...S.settings, ...patch }
  window.desktop.settings.save(patch).catch(() => {})
  applyUiTheme()
  if (rerender) renderShelf()
  if (S.current && S.reader) {
    S.reader.applyStyle(S.settings)
    S.reader.applyLayout(S.settings, $('#stage').clientWidth, $('#stage').clientHeight)
  }
}

function applyUiTheme () {
  document.documentElement.classList.toggle('ui-dark', isDarkUI())
  document.documentElement.style.setProperty('--paper', S.settings.bg)
  const stage = $('#stage')
  if (stage) stage.style.background = S.settings.bg
}

// ============================================================ 书架
function bindShelf () {
  $('#btn-import').onclick = () => pickBooks()
  $('#file-input').onchange = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) importFiles(files)
  }
  $('#shelf-search').oninput = debounce(() => renderShelf(), 160)
  $('#shelf-sort').onchange = (e) => {
    setSettings({ shelfSort: e.target.value })
    renderShelf()
  }
  $('#shelf-sort').value = S.settings.shelfSort
}

async function pickBooks () {
  const paths = await window.desktop.books.pick()
  if (!paths.length) return
  importPaths(paths)
}

function sortedBooks () {
  const q = ($('#shelf-search')?.value || '').trim().toLowerCase()
  let list = S.books.slice()
  if (q) list = list.filter(b => (b.title || '').toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q))
  const sort = S.settings.shelfSort
  const cmp = {
    recent: (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || (b.addedAt || 0) - (a.addedAt || 0),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'),
    author: (a, b) => String(a.author || '').localeCompare(String(b.author || ''), 'zh-Hans-CN'),
  }[sort] || ((a, b) => 0)
  return list.sort(cmp)
}

function renderShelf () {
  const grid = $('#book-grid')
  const list = sortedBooks()
  const total = S.books.length
  $('#shelf-count').textContent = total ? `${total} 本` : ''
  $('#shelf-empty').classList.toggle('hidden', total > 0)
  grid.innerHTML = ''

  for (const b of list) {
    const cover = b.cover
      ? `<img src="${escapeHtml(b.cover)}" alt="" loading="lazy" onerror="this.remove()" />`
      : `<div class="fallback"><div class="ft">${escapeHtml(b.title || '未命名')}</div><div class="fa">${escapeHtml(b.author || '')}</div></div>`
    const pct = Math.round((b.progress?.fraction || 0) * 100)
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.id = b.id
    card.innerHTML = `
      <div class="cover">
        ${cover}
        <span class="fmt">${b.fromTxt ? 'TXT' : (FORMAT_LABEL[b.format] || (b.format || '').toUpperCase())}</span>
        ${pct > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <button class="more" title="更多"><svg class="i i-sm"><use href="#i-more"/></svg></button>
      <div class="info">
        <div class="name">${escapeHtml(b.title || '未命名')}</div>
        <div class="meta">
          <span>${escapeHtml(b.author || '未知作者')}</span>
          ${pct > 0 ? `<span class="dot"></span><span class="reading">${pct}%</span>` : ''}
        </div>
      </div>`
    card.addEventListener('click', (e) => {
      if (e.target.closest('.more')) return
      openBook(b)
    })
    card.querySelector('.more').addEventListener('click', (e) => {
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      contextMenu(r.left - 150, r.bottom + 4, [
        { label: b.progress?.at ? '继续阅读' : '开始阅读', icon: '#i-book', action: () => openBook(b) },
        { label: '从头开始', icon: '#i-refresh', action: () => openBook(b, { restart: true }) },
        { label: '查看文件位置', icon: '#i-folder', action: () => window.desktop.fs.reveal(b.rel) },
        { label: '修改书名…', icon: '#i-note', action: () => renameBook(b) },
        { sep: true },
        { label: '移出书架', icon: '#i-trash', danger: true, action: () => removeBook(b) },
      ])
    })
    grid.append(card)
  }

  // 底部统计
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todaySec = S.books.reduce((a, b) => a + (b.lastReadAt >= today.getTime() ? (b.todaySeconds || 0) : 0), 0)
  $('#foot-count').textContent = total ? `共 ${total} 本` : '还没有书'
  $('#foot-today').textContent = todaySec > 0 ? `今日已读 ${fmtDuration(todaySec)}` : ''
  $('#foot-data').textContent = '数据目录：user-data'
}

async function renameBook (b) {
  const v = await dialog({
    title: '修改书名',
    input: { value: b.title || '', placeholder: '输入书名' },
    okText: '保存',
  })
  if (v === null) return
  const title = String(v).trim()
  if (!title) return
  b.title = title
  saveLibrary()
  renderShelf()
  if (S.current?.id === b.id) $('#book-title').textContent = title
}

async function removeBook (b) {
  const ok = await confirmDialog('移出书架', `确定把《${b.title}》移出书架吗？\n已复制的书籍文件和阅读记录将一并删除。`, '移出')
  if (!ok) return
  S.books = S.books.filter(x => x.id !== b.id)
  if (b.rel) await window.desktop.books.removeFile(b.rel).catch(() => {})
  if (b.coverRel) await window.desktop.books.removeFile(b.coverRel).catch(() => {})
  if (S.current?.id === b.id) { S.current = null; showShelf() }
  saveLibraryNow()
  renderShelf()
  toast('已移出书架')
}

// ============================================================ 导入
function bindDrops () {
  const veil = $('#drop-veil')
  let depth = 0
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    depth++
    veil.classList.add('show')
  })
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (!depth) veil.classList.remove('show')
  })
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    depth = 0
    veil.classList.remove('show')
    const items = Array.from(e.dataTransfer.items || [])
    const files = []
    for (const it of items) {
      if (it.kind !== 'file') continue
      const entry = it.webkitGetAsEntry?.()
      if (entry?.isDirectory) await collectDir(entry, files)
      else {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) importFiles(files)
  })
}

async function collectDir (entry, out) {
  const reader = entry.createReader()
  const read = () => new Promise((res) => reader.readEntries(res, () => res([])))
  let batch
  do {
    batch = await read()
    for (const e of batch) {
      if (e.isDirectory) await collectDir(e, out)
      else {
        const f = await new Promise((res) => e.file(res, () => res(null)))
        if (f) out.push(f)
      }
    }
  } while (batch.length)
}

const extOf = (name) => String(name || '').split('.').pop().toLowerCase()

async function importPaths (paths) {
  const files = []
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop()
    const ext = extOf(name)
    if (!SUPPORTED.includes(ext)) continue
    files.push({ path: p, name, ext })
  }
  if (!files.length) return toast('没有找到支持的电子书格式')
  await importBatch(files)
}

async function importFiles (fileList) {
  const files = []
  for (const f of fileList) {
    const ext = extOf(f.name)
    if (!SUPPORTED.includes(ext)) continue
    const p = window.desktop.pathForFile(f)
    files.push({ path: p, file: f, name: f.name, ext })
  }
  if (!files.length) return toast('没有找到支持的电子书格式（epub / mobi / azw3 / txt / fb2 / cbz）')
  await importBatch(files)
}

async function importBatch (files) {
  let done = 0
  const failed = []
  for (const item of files) {
    done++
    toast(`正在导入 ${done}/${files.length}：${item.name}`, 4000)
    try {
      await importOne(item)
    } catch (err) {
      console.error('导入失败', item.name, err)
      failed.push(item.name)
    }
    await new Promise(r => setTimeout(r, 10))
  }
  saveLibraryNow()
  renderShelf()
  if (failed.length) toast(`完成，${failed.length} 个文件失败：${failed.slice(0, 2).join('、')}${failed.length > 2 ? '…' : ''}`, 4200)
  else toast(files.length > 1 ? `已导入 ${files.length} 本书` : '导入完成')
}

async function importOne ({ path, file, name, ext }) {
  // 1) 读取原始字节（TXT 需要转换，其余直接入库）
  const readBytes = async () => {
    if (file) return new Uint8Array(await file.arrayBuffer())
    return await window.desktop.fs.read(path)
  }

  let rec
  if (ext === 'txt') {
    const bytes = await readBytes()
    const { epub, title, author } = await txtToEpub(bytes, name)
    const id = uid()
    const written = await window.desktop.books.writeVariant(id, 'epub', epub)
    rec = { id, rel: written.rel, url: written.url, size: written.size, format: 'epub', title, author, fromTxt: true }
  } else {
    // 主进程复制（有路径时），否则用字节写入
    if (path) {
      const r = await window.desktop.books.import(path, ext)
      rec = { id: r.id, rel: r.rel, url: r.url, size: r.size, format: ext, title: null, author: '' }
    } else {
      const bytes = await readBytes()
      const id = uid()
      const written = await window.desktop.books.writeVariant(id, ext, bytes)
      rec = { id, rel: written.rel, url: written.url, size: written.size, format: ext, title: null, author: '' }
    }
  }

  // 2) 解析元数据与封面
  let metaTitle = ''
  let metaAuthor = ''
  let coverRel = null
  let tocCount = 0
  if (ext === 'pdf') {
    // PDF 用 pdf.js 取元数据与首页封面
    try {
      const { title, author, cover, pages } = await pdfMetaAndCover(rec.url)
      metaTitle = title
      metaAuthor = author
      tocCount = pages
      if (cover) {
        const buf = new Uint8Array(await cover.arrayBuffer())
        const saved = await window.desktop.books.saveCover(rec.id, 'image/jpeg', buf)
        coverRel = saved.rel
      }
    } catch (err) {
      console.warn('PDF 元数据解析失败（不影响阅读）', err)
    }
  } else {
    try {
      const blobUrl = rec.url
      const res = await fetch(blobUrl)
      const blob = await res.blob()
      const f = new File([blob], name.replace(/\.txt$/i, '.epub'))
      const book = await makeBook(f)
      const meta = book.metadata || {}
      metaTitle = langText(meta.title)
      metaAuthor = langText(meta.author) || langText(meta.creator)
      tocCount = countTOC(book.toc)
      const cover = await Promise.resolve(book.getCover?.()).catch(() => null)
      if (cover) {
        const buf = new Uint8Array(await cover.arrayBuffer())
        const saved = await window.desktop.books.saveCover(rec.id, cover.type || 'image/jpeg', buf)
        coverRel = saved.rel
      }
    } catch (err) {
      console.warn('元数据解析失败（不影响阅读）', err)
    }
  }

  const title = (rec.title || metaTitle || name.replace(/\.[^.]+$/, '')).trim()
  const author = (rec.author || metaAuthor || '').trim()

  if (!coverRel) {
    try {
      const png = await makeTypographicCover(title, author)
      const saved = await window.desktop.books.saveCover(rec.id, 'image/png', png)
      coverRel = saved.rel
    } catch (e) { console.warn(e) }
  }

  const record = {
    id: rec.id,
    title,
    author,
    format: rec.format,
    rel: rec.rel,
    size: rec.size,
    cover: coverRel ? 'book://local/' + coverRel : '',
    coverRel,
    addedAt: Date.now(),
    lastReadAt: 0,
    tocCount,
    seconds: 0,
    progress: {},
    bookmarks: [],
    highlights: [],
    fromTxt: !!rec.fromTxt,
  }
  S.books.unshift(record)
}

function countTOC (toc) {
  if (!Array.isArray(toc)) return 0
  return toc.reduce((a, t) => a + 1 + countTOC(t.subitems), 0)
}

/** 没有封面时生成一张排印风格封面 */
async function makeTypographicCover (title, author) {
  const palettes = [
    ['#b98b5e', '#6d4a2d'], ['#5f7d6a', '#2f4a3c'], ['#7d6a9f', '#463a63'],
    ['#b06a5e', '#6d3a33'], ['#4f7189', '#2c4257'], ['#a3814f', '#6b5330'],
    ['#6d7b8a', '#39434f'],
  ]
  let h = 0
  for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 9973
  const [c1, c2] = palettes[h % palettes.length]
  const W = 600
  const H = 900
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, W * .8, H)
  g.addColorStop(0, c1); g.addColorStop(1, c2)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  // 纹理线条
  ctx.globalAlpha = .07
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1
  for (let i = 0; i < 40; i++) {
    ctx.beginPath()
    ctx.moveTo(0, (H / 40) * i)
    ctx.lineTo(W, (H / 40) * i + 18)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  // 边框
  ctx.strokeStyle = 'rgba(255,255,255,.42)'
  ctx.lineWidth = 2
  ctx.strokeRect(34, 34, W - 68, H - 68)
  // 书名
  const chars = Array.from(String(title || '未命名'))
  const perLine = chars.length > 12 ? 8 : chars.length > 6 ? 5 : 4
  const lines = []
  for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(''))
  const fs = Math.min(78, Math.floor((W - 150) / Math.min(perLine, 5)))
  ctx.fillStyle = 'rgba(255,250,240,.96)'
  ctx.font = `700 ${fs}px "Microsoft YaHei", "PingFang SC", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const startY = H / 2 - ((Math.min(lines.length, 8) - 1) * fs * 1.25) / 2 - 20
  lines.slice(0, 8).forEach((line, i) => ctx.fillText(line, W / 2, startY + i * fs * 1.25))
  // 作者
  if (author) {
    ctx.font = `400 26px "Microsoft YaHei", sans-serif`
    ctx.fillStyle = 'rgba(255,250,240,.72)'
    ctx.fillText(author.slice(0, 16), W / 2, H - 118)
  }
  ctx.font = `300 18px "Microsoft YaHei", sans-serif`
  ctx.fillStyle = 'rgba(255,250,240,.5)'
  ctx.fillText('静 读', W / 2, H - 70)

  const blob = await new Promise(res => cv.toBlob(res, 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

// ============================================================ 打开书籍
async function showShelf () {
  closeReader()
  $('#shelf').classList.remove('hidden')
  $('#reader').classList.add('hidden')
  $('#statusbar').classList.add('hidden')
  $('#book-title').textContent = '我的书架'
  $('#book-sub').textContent = ''
  $$('.reader-only').forEach(el => el.classList.add('hidden'))
  $('#btn-shelf').classList.add('hidden')
  $('#style-panel').classList.remove('open')
  renderShelf()
}

async function openBook (b, { restart = false, silent = false } = {}) {
  const exists = b.rel ? await window.desktop.books.exists(b.rel) : false
  if (!exists) {
    toast('书籍文件不存在，可能已被移动或删除', 3200)
    return
  }
  hideSelection()
  hideContextMenu()
  S.current = b
  S.pane = 'toc'

  $('#shelf').classList.add('hidden')
  $('#reader').classList.remove('hidden')
  $('#statusbar').classList.remove('hidden')
  $$('.reader-only').forEach(el => el.classList.remove('hidden'))
  $('#btn-shelf').classList.remove('hidden')
  $('#book-title').textContent = b.title || '未命名'
  $('#book-sub').textContent = b.author || ''
  $('#reader').classList.toggle('side-closed', !S.settings.sidebarOpen)
  $('#reader').classList.toggle('turn-zones', !!S.settings.clickTurn)
  $('#loading').classList.remove('hidden')
  $('#loading-text').textContent = '正在打开…'
  $('#pane-toc').innerHTML = ''
  $('#pane-marks').innerHTML = ''
  $('#pane-search').innerHTML = ''
  switchPane('toc', { keepReader: true })

  if (S.reader) { S.reader.close(); S.reader = null }
  const isPdf = String(b.format || '').toLowerCase() === 'pdf'
  const reader = isPdf ? new PdfReader($('#view-host')) : new BookReader($('#view-host'))
  S.reader = reader

  reader.addEventListener('relocate', (e) => onRelocate(e.detail))
  reader.addEventListener('zoom', (e) => {
    toast('缩放 ' + Math.round(e.detail.zoom * 100) + '%')
  })
  if (!isPdf) {
    reader.addEventListener('load', (e) => {
      const { doc } = e.detail
      doc.addEventListener('keydown', onKeyDown)
      doc.addEventListener('contextmenu', (ev) => { ev.preventDefault() })
      if (doc !== document) {
        doc.addEventListener('wheel', onWheelPaging, { passive: false })
        // 正文跑在 iframe 里，事件不会冒泡到顶层窗口，单独上报给自动隐藏计时
        const touchIdle = () => S.__idleTouch?.()
        doc.addEventListener('mousemove', touchIdle, { passive: true })
        doc.addEventListener('mousedown', touchIdle, true)
        doc.addEventListener('wheel', touchIdle, { passive: true })
        doc.addEventListener('scroll', touchIdle, { passive: true })
        doc.addEventListener('keydown', touchIdle, true)
      }
    })
  }
  reader.addEventListener('selection', (e) => showSelection(e.detail))
  reader.addEventListener('selection-clear', () => hideSelection())
  reader.addEventListener('annotation-click', (e) => onAnnotationClick(e.detail))
  reader.addEventListener('external-link', (e) => window.desktop.fs.openExternal(e.detail.href_))

  const cfi = restart ? null : (b.progress?.cfi || null)
  try {
    const book = await reader.open({
      url: 'book://local/' + b.rel,
      name: (b.title || 'book') + '.' + b.format,
      cfi,
      settings: S.settings,
      stageWidth: $('#stage').clientWidth,
      stageHeight: $('#stage').clientHeight,
      annotations: b.highlights || [],
    })
    reader.setAnnotations(b.highlights || [])
    b.format = b.format || (book ? 'epub' : b.format)
    if (!b.tocCount) b.tocCount = countTOC(book?.toc)
    renderTOC(book?.toc || [])
    renderMarks()
    renderInfo()
    $('#loading').classList.add('hidden')
    if (!silent) { /* no-op */ }
    // 记录打开
    b.lastReadAt = Date.now()
    b.openedCount = (b.openedCount || 0) + 1
    setSettings({ lastBookId: b.id })
    saveLibrary()
    updateStatusbar()
  } catch (err) {
    console.error(err)
    $('#loading').classList.add('hidden')
    toast('打开失败：' + (err?.message || err), 4000)
  }
}

function closeReader () {
  if (S.reader) { S.reader.close(); S.reader = null }
  S.current = null
  $('#view-host').innerHTML = ''
}

// ============================================================ 阅读界面事件
function bindReaderChrome () {
  $('#btn-shelf').onclick = () => showShelf()
  $('#btn-toc').onclick = () => { toggleSidebar('toc') }
  $('#btn-mark').onclick = () => { toggleSidebar('marks') }
  $('#btn-search').onclick = () => { toggleSidebar('search') }
  $('#btn-style').onclick = () => { $('#style-panel').classList.toggle('open'); syncStylePanel() }
  $('#sp-close').onclick = () => $('#style-panel').classList.remove('open')

  $$('.side-tabs button').forEach(btn => {
    btn.onclick = () => switchPane(btn.dataset.pane)
  })
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(e.target.value) }
    e.stopPropagation()
  })

  $('#progress').addEventListener('input', (e) => {
    if (!S.reader) return
    S.draggingSlider = true
    const f = parseFloat(e.target.value)
    $('#st-percent').textContent = Math.round(f * 100) + '%'
    clearTimeout(S.sliderTimer)
    S.sliderTimer = setTimeout(() => {
      S.reader.goToFraction(f).finally(() => { S.draggingSlider = false })
    }, 40)
  })
  $('#progress').addEventListener('change', () => { S.draggingSlider = false })

  $('#turn-left').onclick = () => S.reader?.goLeft()
  $('#turn-right').onclick = () => S.reader?.goRight()

  window.addEventListener('resize', debounce(() => {
    if (S.reader && S.current) S.reader.applyLayout(S.settings, $('#stage').clientWidth, $('#stage').clientHeight)
  }, 260))
}

function toggleSidebar (pane) {
  const r = $('#reader')
  if (!r.classList.contains('side-closed') && S.pane === pane) {
    r.classList.add('side-closed')
    setSettings({ sidebarOpen: false })
    if (pane === 'search') stopSearch()
    return
  }
  r.classList.remove('side-closed')
  setSettings({ sidebarOpen: true })
  switchPane(pane)
}

function switchPane (pane, { keepReader = false } = {}) {
  S.pane = pane
  $$('.side-tabs button').forEach(b => b.classList.toggle('on', b.dataset.pane === pane))
  const map = { toc: '#pane-toc', marks: '#pane-marks', search: '#pane-search', info: '#pane-info' }
  Object.entries(map).forEach(([k, sel]) => $(sel).classList.toggle('hidden', k !== pane))
  $('#side-search-tools').classList.toggle('hidden', pane !== 'search')
  if (pane !== 'search' && !keepReader) stopSearch()
  if (pane === 'search') setTimeout(() => $('#search-input')?.focus(), 60)
  if (pane === 'marks') renderMarks()
  if (pane === 'info') renderInfo()
}

// ============================================================ 目录
function renderTOC (toc) {
  const pane = $('#pane-toc')
  pane.innerHTML = ''
  if (!toc?.length) {
    pane.innerHTML = '<div class="pane center" style="height:120px">这本书没有目录</div>'
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'toc-wrap'
  const build = (items, depth) => {
    const frag = document.createDocumentFragment()
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'toc-item'
      row.dataset.href = item.href || ''
      row.dataset.label = item.label || ''
      row.style.paddingLeft = (8 + depth * 13) + 'px'
      const hasKids = item.subitems?.length
      row.innerHTML = `
        <span class="caret ${hasKids ? '' : 'blank'}">${hasKids ? '<svg class="i i-sm"><use href="#i-chevron"/></svg>' : ''}</span>
        <span class="lbl">${escapeHtml(item.label || '未命名章节')}</span>`
      frag.append(row)
      let childBox = null
      if (hasKids) {
        childBox = document.createElement('div')
        childBox.className = 'toc-children collapsed'
        childBox.append(build(item.subitems, depth + 1))
        frag.append(childBox)
      }
      const caret = row.querySelector('.caret')
      if (hasKids) {
        caret.addEventListener('click', (e) => {
          e.stopPropagation()
          const open = childBox.classList.toggle('collapsed')
          caret.classList.toggle('open', !open)
        })
      }
      row.addEventListener('click', async () => {
        if (!item.href) return
        markActiveTOC(item.href)
        await S.reader?.goTo(item.href)
        if (S.settings.sidebarOpen === false) $('#reader').classList.add('side-closed')
      })
    }
    return frag
  }
  wrap.append(build(toc, 0))
  pane.append(wrap)
}

function markActiveTOC (href) {
  const pane = $('#pane-toc')
  $$('.toc-item', pane).forEach(el => el.classList.toggle('active', el.dataset.href === href))
  const active = $('.toc-item.active', pane)
  if (active) {
    // 展开所有父级
    let p = active.parentElement
    while (p && p !== pane) {
      if (p.classList.contains('toc-children')) {
        p.classList.remove('collapsed')
        const row = p.previousElementSibling
        row?.querySelector('.caret')?.classList.add('open')
      }
      p = p.parentElement
    }
    const paneRect = pane.getBoundingClientRect()
    const r = active.getBoundingClientRect()
    if (r.top < paneRect.top + 8 || r.bottom > paneRect.bottom - 8) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }
}

// ============================================================ 位置变化
function onRelocate (loc) {
  if (!S.current) return
  hideSelection()
  const chapter = loc.tocItem?.label || ''
  const percent = Math.round((loc.fraction || 0) * 100)
  S.current.progress = {
    cfi: loc.cfi,
    fraction: loc.fraction || 0,
    chapter,
    at: Date.now(),
  }
  $('#st-chapter').textContent = chapter || S.current.title || '—'
  S.reader?.setMarginalHead?.(chapter)
  $('#st-percent').textContent = percent + '%'
  if (!S.draggingSlider) $('#progress').value = String(loc.fraction || 0)
  const { page, pages } = S.reader.pageInfo
  $('#st-page').textContent = pages ? `${page}/${pages} 页` : ''
  const remainMin = loc.time?.total
  $('#st-clock').textContent = remainMin > 1 ? `剩余约 ${fmtDuration(remainMin * 60)}` : ''
  if (loc.tocItem?.href) markActiveTOC(loc.tocItem.href)
  saveLibrary()
  updateShelfCard(S.current)
}

function updateStatusbar () { }

function updateShelfCard (b) {
  const card = $(`.card[data-id="${b.id}"]`)
  if (!card) return
  const pct = Math.round((b.progress?.fraction || 0) * 100)
  const bar = card.querySelector('.cover .bar')
  if (pct > 0) {
    if (bar) bar.querySelector('i').style.width = pct + '%'
    else card.querySelector('.cover').insertAdjacentHTML('beforeend', `<div class="bar"><i style="width:${pct}%"></i></div>`)
    const meta = card.querySelector('.meta')
    if (!meta.querySelector('.reading')) {
      meta.insertAdjacentHTML('beforeend', `<span class="dot"></span><span class="reading">${pct}%</span>`)
    } else meta.querySelector('.reading').textContent = pct + '%'
  }
}

function tickReadingTime () {
  if (!S.current) return
  if (document.visibilityState !== 'visible') return
  S.current.seconds = (S.current.seconds || 0) + 20
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if ((S.current.lastReadAt || 0) >= today.getTime()) {
    S.current.todaySeconds = (S.current.todaySeconds || 0) + 20
  } else {
    S.current.todaySeconds = 20
  }
  saveLibrary()
}

// ============================================================ 书签 / 笔记
function renderMarks () {
  const pane = $('#pane-marks')
  if (!pane) return
  const b = S.current
  if (!b) { pane.innerHTML = ''; return }
  const marks = b.bookmarks || []
  const highlights = b.highlights || []
  pane.innerHTML = ''

  const head = document.createElement('div')
  head.style.cssText = 'display:flex;gap:8px;padding:4px 6px 10px'
  head.innerHTML = `
    <button class="btn" id="add-mark" style="flex:1;justify-content:center">
      <svg class="i i-sm"><use href="#i-bookmark"/></svg>在当前位置加书签
    </button>`
  head.querySelector('#add-mark').onclick = () => addBookmark()
  pane.append(head)

  const sec = (title, count) => {
    const d = document.createElement('div')
    d.className = 'sect-title'
    d.style.cssText = 'padding:8px 8px 4px;font-size:10.5px;letter-spacing:.1em'
    d.textContent = `${title}（${count}）`
    return d
  }

  pane.append(sec('书签', marks.length))
  if (!marks.length) {
    const e = document.createElement('div')
    e.style.cssText = 'padding:6px 10px 12px;color:var(--ui-muted);font-size:12px'
    e.textContent = '还没有书签。按 Ctrl+D 或选中文字后添加。'
    pane.append(e)
  }
  for (const m of marks) {
    const el = document.createElement('div')
    el.className = 'mark-item'
    el.innerHTML = `
      <div class="mtxt">${escapeHtml(m.text || m.chapter || '书签')}</div>
      <div class="mmeta"><span class="chap">${escapeHtml(m.chapter || '')}</span><span>${Math.round((m.percent || 0) * 100)}%</span><span>${fmtDate(m.at)}</span></div>
      <button class="mdel" title="删除书签"><svg class="i i-sm"><use href="#i-trash"/></svg></button>`
    el.onclick = (e) => {
      if (e.target.closest('.mdel')) return
      S.reader?.goTo(m.cfi)
    }
    el.querySelector('.mdel').onclick = async (e) => {
      e.stopPropagation()
      b.bookmarks = b.bookmarks.filter(x => x.id !== m.id)
      saveLibrary()
      renderMarks()
      toast('已删除书签')
    }
    pane.append(el)
  }

  pane.append(sec('划线与笔记', highlights.length))
  if (!highlights.length) {
    const e = document.createElement('div')
    e.style.cssText = 'padding:6px 10px 12px;color:var(--ui-muted);font-size:12px'
    e.textContent = '选中正文可以划线、写笔记。'
    pane.append(e)
  }
  for (const h of highlights) {
    const el = document.createElement('div')
    el.className = 'mark-item'
    el.innerHTML = `
      <div class="mtxt">${escapeHtml(h.text || '')}</div>
      ${h.note ? `<div class="mnote">${escapeHtml(h.note)}</div>` : ''}
      <div class="mmeta"><span class="swatch" style="background:${h.color}"></span><span class="chap">${escapeHtml(h.chapter || '')}</span><span>${fmtDate(h.at)}</span></div>
      <button class="mdel" title="删除"><svg class="i i-sm"><use href="#i-trash"/></svg></button>`
    el.onclick = (e) => {
      if (e.target.closest('.mdel')) return
      S.reader?.goTo(h.value)
    }
    el.querySelector('.mdel').onclick = async (e) => {
      e.stopPropagation()
      await removeHighlight(h)
    }
    pane.append(el)
  }
}

function addBookmark () {
  const b = S.current
  const loc = S.reader?.location
  if (!b || !loc?.cfi) return toast('当前位置无法加书签')
  const chapter = loc.tocItem?.label || ''
  let snippet = (loc.range?.toString?.() || '').replace(/\s+/g, ' ').trim()
  // 位置往往从章节标题开始，去掉重复的章节名
  if (chapter && snippet.startsWith(chapter)) snippet = snippet.slice(chapter.length).trim()
  snippet = snippet.slice(0, 60)
  if (!snippet && isPdfBook()) snippet = `第 ${loc.page || S.reader?.pageInfo?.page || 1} 页`
  const mark = {
    id: uid(),
    cfi: loc.cfi,
    chapter: chapter || (isPdfBook() ? `第 ${loc.page || 1} 页` : ''),
    text: snippet || chapter || '书签',
    percent: loc.fraction || 0,
    at: Date.now(),
  }
  b.bookmarks = b.bookmarks || []
  b.bookmarks.push(mark)
  saveLibrary()
  if (S.pane === 'marks') renderMarks()
  toast('已添加书签')
}

// ============================================================ 划线 / 笔记
function bindSelectionToolbar () {
  const bar = $('#sel-toolbar')
  $$('.hb', bar).forEach(btn => {
    btn.onclick = () => { addHighlight(btn.dataset.color); }
  })
  $$('button.act', bar).forEach(btn => {
    btn.onclick = async () => {
      const act = btn.dataset.act
      const sel = S.pendingSelection
      if (!sel) return
      if (act === 'copy') {
        await navigator.clipboard.writeText(sel.text)
        toast('已复制')
        hideSelection()
      } else if (act === 'note') {
        const note = await dialog({
          title: '添加笔记',
          text: sel.text.slice(0, 160),
          input: { value: '', placeholder: '写下你的想法…', multiline: true },
          okText: '保存',
        })
        if (note === null) return
        await addHighlight(HIGHLIGHT_COLORS[0], String(note))
      } else if (act === 'bookmark') {
        addBookmark()
        hideSelection()
      }
    }
  })
}

function showSelection (detail) {
  S.pendingSelection = detail
  const bar = $('#sel-toolbar')
  bar.classList.add('show')
  const rect = bar.getBoundingClientRect()
  let x = clamp(detail.x - rect.width / 2, 8, window.innerWidth - rect.width - 8)
  let y = detail.y - rect.height - 10
  if (y < 46) y = detail.bottom + 14
  y = clamp(y, 46, window.innerHeight - rect.height - 8)
  bar.style.left = x + 'px'
  bar.style.top = y + 'px'
}

function hideSelection () {
  S.pendingSelection = null
  $('#sel-toolbar')?.classList.remove('show')
}

async function addHighlight (color, note = '') {
  const sel = S.pendingSelection
  const b = S.current
  if (!sel || !b || !sel.cfi) { hideSelection(); return }
  const h = {
    id: uid(),
    value: sel.cfi,
    color,
    note,
    text: sel.text.slice(0, 300),
    chapter: S.reader?.location?.tocItem?.label || '',
    at: Date.now(),
  }
  // PDF 是固定版式，用页面内的相对矩形还原划线位置
  if (sel.rects?.length) {
    h.rects = sel.rects
    h.page = sel.page
  }
  b.highlights = b.highlights || []
  b.highlights.push(h)
  saveLibrary()
  try { await S.reader.addAnnotation(h) } catch (e) { console.warn(e) }
  hideSelection()
  if (S.pane === 'marks') renderMarks()
  toast(note ? '已添加笔记' : '已划线')
}

async function removeHighlight (h) {
  const b = S.current
  if (!b) return
  b.highlights = b.highlights.filter(x => x.id !== h.id)
  saveLibrary()
  try { await S.reader.removeAnnotation(h) } catch (e) { console.warn(e) }
  if (S.pane === 'marks') renderMarks()
  toast('已删除')
}

function onAnnotationClick ({ value }) {
  const b = S.current
  const h = b?.highlights?.find(x => x.value === value)
  if (!h) return
  const { x, y } = S.lastMouse
  contextMenu(x + 4, y + 4, [
    {
      label: h.note ? '编辑笔记…' : '添加笔记…',
      icon: '#i-note',
      action: async () => {
        const note = await dialog({
          title: '笔记',
          text: h.text?.slice(0, 160),
          input: { value: h.note || '', multiline: true, placeholder: '写下你的想法…' },
          okText: '保存',
        })
        if (note === null) return
        h.note = String(note)
        saveLibrary()
        renderMarks()
      },
    },
    {
      label: '复制文字',
      icon: '#i-copy',
      action: () => { navigator.clipboard.writeText(h.text || ''); toast('已复制') },
    },
    { sep: true },
    { label: '删除划线', icon: '#i-trash', danger: true, action: () => removeHighlight(h) },
  ])
}

// ============================================================ 搜索
function stopSearch () {
  S.searchToken++
  S.searching = false
  try { S.reader?.clearSearchMarks() } catch { /* ignore */ }
}

async function doSearch (query) {
  const q = String(query || '').trim()
  const pane = $('#pane-search')
  if (!q) { pane.innerHTML = ''; stopSearch(); return }
  if (!S.reader) return
  const token = ++S.searchToken
  S.searching = true
  pane.innerHTML = `<div class="sr-head">正在搜索 “${escapeHtml(q)}”…</div>`
  let count = 0
  const groups = []
  try {
    for await (const item of S.reader.search(q)) {
      if (token !== S.searchToken) return
      if (item === 'done') break
      if (item.progress != null) {
        const head = $('.sr-head', pane)
        if (head) head.innerHTML = `正在搜索 “${escapeHtml(q)}” … ${Math.round(item.progress * 100)}%`
        continue
      }
      if (item.subitems) {
        count += item.subitems.length
        groups.push({ label: item.label, items: item.subitems })
        renderSearchResults(pane, q, groups, count, false)
      }
    }
    renderSearchResults(pane, q, groups, count, true)
  } catch (err) {
    console.error(err)
    pane.innerHTML = `<div class="sr-head">搜索出错：${escapeHtml(String(err?.message || err))}</div>`
  } finally {
    S.searching = false
  }
}

function renderSearchResults (pane, q, groups, count, done) {
  const scrollTop = pane.scrollTop
  pane.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'sr-head'
  head.innerHTML = done
    ? (count ? `找到 <b>${count}</b> 处结果` : '没有找到匹配内容')
    : `正在搜索 “${escapeHtml(q)}” …`
  pane.append(head)
  for (const g of groups) {
    if (g.label) {
      const t = document.createElement('div')
      t.className = 'sr-head'
      t.style.cssText = 'padding:2px 10px 6px;font-size:11px;color:var(--accent)'
      t.textContent = g.label
      pane.append(t)
    }
    for (const it of g.items) {
      const el = document.createElement('div')
      el.className = 'sr-item'
      el.innerHTML = `<div class="stx">${highlightQuery(it.excerpt, q)}</div>`
      el.onclick = () => { S.reader?.goTo(it.cfi) }
      pane.append(el)
    }
  }
  pane.scrollTop = scrollTop
}

function highlightQuery (text, q) {
  const safe = escapeHtml(text || '')
  if (!q) return safe
  try {
    const re = new RegExp(escapeRegExp(escapeHtml(q)), 'gi')
    return safe.replace(re, (m) => `<mark>${m}</mark>`)
  } catch { return safe }
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ============================================================ 书籍信息
function renderInfo () {
  const pane = $('#pane-info')
  const b = S.current
  if (!pane || !b) return
  const pct = Math.round((b.progress?.fraction || 0) * 100)
  const rows = [
    ['书名', b.title || '—'],
    ['作者', b.author || '—'],
    ['格式', b.fromTxt ? 'TXT（已转换）' : (FORMAT_LABEL[b.format] || b.format || '').toUpperCase()],
    ['文件大小', fmtBytes(b.size)],
    [isPdfBook() ? '总页数' : '章节数', b.tocCount ? String(b.tocCount) : '—'],
    ['阅读进度', pct + '%'],
    ['上次阅读', b.lastReadAt ? fmtDateTime(b.lastReadAt) : '—'],
    ['加入时间', fmtDateTime(b.addedAt)],
    ['阅读时长', fmtDuration(b.seconds || 0)],
    ['书签 / 划线', `${(b.bookmarks || []).length} / ${(b.highlights || []).length}`],
  ]
  pane.innerHTML = `<div class="info-list">${rows.map(([k, v]) => `
    <div class="info-row"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div></div>`).join('')}</div>
    <div class="info-actions">
      <button class="btn" id="info-reveal"><svg class="i i-sm"><use href="#i-folder"/></svg>文件位置</button>
      <button class="btn" id="info-restart"><svg class="i i-sm"><use href="#i-refresh"/></svg>从头开始</button>
    </div>`
  $('#info-reveal').onclick = () => window.desktop.fs.reveal(b.rel)
  $('#info-restart').onclick = () => {
    b.progress = {}
    saveLibrary()
    S.reader?.goTo(0)
    toast('已回到开头')
  }
}

// ============================================================ 排版面板
function bindStylePanel () {
  // 主题
  $$('.swatch').forEach(btn => {
    btn.onclick = () => {
      const theme = btn.dataset.theme
      if (theme === 'custom') {
        setSettings({ theme: 'custom' })
        syncStylePanel()
        return
      }
      const t = THEMES[theme]
      setSettings({ theme, bg: t.bg, fg: t.fg })
      syncStylePanel()
    }
  })
  $('#set-bg').oninput = (e) => { setSettings({ bg: e.target.value, theme: 'custom' }); syncStylePanel() }
  $('#set-fg').oninput = (e) => { setSettings({ fg: e.target.value, theme: 'custom' }); syncStylePanel() }

  $('#set-font').onchange = (e) => {
    const v = e.target.value
    setSettings({ fontFamily: v })
    $('#row-custom-font').classList.toggle('hidden', v !== 'custom')
  }
  $('#set-font-custom').oninput = (e) => setSettings({ customFont: e.target.value })

  const range = (id, key, fmt, scale = 1) => {
    const el = $(id)
    el.oninput = (e) => {
      const v = Number(e.target.value) * scale
      setSettings({ [key]: v })
      const valEl = $(id.replace('#set-', '#val-'))
      if (valEl) valEl.textContent = fmt(v)
    }
  }
  range('#set-size', 'fontSize', v => Math.round(v) + ' px')
  range('#set-ls', 'letterSpacing', v => (Math.round(v * 10) / 10) + ' px')
  range('#set-lh', 'lineHeight', v => (Math.round(v * 100) / 100).toString())
  range('#set-para', 'paragraphSpacing', v => (Math.round(v * 100) / 100) + ' em')
  range('#set-margin', 'margin', v => Math.round(v) + ' px')

  $$('.seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const key = seg.dataset.key
        const raw = btn.dataset.val
        const val = ['fontWeight', 'textIndent', 'columns'].includes(key) ? Number(raw) : raw
        setSettings({ [key]: val })
        syncStylePanel()
      }
    })
  })

  const sw = (id, key, after) => {
    const el = $(id)
    el.onclick = async () => {
      const v = !S.settings[key]
      await setSettings({ [key]: v })
      el.classList.toggle('on', v)
      after?.(v)
    }
  }
  sw('#set-justify', 'justify')
  sw('#set-hyphen', 'hyphenate')
  sw('#set-marginal', 'showMarginal')
  sw('#set-clickturn', 'clickTurn', (v) => $('#reader').classList.toggle('turn-zones', v))
  sw('#set-ontop', 'alwaysOnTop', (v) => { window.desktop.win.setAlwaysOnTop(v); $('#btn-top').classList.toggle('on', v) })
  sw('#set-quitclose', 'quitOnClose')

  $('#set-autohide').onchange = (e) => {
    const v = clamp(Number(e.target.value) || 0, 0, 600)
    setSettings({ autoHideSeconds: v })
    e.target.value = v
    toast(v ? `鼠标静止 ${v} 秒后自动隐藏` : '已关闭自动隐藏')
  }
  $('#set-hotkey').onchange = async (e) => {
    const v = e.target.value.trim()
    if (!v) return
    const r = await window.desktop.win.updateHotkey(v)
    if (r?.ok) { setSettings({ hotkey: r.accelerator }); toast('热键已更新：' + friendlyHotkey(r.accelerator)) }
    else { e.target.value = S.settings.hotkey; toast('热键注册失败（可能被其他程序占用）', 3000) }
  }
  $('#btn-reset-style').onclick = async () => {
    const keep = { alwaysOnTop: S.settings.alwaysOnTop, quitOnClose: S.settings.quitOnClose, autoHideSeconds: S.settings.autoHideSeconds, hotkey: S.settings.hotkey }
    setSettings({ ...DEFAULT_SETTINGS, ...keep })
    syncStylePanel()
    toast('已恢复默认排版')
  }
  bindSelectionToolbar()
}

function syncStylePanel () {
  const s = S.settings
  $$('.swatch').forEach(b => b.classList.toggle('on', b.dataset.theme === s.theme))
  $('#set-bg').value = s.bg
  $('#set-fg').value = s.fg
  $('#set-font').value = s.fontFamily
  $('#row-custom-font').classList.toggle('hidden', s.fontFamily !== 'custom')
  $('#set-font-custom').value = s.customFont || ''
  $('#set-size').value = s.fontSize
  $('#val-size').textContent = Math.round(s.fontSize) + ' px'
  $('#set-ls').value = s.letterSpacing
  $('#val-ls').textContent = (Math.round(s.letterSpacing * 10) / 10) + ' px'
  $('#set-lh').value = s.lineHeight
  $('#val-lh').textContent = String(Math.round(s.lineHeight * 100) / 100)
  $('#set-para').value = s.paragraphSpacing
  $('#val-para').textContent = String(s.paragraphSpacing) + ' em'
  $('#set-margin').value = s.margin
  $('#val-margin').textContent = Math.round(s.margin) + ' px'

  $$('.seg').forEach(seg => {
    const key = seg.dataset.key
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(s[key]) === b.dataset.val))
  })
  $('#set-justify').classList.toggle('on', !!s.justify)
  $('#set-hyphen').classList.toggle('on', !!s.hyphenate)
  $('#set-marginal').classList.toggle('on', !!s.showMarginal)
  $('#set-clickturn').classList.toggle('on', !!s.clickTurn)
  $('#set-ontop').classList.toggle('on', !!s.alwaysOnTop)
  $('#set-quitclose').classList.toggle('on', !!s.quitOnClose)
  $('#set-autohide').value = s.autoHideSeconds || 0
  $('#set-hotkey').value = s.hotkey || ''
}

const friendlyHotkey = (acc) => String(acc || '')
  .replace('CommandOrControl', 'Ctrl')
  .replace(/\+/g, ' + ')

// ============================================================ 键盘
function bindKeyboard () {
  window.addEventListener('keydown', onKeyDown)
  // 滚轮翻页：分页模式下滚动一格翻一页（滚动模式保持原生滚动）
  window.addEventListener('wheel', onWheelPaging, { passive: false })
  window.addEventListener('mousemove', (e) => { S.lastMouse = { x: e.clientX, y: e.clientY } })
  window.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#sel-toolbar')) hideSelection()
    if (!e.target.closest('#ctx-menu')) hideContextMenu()
  })
}

function onKeyDown (e) {
  const inField = e.target.matches?.('input, textarea, select')
  const mod = e.ctrlKey || e.metaKey

  if (mod) {
    switch (e.key.toLowerCase()) {
      case 'f': e.preventDefault(); toggleSidebar('search'); break
      case 't': e.preventDefault(); toggleSidebar('toc'); break
      case 'b': e.preventDefault(); toggleSidebar('marks'); break
      case 'd': e.preventDefault(); addBookmark(); break
      case ',': e.preventDefault(); $('#style-panel').classList.toggle('open'); syncStylePanel(); break
      case 'l': e.preventDefault(); showShelf(); break
      case 'w': e.preventDefault(); window.desktop.win.hide(); break
      case '=': case '+':
        e.preventDefault(); bumpFont(1); break
      case '-':
        e.preventDefault(); bumpFont(-1); break
      case '0':
        e.preventDefault()
        if (isPdfBook()) { S.reader?.resetZoom?.(); break }
        setSettings({ fontSize: DEFAULT_SETTINGS.fontSize }); syncStylePanel(); break
      default: break
    }
    return
  }
  if (inField) return
  if (!S.current || !S.reader) return

  const k = e.key
  const paginated = S.settings.flow === 'paginated'
  if (k === 'ArrowLeft' || k === 'PageUp' || k === 'h') { e.preventDefault(); S.reader.goLeft() }
  else if (k === 'ArrowRight' || k === 'PageDown' || k === 'l') { e.preventDefault(); S.reader.goRight() }
  else if (k === ' ') { e.preventDefault(); e.shiftKey ? S.reader.prev() : S.reader.next() }
  else if (k === 'ArrowUp' && paginated) {
    e.preventDefault()
    if (isPdfBook() && S.reader.scrollBy) S.reader.scrollBy(-160)
    else S.reader.prev()
  } else if (k === 'ArrowDown' && paginated) {
    e.preventDefault()
    if (isPdfBook() && S.reader.scrollBy) S.reader.scrollBy(160)
    else S.reader.next()
  }
  else if (k === 'Home') { e.preventDefault(); S.reader.goToFraction(0) }
  else if (k === 'End') { e.preventDefault(); S.reader.goToFraction(1) }
  else if (k === 'Escape') {
    if ($('#style-panel').classList.contains('open')) $('#style-panel').classList.remove('open')
    else hideSelection()
  } else if (k === 'F11') { e.preventDefault(); window.desktop.win.setFullScreen(true) }
}

// ============================================================ 滚轮翻页
let wheelAccum = 0
let wheelAt = 0
let wheelBusy = false

function onWheelPaging (e) {
  if (!S.current || !S.reader) return
  if (S.settings.flow !== 'paginated') return        // 上下滚动模式交给原生
  if (S.reader.nativeScroll) return                  // PDF 等自带滚动的视图
  if (e.ctrlKey || e.metaKey) return                 // 留给缩放
  if (e.target.closest?.('#style-panel, .pane, #search-input, #modal-backdrop')) return

  const unit = e.deltaMode === 1 ? 18 : 1
  const dy = e.deltaY * unit
  const dx = e.deltaX * unit
  const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx
  if (Math.abs(d) < 0.8) return

  const now = Date.now()
  if (now - wheelAt > 340) wheelAccum = 0
  wheelAt = now
  wheelAccum += d

  // 触控板的小幅滚动先累积，达到阈值才翻页
  if (Math.abs(wheelAccum) < 40) {
    if (e.cancelable) e.preventDefault()
    return
  }
  const dir = wheelAccum > 0 ? 1 : -1
  wheelAccum = 0
  if (e.cancelable) e.preventDefault()
  if (wheelBusy) return
  wheelBusy = true
  setTimeout(() => { wheelBusy = false }, 200)
  try {
    const p = dir > 0 ? S.reader.next() : S.reader.prev()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch { /* ignore */ }
}

function bumpFont (delta) {
  // PDF 是固定版式，字号快捷方式改成缩放页面
  if (isPdfBook()) { S.reader?.zoomBy?.(delta > 0 ? 0.1 : -0.1); return }
  const size = clamp(Number(S.settings.fontSize) + delta, 12, 42)
  setSettings({ fontSize: size })
  syncStylePanel()
  toast(size + ' px')
}

function isPdfBook () {
  return String(S.current?.format || '').toLowerCase() === 'pdf'
}

// ============================================================ 隐蔽行为
// 自动隐藏：用「最后活动时间戳 + 每秒轮询」判断是否空闲。
// 早期实现用 setTimeout 计时，又用 setInterval 每 15 秒“兜底重置”，
// 结果秒数大于 15 时倒计时会被反复清零、永远走不到终点
// （表现就是：设小秒数正常，调大后无论等多久都不隐藏）。
function bindStealth () {
  const stat = (S.__idle = { ticks: 0, hides: 0, errors: 0, lastActivity: Date.now() })
  let hiding = false
  const touch = () => { stat.lastActivity = Date.now() }
  S.__idleTouch = touch

  window.addEventListener('mousemove', touch, { passive: true })
  window.addEventListener('mousedown', touch, true)
  window.addEventListener('keydown', touch, true)
  window.addEventListener('wheel', touch, { passive: true })
  window.addEventListener('touchstart', touch, { passive: true })
  window.addEventListener('focus', touch)
  // 主进程唤出窗口时（热键 / 托盘 / 程序内隐藏后恢复）重新计时
  try { window.desktop.win.onRevealed?.(touch) } catch { /* 兼容旧版 preload */ }

  setInterval(() => {
    stat.ticks++
    const sec = Number(S.settings.autoHideSeconds) || 0
    if (sec <= 0) return
    if (Date.now() - stat.lastActivity < sec * 1000) return
    if (hiding) return
    hiding = true
    stat.hiding = true
    // 兜底：不依赖 IPC 回执，2 秒后无条件解锁，避免回执丢失导致再也不隐藏
    setTimeout(() => { hiding = false; stat.hiding = false }, 2000)
    // 先重新计时，再发隐藏请求：即使 hide 调用出问题，秒数到了也会继续重试
    stat.lastActivity = Date.now()
    try {
      hideSelection()
      hideContextMenu()
      $('#style-panel')?.classList.remove('open')
    } catch { /* 面板状态清理失败不影响隐藏 */ }
    window.desktop.win.hide()
      .then(() => { stat.hides++ })
      .catch((e) => { stat.errors++; console.warn('自动隐藏失败：', e) })
  }, 1000)
}

// ============================================================ 存储
function saveLibrary () {
  clearTimeout(S.saveTimer)
  S.saveTimer = setTimeout(saveLibraryNow, 900)
}

async function saveLibraryNow () {
  clearTimeout(S.saveTimer)
  try {
    await window.desktop.library.save({ version: 1, books: S.books })
  } catch (e) { console.warn('保存失败', e) }
}

function flushLibraryNow () {
  clearTimeout(S.saveTimer)
  window.desktop.library.save({ version: 1, books: S.books }).catch(() => {})
}

// ============================================================ 调试接口（本地使用）
globalThis.__app = { S, importPaths, openBook, showShelf, setSettings, doSearch, addBookmark, switchPane, flushLibraryNow }
