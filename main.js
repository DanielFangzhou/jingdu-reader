'use strict'
/**
 * 静读 · 桌面电子书阅读器 —— 主进程
 * 绿色便携：所有数据都写在程序目录下的 user-data/ 中，不写注册表。
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, globalShortcut, protocol, net, nativeImage, shell, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const crypto = require('node:crypto')

// ---------------------------------------------------------------- 路径
const APP_PATH = app.getAppPath()
// 打包/绿色版布局: <根>/resources/app ; 开发布局: 项目根目录
const ROOT = APP_PATH.endsWith(path.join('resources', 'app'))
  ? path.dirname(path.dirname(APP_PATH))
  : APP_PATH
const USER_DATA = path.join(ROOT, 'user-data')
const BOOKS_DIR = path.join(USER_DATA, 'books')
const COVERS_DIR = path.join(USER_DATA, 'covers')

for (const d of [USER_DATA, BOOKS_DIR, COVERS_DIR]) fs.mkdirSync(d, { recursive: true })
try { app.setPath('userData', path.join(USER_DATA, 'profile')) } catch { /* ignore */ }
app.setPath('sessionData', path.join(USER_DATA, 'profile'))

const STATE_FILE = path.join(USER_DATA, 'window-state.json')
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json')

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
const writeJSON = async (file, data) => {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

// ---------------------------------------------------------------- 窗口
let win = null
let tray = null
let quitting = false
let settings = readJSON(SETTINGS_FILE, {})

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+B'
const DEFAULT_SIZE = { width: 1220, height: 840 }

const clampToScreen = (bounds) => {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(Math.max(bounds.width, 720), area.width)
  const height = Math.min(Math.max(bounds.height, 480), area.height)
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function createWindow () {
  const saved = readJSON(STATE_FILE, null)
  const bounds = clampToScreen(saved?.bounds ?? {
    ...DEFAULT_SIZE,
    x: Math.round((screen.getPrimaryDisplay().workArea.width - DEFAULT_SIZE.width) / 2) + screen.getPrimaryDisplay().workArea.x,
    y: Math.round((screen.getPrimaryDisplay().workArea.height - DEFAULT_SIZE.height) / 2) + screen.getPrimaryDisplay().workArea.y,
  })

  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    frame: false,
    // 关键：工具栏窗口 —— 不出现在任务栏，也不出现在 Alt+Tab 里
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    skipTaskbar: true,
    backgroundColor: '#f6f1e7',
    title: '静读',
    autoHideMenuBar: true,
    icon: path.join(APP_PATH, 'assets', 'app.png'),
    webPreferences: {
      preload: path.join(APP_PATH, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      devTools: !!settings.devTools,
      backgroundThrottling: false,
    },
  })

  win.setMenuBarVisibility(false)
  win.loadURL('app://reader/index.html')

  win.webContents.on('console-message', (e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${String(source).split('/').pop()}:${line})`)
  })
  win.webContents.on('preload-error', (e, p, err) => console.error('[preload error]', p, err))
  win.webContents.on('render-process-gone', (e, d) => console.error('[render gone]', d))
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.error('[load fail]', code, desc, url))

  win.once('ready-to-show', () => {
    if (!settings.startHidden) revealWindow()
    else if (!tray) createTray()
  })

  // 关闭按钮 = 隐藏（除非在设置里选择直接退出）
  win.on('close', (e) => {
    if (quitting) return
    if (settings.quitOnClose) { quitting = true; app.quit(); return }
    e.preventDefault()
    hideWindow()
  })

  win.on('closed', () => { win = null })

  const saveBounds = debounce(() => {
    if (!win || win.isDestroyed()) return
    const isMax = win.isMaximized()
    const prev = readJSON(STATE_FILE, {}) || {}
    writeJSON(STATE_FILE, {
      ...prev,
      maximized: isMax,
      bounds: isMax ? (prev.bounds ?? bounds) : win.getBounds(),
    }).catch(() => {})
  }, 400)
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('maximize', saveBounds)
  win.on('unmaximize', saveBounds)

  if (saved?.maximized) win.maximize()

  // 外部链接交给系统浏览器（仅 http/https）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })
  return win
}

function debounce (fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

function revealWindow () {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating')
  return win
}

function hideWindow () {
  if (!win) return
  if (win.isFullScreen()) win.setFullScreen(false)
  win.hide()
  if (!tray) createTray()
}

function toggleWindow () {
  if (!win) return createWindow()
  if (win.isVisible() && win.isFocused()) hideWindow()
  else revealWindow()
}

// ---------------------------------------------------------------- 托盘
function createTray () {
  if (tray) return tray
  const iconPath = path.join(APP_PATH, 'assets', 'tray.png')
  let img = nativeImage.createFromPath(iconPath)
  if (img.isEmpty()) img = nativeImage.createEmpty()
  tray = new Tray(img.resize({ width: 16, height: 16 }))
  const menu = Menu.buildFromTemplate([
    { label: '显示阅读器', click: () => revealWindow() },
    { label: '隐藏窗口', click: () => hideWindow() },
    { type: 'separator' },
    { label: '置顶显示', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (item) => setAlwaysOnTop(item.checked) },
    { type: 'separator' },
    {
      label: '退出（彻底关闭）',
      click: () => {
        quitting = true
        app.isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setToolTip('静读 · 阅读中')
  tray.setContextMenu(menu)
  tray.on('click', () => toggleWindow())
  tray.on('double-click', () => revealWindow())
  return tray
}

function setAlwaysOnTop (on) {
  settings.alwaysOnTop = !!on
  writeJSON(SETTINGS_FILE, settings).catch(() => {})
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!on, 'floating')
  return settings.alwaysOnTop
}

// ---------------------------------------------------------------- 深链接协议
protocol.registerSchemesAsPrivileged([
  { scheme: 'book', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
}

function registerAppProtocol () {
  const APP_ROOT = path.join(APP_PATH, 'app')
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      let rel = decodeURIComponent(url.pathname || '')
      if (rel === '/' || rel === '') rel = '/index.html'
      const target = path.resolve(APP_ROOT, '.' + rel)
      if (!target.startsWith(APP_ROOT)) return new Response('forbidden', { status: 403 })
      const data = await fsp.readFile(target)
      return new Response(data, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' },
      })
    } catch (e) {
      return new Response('not found: ' + request.url, { status: 404 })
    }
  })
}

function registerBookProtocol () {
  protocol.handle('book', async (request) => {
    try {
      const url = new URL(request.url)
      let rel = decodeURIComponent(url.pathname || '')
      rel = rel.replace(/^\/+/, '')
      const target = path.resolve(USER_DATA, rel)
      if (!target.startsWith(USER_DATA + path.sep)) return new Response('forbidden', { status: 403 })
      if (!fs.existsSync(target)) return new Response('not found', { status: 404 })
      return await net.fetch(pathToFileURL(target).toString())
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })
}

// ---------------------------------------------------------------- IPC
const okFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

ipcMain.handle('app:info', () => ({
  dataDir: USER_DATA,
  booksDir: BOOKS_DIR,
  version: app.getVersion(),
  platform: process.platform,
  hotkey: settings.hotkey || DEFAULT_HOTKEY,
  isPackaged: app.isPackaged,
}))

ipcMain.handle('settings:save', async (e, s) => {
  const wasTop = !!settings.alwaysOnTop
  settings = { ...settings, ...s }
  await writeJSON(SETTINGS_FILE, settings)
  if (win && !win.isDestroyed() && wasTop !== !!settings.alwaysOnTop) {
    win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating')
  }
  return true
})

ipcMain.handle('settings:load', () => settings)

ipcMain.handle('dialog:pickBooks', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择电子书',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '电子书 (epub/mobi/azw3/pdf/txt/fb2/cbz)', extensions: ['epub', 'mobi', 'azw3', 'azw', 'prc', 'pdf', 'txt', 'fb2', 'fbz', 'cbz'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(win, { title: '选择书库文件夹', properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('book:import', async (e, srcPath, ext) => {
  if (!okFile(srcPath)) throw new Error('文件不存在: ' + srcPath)
  const id = crypto.randomUUID()
  const suffix = String(ext || path.extname(srcPath) || '.book').replace(/^\.?/, '.')
  const rel = path.join('books', id + suffix)
  const dest = path.join(USER_DATA, rel)
  await fsp.copyFile(srcPath, dest)
  const st = await fsp.stat(dest)
  return {
    id,
    name: path.basename(srcPath),
    ext: suffix.slice(1).toLowerCase(),
    size: st.size,
    rel: rel.split(path.sep).join('/'),
    url: 'book://local/' + rel.split(path.sep).join('/'),
  }
})

ipcMain.handle('book:writeVariant', async (e, id, ext, bytes) => {
  const suffix = String(ext).replace(/^\.?/, '.')
  const rel = 'books/' + id + suffix
  await fsp.writeFile(path.join(USER_DATA, rel), Buffer.from(bytes))
  return { rel, url: 'book://local/' + rel, size: (await fsp.stat(path.join(USER_DATA, rel))).size }
})

ipcMain.handle('book:removeFile', async (e, rel) => {
  try { await fsp.unlink(path.join(USER_DATA, rel)) } catch { /* ignore */ }
  return true
})

ipcMain.handle('file:exists', (e, rel) => okFile(path.join(USER_DATA, rel)))

ipcMain.handle('file:read', async (e, absPath) => {
  const st = await fsp.stat(absPath)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > 400 * 1024 * 1024) throw new Error('文件过大')
  return new Uint8Array(await fsp.readFile(absPath))
})

ipcMain.handle('cover:save', async (e, id, mime, bytes) => {
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.jpg'
  const rel = 'covers/' + id + ext
  await fsp.writeFile(path.join(USER_DATA, rel), Buffer.from(bytes))
  return { rel, url: 'book://local/' + rel }
})

ipcMain.handle('library:load', () => readJSON(path.join(USER_DATA, 'library.json'), { books: [], version: 1 }))

ipcMain.handle('library:save', async (e, data) => {
  await writeJSON(path.join(USER_DATA, 'library.json'), data)
  return true
})

ipcMain.handle('shell:reveal', (e, rel) => {
  const p = rel ? path.join(USER_DATA, rel) : USER_DATA
  if (okFile(p)) shell.showItemInFolder(p)
  else shell.openPath(USER_DATA)
  return true
})

ipcMain.handle('shell:openExternal', (e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  return true
})

ipcMain.handle('win:hide', () => { hideWindow(); return true })
ipcMain.handle('win:show', () => { revealWindow(); return true })
ipcMain.handle('win:toggleMaximize', () => {
  if (!win) return false
  if (win.isMaximized()) win.unmaximize(); else win.maximize()
  return win.isMaximized()
})
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false))
ipcMain.handle('win:setAlwaysOnTop', (e, on) => setAlwaysOnTop(on))
ipcMain.handle('win:getAlwaysOnTop', () => !!settings.alwaysOnTop)
ipcMain.handle('win:setFullScreen', (e, on) => {
  if (!win) return false
  win.setFullScreen(!!on)
  return win.isFullScreen()
})
ipcMain.handle('win:quit', () => { quitting = true; app.quit(); return true })
ipcMain.handle('win:minimizeToTray', () => { hideWindow(); return true })

ipcMain.handle('hotkey:update', (e, accelerator) => registerHotkey(accelerator))

// ---------------------------------------------------------------- 热键
let currentHotkey = null
function registerHotkey (accelerator) {
  const target = accelerator || DEFAULT_HOTKEY
  if (currentHotkey === target) return { ok: true, accelerator: target }
  try {
    if (currentHotkey) globalShortcut.unregister(currentHotkey)
    const ok = globalShortcut.register(target, () => toggleWindow())
    currentHotkey = ok ? target : null
    if (ok) {
      settings.hotkey = target
      writeJSON(SETTINGS_FILE, settings).catch(() => {})
      return { ok: true, accelerator: target }
    }
    // 注册失败则回退默认
    if (target !== DEFAULT_HOTKEY) return registerHotkey(DEFAULT_HOTKEY)
    return { ok: false, accelerator: target }
  } catch (err) {
    return { ok: false, accelerator: target, error: String(err) }
  }
}

// ---------------------------------------------------------------- 调试 / 自动截图
async function runAutotest () {
  const paths = String(process.env.TEST_BOOKS || '').split(';').filter(Boolean)
  const dir = path.join(USER_DATA, 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG())
      console.log('[shot]', name)
    } catch (e) { console.error('shot failed', name, e.message) }
  }
  const js = (code) => win.webContents.executeJavaScript(code, true).catch(e => console.error('eval:', e.message))

  win.show()
  await sleep(1500)
  if (process.argv.includes('--diag')) {
    const list = ['epubcfi', 'progress', 'overlayer', 'text-walker', 'search', 'paginator', 'epub', 'mobi', 'fb2', 'comic-book', 'fixed-layout', 'uri-template', 'footnotes', 'vendor/zip', 'vendor/fflate', 'view']
    const diag = await win.webContents.executeJavaScript(`
      (async () => {
        const out = {}
        for (const n of ${JSON.stringify(list)}) {
          try { await import('./lib/' + n + '.js'); out[n] = 'ok' } catch (e) { out[n] = String(e) }
        }
        return JSON.stringify(out, null, 2)
      })()
    `, true).catch(e => 'diag failed ' + e.message)
    console.log('[diag]', diag)
    app.quit()
    return
  }
  await shot('01-shelf')

  // ---- 阅读进度持久化测试：第一次读到 45%，退出；第二次启动应回到 45% 附近
  if (process.argv.includes('--resume1')) {
    await js(`__app.importPaths(${JSON.stringify(paths)})`)
    await sleep(8000)
    await js(`__app.openBook(__app.S.books[0])`)
    await sleep(6000)
    await js(`__app.S.reader.goToFraction(0.45)`)
    await sleep(2500)
    const info = await js(`JSON.stringify({
      saved: __app.S.current.progress,
      loc: { frac: __app.S.reader.location?.fraction, cfi: __app.S.reader.location?.cfi },
    })`)
    console.log('[resume1]', info)
    await js(`__app.flushLibraryNow()`)
    await sleep(600)
    await shot('20-resume1')
    app.quit()
    return
  }

  if (process.argv.includes('--resume2')) {
    const before = await js(`JSON.stringify(__app.S.books.map(b => ({ t: b.title, p: b.progress })))`)
    console.log('[resume2 library]', before)
    await js(`__app.openBook(__app.S.books[0])`)
    await sleep(7000)
    const after = await js(`JSON.stringify({
      loc: { frac: __app.S.reader?.location?.fraction, cfi: __app.S.reader?.location?.cfi },
      page: __app.S.reader?.pageInfo,
    })`)
    console.log('[resume2 reopened]', after)
    await shot('21-resume2')
    app.quit()
    return
  }

  if (process.argv.includes('--pdftest')) {
    await js(`__app.importPaths(${JSON.stringify(paths)})`)
    await sleep(10000)
    await shot('p01-shelf')
    const books = await js(`JSON.stringify(__app.S.books.map(b => ({t:b.title,f:b.format})))`)
    console.log('[books]', books)

    // ---- 书架首本书的“更多”菜单不能越界
    await js(`document.querySelectorAll('.card .more')[0]?.click()`)
    await sleep(500)
    console.log('[ctx-menu]', await js(`(() => { const el = document.querySelector('#ctx-menu'); const r = el.getBoundingClientRect(); return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }) })()`))
    await shot('p01b-menu')
    await js(`document.querySelector('#ctx-menu')?.classList.remove('show')`)

    // ---- PDF 打开
    await js(`__app.openBook(__app.S.books.find(b => b.format === 'pdf'))`)
    await sleep(7000)
    await shot('p02-reader')
    console.log('[pdf dom]', await js(`JSON.stringify({
      cls: __app.S.reader?.constructor?.name,
      pages: document.querySelectorAll('.pdf-page').length,
      canvas: document.querySelectorAll('.pdf-canvas').length,
      textLayerSpans: document.querySelectorAll('.pdf-page .textLayer span').length,
      tocItems: document.querySelectorAll('#pane-toc .toc-item').length,
      pageInfo: __app.S.reader?.pageInfo,
      loc: { cfi: __app.S.reader?.location?.cfi, frac: __app.S.reader?.location?.fraction, chapter: __app.S.reader?.location?.tocItem?.label },
      status: document.querySelector('#st-page')?.textContent,
    })`))

    console.log('[pdf geom]', await js(`JSON.stringify({
      win: innerWidth,
      hostW: document.querySelector('#view-host')?.clientWidth,
      stageW: document.querySelector('.pdf-stage')?.clientWidth,
      stageScrollW: document.querySelector('.pdf-stage')?.scrollWidth,
      pageW: Math.round(document.querySelector('.pdf-page')?.getBoundingClientRect().width || 0),
      pageLeft: Math.round(document.querySelector('.pdf-page')?.getBoundingClientRect().left || 0),
      pageRight: Math.round(document.querySelector('.pdf-page')?.getBoundingClientRect().right || 0),
    })`))

    // ---- 选中文字 → 划线 → 书签
    console.log('[pdf sel attempt]', await js(`(() => {
      try {
        const page = document.querySelector('.pdf-page')
        const spans = [...page.querySelectorAll('.textLayer span')].filter(s => (s.textContent || '').trim().length > 2)
        if (spans.length < 4) return 'no spans: ' + spans.length
        const a = spans[1], b = spans[3]
        const range = document.createRange()
        range.setStart(a.firstChild || a, 0)
        range.setEnd(b.firstChild || b, (b.textContent || '').length)
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
        const before = String(sel)
        document.querySelector('.pdf-stage').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return 'sel=' + before.slice(0, 20) + ' left=' + sel.rangeCount + ' after=' + String(getSelection()).slice(0,20)
      } catch (e) { return 'ERR ' + e.message }
    })()`))
    await sleep(800)
    console.log('[pdf textlayer]', await js(`JSON.stringify({
      spans: document.querySelectorAll('.pdf-page .textLayer span').length,
      sample: document.querySelector('.pdf-page .textLayer')?.innerHTML.slice(0, 260),
      selText: String(getSelection()).slice(0, 30),
    })`))
    console.log('[pdf selection]', await js(`JSON.stringify({
      toolbar: document.querySelector('#sel-toolbar')?.classList.contains('show'),
      text: __app.S.pendingSelection?.text?.slice(0, 24),
      rects: __app.S.pendingSelection?.rects?.length,
    })`))
    await shot('p03-selection')
    await js(`document.querySelectorAll('#sel-toolbar .hb')[0]?.click()`)
    await sleep(1000)
    console.log('[pdf highlight]', await js(`JSON.stringify({
      n: (__app.S.current.highlights || []).length,
      rects: __app.S.current.highlights?.[0]?.rects?.length,
      painted: document.querySelectorAll('.pdf-mark').length,
    })`))
    await shot('p04-highlight')

    // ---- 点目录跳转
    await js(`document.querySelectorAll('#pane-toc .toc-item')[2]?.click()`)
    await sleep(3000)
    await shot('p03-toc-jump')
    console.log('[pdf toc jump]', await js(`JSON.stringify({ loc: __app.S.reader?.location?.cfi, ch: __app.S.reader?.location?.tocItem?.label })`))

    // ---- 滚动（PDF 原生滚动）
    await js(`(() => { const s = document.querySelector('.pdf-stage'); s.scrollTop += 1400 })()`)
    await sleep(2200)
    await shot('p04-scroll')
    console.log('[pdf scroll]', await js(`JSON.stringify({ page: __app.S.reader?.pageInfo?.page, pct: document.querySelector('#st-percent')?.textContent })`))

    // ---- 搜索
    await js(`document.querySelector('#btn-search').click()`)
    await sleep(400)
    await js(`__app.doSearch('山间')`)
    await sleep(6000)
    await shot('p05-search')
    console.log('[pdf search]', await js(`JSON.stringify({ head: document.querySelector('#pane-search .sr-head')?.textContent, items: document.querySelectorAll('#pane-search .sr-item').length })`))

    // ---- 进度定位
    await js(`__app.S.reader.goToFraction(0.8)`)
    await sleep(2500)
    await shot('p06-progress')
    console.log('[pdf progress]', await js(`JSON.stringify({ page: __app.S.reader?.pageInfo, pct: document.querySelector('#st-percent')?.textContent })`))

    // ---- EPUB 滚轮翻页
    await js(`__app.showShelf()`)
    await sleep(500)
    await js(`__app.openBook(__app.S.books.find(b => b.format === 'epub'))`)
    await sleep(6000)
    const before = await js(`JSON.stringify({ cfi: __app.S.reader?.location?.cfi, page: __app.S.reader?.pageInfo })`)
    await js(`(() => {
      const w = (window.__wheelTarget = document.querySelector('#view-host iframe')?.contentWindow || window)
      for (let i = 0; i < 3; i++) w.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    })()`)
    await sleep(2000)
    const after = await js(`JSON.stringify({ cfi: __app.S.reader?.location?.cfi, page: __app.S.reader?.pageInfo })`)
    console.log('[wheel before]', before)
    console.log('[wheel after ]', after)
    await shot('p07-wheel')

    app.quit()
    return
  }

  if (paths.length) {
    await js(`__app.importPaths(${JSON.stringify(paths)})`)
    await sleep(9000)
    await shot('02-shelf-imported')

    const books = await js(`JSON.stringify(__app.S.books.map(b => ({id:b.id,title:b.title,format:b.format})))`)
    console.log('[books]', books)

    await js(`__app.openBook(__app.S.books[0])`)
    await sleep(7000)
    await shot('03-reader')

    if (process.argv.includes('--probe')) {
      await js(`__app.S.reader.goToFraction(0.35)`)
      await sleep(2500)
      const probe = await js(`(() => {
        try {
          const r = __app.S.reader.view.renderer
          const out = r.getContents().map(c => {
            const doc = c.doc
            const fr = doc.defaultView.frameElement.getBoundingClientRect()
            const ps = doc.querySelectorAll('p')
            return {
              index: c.index,
              iframeH: Math.round(fr.height), iframeTop: Math.round(fr.top), iframeW: Math.round(fr.width),
              bodyH: Math.round(doc.body.getBoundingClientRect().height),
              htmlH: Math.round(doc.documentElement.getBoundingClientRect().height),
              firstP: ps[0] ? Math.round(ps[0].getBoundingClientRect().top) : null,
              lastP: ps.length ? Math.round(ps[ps.length - 1].getBoundingClientRect().bottom) : null,
              pCount: ps.length,
            }
          })
          return JSON.stringify({ pages: r.pages, page: r.page, index: r.index, contents: out }, null, 1)
        } catch (e) { return 'probe failed: ' + e.message }
      })()`)
      console.log('[probe]', probe)
      await shot('03b-probe')
    }

    await js(`document.querySelector('#btn-style').click()`)
    await sleep(700)
    await shot('04-style-panel')
    await js(`document.querySelector('#btn-style').click()`)

    // 改一次字号，验证样式注入确实生效
    await js(`(() => { const r = document.querySelector('#set-size'); r.value = 26; r.dispatchEvent(new Event('input', {bubbles:true})) })()`)
    await sleep(1200)
    await shot('05-reader-bigfont')
    await js(`(() => { const r = document.querySelector('#set-size'); r.value = 19; r.dispatchEvent(new Event('input', {bubbles:true})) })()`)
    await sleep(600)

    // 上下滚动模式
    await js(`__app.setSettings({ flow: 'scrolled' })`)
    await sleep(2500)
    await shot('05b-scrolled')
    await js(`__app.setSettings({ flow: 'paginated' })`)
    await sleep(2000)

    // 双栏模式
    await js(`__app.setSettings({ columns: 2 })`)
    await sleep(2500)
    await shot('05c-two-col')
    await js(`__app.setSettings({ columns: 1 })`)
    await sleep(2000)

    await js(`__app.S.reader.next(); __app.S.reader.next()`)
    await sleep(1500)
    await shot('06-reader-page2')

    await js(`document.querySelector('#btn-mark').click()`)
    await sleep(500)
    await js(`document.querySelector('#add-mark')?.click()`)
    await sleep(800)
    await shot('07-marks')

    await js(`document.querySelector('#btn-search').click()`)
    await sleep(500)
    await js(`(() => { const i = document.querySelector('#search-input'); i.value='the'; __app.doSearch('the') })()`)
    await sleep(5000)
    await shot('08-search')

    // 逐个打开其余格式，各截一张
    const count = await js(`__app.S.books.length`)
    for (let i = 1; i < count; i++) {
      await js(`__app.showShelf()`)
      await sleep(400)
      await js(`__app.openBook(__app.S.books[${i}])`)
      await sleep(7000)
      const fmt = await js(`__app.S.books[${i}].format`)
      await shot('09-fmt-' + fmt + '-' + i)
    }

    await js(`__app.showShelf()`)
    await sleep(700)
    await shot('10-shelf-back')
  }
  app.quit()
}

// ---------------------------------------------------------------- 生命周期
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => revealWindow())

  app.whenReady().then(async () => {
    registerAppProtocol()
    registerBookProtocol()
    createWindow()
    createTray()
    const hk = registerHotkey(settings.hotkey || DEFAULT_HOTKEY)
    console.log('[hotkey]', JSON.stringify(hk), 'isRegistered:',
      globalShortcut.isRegistered(hk.accelerator))

    // 托盘/热键的额外快捷键
    globalShortcut.register('CommandOrControl+Alt+H', () => hideWindow())

    // 阻止托盘被回收
    app.on('activate', () => revealWindow())

    if (process.argv.includes('--autotest')) runAutotest()
  })
}

app.on('window-all-closed', () => {
  // 不退出：常驻托盘，保证热键随时可唤出
  if (quitting) app.quit()
})

app.on('before-quit', () => { quitting = true; app.isQuitting = true })
app.on('will-quit', () => { globalShortcut.unregisterAll() })
