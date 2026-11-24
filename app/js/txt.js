/**
 * TXT → EPUB 转换（纯前端实现，含最小 ZIP 写入器）
 * 转换后书架里存的是标准 EPUB，翻页、目录、书签、CFI 定位全部复用 EPUB 能力。
 */

const enc = (s) => new TextEncoder().encode(s)

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (u8) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

async function deflateRaw (u8) {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const cs = new CompressionStream('deflate-raw')
    const stream = new Blob([u8]).stream().pipeThrough(cs)
    const buf = await new Response(stream).arrayBuffer()
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

/** files: [{ name, data:Uint8Array, store?:boolean }] */
async function makeZip (files) {
  const chunks = []
  const central = []
  let offset = 0
  const DOS_TIME = 0 // 00:00:00
  const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1

  for (const f of files) {
    const nameBytes = enc(f.name)
    const raw = f.data
    let body = raw
    let method = 0
    if (!f.store) {
      const def = await deflateRaw(raw)
      if (def && def.length < raw.length) { body = def; method = 8 }
    }
    const crc = crc32(raw)
    const local = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(6, 0x0800, true) // UTF-8 名称
    dv.setUint16(8, method, true)
    dv.setUint16(10, DOS_TIME, true)
    dv.setUint16(12, DOS_DATE, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, body.length, true)
    dv.setUint32(22, raw.length, true)
    dv.setUint16(26, nameBytes.length, true)
    dv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    chunks.push(local, body)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cdv = new DataView(cd.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    cdv.setUint16(8, 0x0800, true)
    cdv.setUint16(10, method, true)
    cdv.setUint16(12, DOS_TIME, true)
    cdv.setUint16(14, DOS_DATE, true)
    cdv.setUint32(16, crc, true)
    cdv.setUint32(20, body.length, true)
    cdv.setUint32(24, raw.length, true)
    cdv.setUint16(28, nameBytes.length, true)
    cdv.setUint16(30, 0, true)
    cdv.setUint16(32, 0, true)
    cdv.setUint16(34, 0, true)
    cdv.setUint16(36, 0, true)
    cdv.setUint32(38, 0, true)
    cdv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + body.length
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const end = new Uint8Array(22)
  const edv = new DataView(end.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, files.length, true)
  edv.setUint16(10, files.length, true)
  edv.setUint32(12, cdSize, true)
  edv.setUint32(16, offset, true)

  const all = [...chunks, ...central, end]
  const total = all.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of all) { out.set(c, p); p += c.length }
  return out
}

// ---------------------------------------------------------------- 文本解码
export function decodeText (bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.length > 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(u8.subarray(3))
  }
  if (u8.length > 3 && u8[0] === 0xFF && u8[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(u8.subarray(2))
  }
  if (u8.length > 3 && u8[0] === 0xFE && u8[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(u8.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch { /* 不是合法 UTF-8 */ }
  for (const label of ['gb18030', 'big5', 'shift_jis']) {
    try { return new TextDecoder(label).decode(u8) } catch { /* next */ }
  }
  return new TextDecoder('utf-8').decode(u8)
}

// ---------------------------------------------------------------- 章节切分
const CHAPTER_RE = [
  /^第[0-9零一二三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟两]{1,12}[章节節回卷篇集部话話幕](?:[\s、:：.·\-—]{0,3}.*)?$/,
  /^(?:序章|序言|楔子|引子|引言|前言|后记|後記|尾声|尾聲|终章|終章|结局|結局|番外|正文|附录|附錄|作者的话|作者的話)(?:[\s、:：.·\-—]{0,3}.*)?$/,
  /^(?:Chapter|CHAPTER|Part|PART|BOOK|Book)\s+[0-9IVXLCivxlc]{1,6}(?:[\s.:：\-—].{0,40})?$/,
  /^(?:卷|冊|册)[0-9零一二三四五六七八九十百千]{1,8}(?:[\s、:：.·\-—].{0,40})?$/,
]

const isChapterTitle = (line) => {
  if (!line || line.length > 48) return false
  if (/[。，．,；;！？?]$/.test(line)) return false
  return CHAPTER_RE.some(r => r.test(line))
}

function splitChapters (text) {
  const lines = text.split(/\r\n|\r|\n/)
  const chapters = []
  let cur = { title: '', lines: [] }
  for (const raw of lines) {
    const line = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
    if (isChapterTitle(line)) {
      if (cur.lines.join('').trim() || cur.title) chapters.push(cur)
      cur = { title: line, lines: [] }
    } else {
      cur.lines.push(raw)
    }
  }
  if (cur.lines.join('').trim() || cur.title) chapters.push(cur)
  return chapters
}

function splitByLength (text, size = 7000) {
  const lines = text.split(/\r\n|\r|\n/)
  const out = []
  let buf = []
  let len = 0
  let n = 1
  const flush = () => {
    if (!buf.join('').trim()) return
    out.push({ title: `第 ${n} 节`, lines: buf })
    n++
    buf = []
    len = 0
  }
  for (const line of lines) {
    buf.push(line)
    len += line.length
    if (len >= size) flush()
  }
  flush()
  return out
}

// ---------------------------------------------------------------- EPUB 组装
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function pageXhtml (title, bodyHtml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>${xml(title)}</title>
<style>body{margin:0;padding:0;}h2{text-align:center;margin:1em 0;}p{margin:0;text-indent:2em;}</style>
</head>
<body>
${title ? `<h2>${xml(title)}</h2>` : ''}
${bodyHtml}
</body></html>`
}

/**
 * @param {Uint8Array} bytes 原始文件字节
 * @param {string} filename 带扩展名的文件名
 * @returns {Promise<{epub:Uint8Array, title:string, author:string, chapters:number}>}
 */
export async function txtToEpub (bytes, filename) {
  const text = decodeText(bytes).replace(/\u0000/g, '')
  const baseName = String(filename || '未命名').replace(/\.txt$/i, '')

  const head = text.slice(0, 2000).split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean)
  let title = baseName
  let author = ''
  const authorLine = head.slice(0, 40).find(l => /^(?:作者|作\s*者|著者)[：:\s]/.test(l))
  if (authorLine) author = authorLine.replace(/^(?:作者|作\s*者|著者)[：:\s]*/, '').trim().slice(0, 40)
  for (const l of head.slice(0, 6)) {
    if (l.length >= 2 && l.length <= 40 && !isChapterTitle(l) && !/^(?:作者|作\s*者|著者|简介|内容简介)[：:]/.test(l)) {
      title = l.replace(/^《(.+)》$/, '$1')
      break
    }
  }

  let chapters = splitChapters(text)
  if (chapters.length < 2) chapters = splitByLength(text)
  if (!chapters.length) chapters = [{ title: '正文', lines: [text] }]

  const docs = chapters.map((ch, i) => {
    const paras = ch.lines
      .map(l => l.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
      .filter(Boolean)
      .map(l => `<p>${xml(l)}</p>`)
      .join('\n')
    return { title: ch.title || (i === 0 ? title : `第 ${i + 1} 部分`), html: pageXhtml(ch.title, paras) }
  })

  const navItems = docs.map((d, i) => ({ label: d.title, href: `c${i + 1}.xhtml` }))
  const uidStr = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now())

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${xml(uidStr)}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    ${author ? `<dc:creator>${xml(author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${docs.map((d, i) => `    <item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${docs.map((d, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${navItems.map(n => `<li><a href="${n.href}">${xml(n.label)}</a></li>`).join('\n')}
</ol></nav></body></html>`

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${xml(uidStr)}"/></head>
  <docTitle><text>${xml(title)}</text></docTitle>
  <navMap>
${navItems.map((n, i) => `    <navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${xml(n.label)}</text></navLabel><content src="${n.href}"/></navPoint>`).join('\n')}
  </navMap>
</ncx>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const files = [
    { name: 'mimetype', data: enc('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: enc(container) },
    { name: 'OEBPS/content.opf', data: enc(opf) },
    { name: 'OEBPS/nav.xhtml', data: enc(nav) },
    { name: 'OEBPS/toc.ncx', data: enc(ncx) },
    ...docs.map((d, i) => ({ name: `OEBPS/c${i + 1}.xhtml`, data: enc(d.html) })),
  ]

  const epub = await makeZip(files)
  return { epub, title, author, chapters: docs.length }
}
