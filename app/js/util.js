export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))

export const clamp = (v, a, b) => Math.min(Math.max(v, a), b)

export function debounce (fn, ms = 300) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

export function throttle (fn, ms = 100) {
  let last = 0
  let timer = null
  return (...args) => {
    const now = Date.now()
    const wait = ms - (now - last)
    if (wait <= 0) { last = now; fn(...args) }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args) }, wait)
    }
  }
}

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function fmtBytes (n) {
  if (!n) return '0 KB'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB'
}

export function fmtDate (ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const p = (x) => String(x).padStart(2, '0')
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

export function fmtDateTime (ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDuration (sec) {
  if (!sec) return '0 分钟'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 语言映射对象 → 字符串（EPUB 元数据可能是多语言对象） */
export function langText (v) {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(langText).filter(Boolean).join('、')
  if (typeof v === 'object') {
    if (v.name) return langText(v.name)
    const keys = Object.keys(v)
    for (const k of ['zh', 'zh-CN', 'zh-Hans', 'en']) if (v[k]) return langText(v[k])
    return keys.length ? langText(v[keys[0]]) : ''
  }
  return String(v)
}

let toastTimer = null
export function toast (msg, ms = 1800) {
  const el = $('#toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

/** 通用弹窗：{title, text, input, okText, cancelText, danger} → Promise<value|null> */
export function dialog ({ title = '提示', text = '', input = null, okText = '确定', cancelText = '取消', danger = false, hideCancel = false }) {
  return new Promise((resolve) => {
    const backdrop = $('#modal-backdrop')
    $('#modal-title').textContent = title
    const body = $('#modal-body')
    const foot = $('#modal-foot')
    body.innerHTML = ''
    if (text) {
      const p = document.createElement('div')
      p.className = 'mtext'
      p.textContent = text
      body.append(p)
    }
    let field = null
    if (input !== null) {
      field = input.multiline
        ? document.createElement('textarea')
        : Object.assign(document.createElement('input'), { type: 'text' })
      if (input.multiline) field.style.minHeight = '96px'
      field.value = input.value || ''
      field.placeholder = input.placeholder || ''
      if (!input.multiline) field.style.minHeight = '0'
      body.style.paddingTop = '8px'
      body.append(field)
    }
    foot.innerHTML = ''
    const close = (val) => {
      backdrop.classList.remove('show')
      document.removeEventListener('keydown', onKey, true)
      resolve(val)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null) }
      if (e.key === 'Enter' && !(field && field.tagName === 'TEXTAREA')) {
        e.stopPropagation()
        close(field ? field.value : true)
      }
    }
    if (!hideCancel) {
      const cancel = document.createElement('button')
      cancel.className = 'btn'
      cancel.textContent = cancelText
      cancel.onclick = () => close(null)
      foot.append(cancel)
    }
    const ok = document.createElement('button')
    ok.className = 'btn primary'
    if (danger) ok.style.background = '#c9463c'
    ok.textContent = okText
    ok.onclick = () => close(field ? field.value : true)
    foot.append(ok)
    backdrop.classList.add('show')
    document.addEventListener('keydown', onKey, true)
    setTimeout(() => { (field || ok).focus?.(); field?.select?.() }, 30)
  })
}

export const confirmDialog = (title, text, okText = '确定') => dialog({ title, text, okText })
  .then(v => !!v)

/** 右键菜单 */
export function contextMenu (x, y, items) {
  const el = $('#ctx-menu')
  el.innerHTML = ''
  for (const it of items) {
    if (it.sep) { const d = document.createElement('div'); d.className = 'line'; el.append(d); continue }
    const b = document.createElement('button')
    if (it.danger) b.className = 'danger'
    b.innerHTML = `${it.icon ? `<svg class="i i-sm"><use href="${it.icon}"/></svg>` : ''}<span>${escapeHtml(it.label)}</span>`
    b.onclick = () => { hideContextMenu(); it.action?.() }
    el.append(b)
  }
  el.classList.add('show')
  const rect = el.getBoundingClientRect()
  // 关键：先夹到左侧/顶部边界内，否则靠左的卡片（x 为负）会把菜单顶出屏幕
  const maxX = window.innerWidth - rect.width - 8
  const maxY = window.innerHeight - rect.height - 8
  el.style.left = clamp(Math.min(x, maxX), 8, Math.max(8, maxX)) + 'px'
  el.style.top = clamp(Math.min(y, maxY), 8, Math.max(8, maxY)) + 'px'
}

export function hideContextMenu () {
  $('#ctx-menu')?.classList.remove('show')
}

document.addEventListener('mousedown', (e) => {
  const el = $('#ctx-menu')
  if (el && el.classList.contains('show') && !el.contains(e.target)) hideContextMenu()
}, true)
window.addEventListener('blur', () => hideContextMenu())
