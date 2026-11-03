import { measureTextWrap } from '@evenrealities/pretext'

/**
 * 依照容器的實際像素盒把長文切成頁。
 *
 * `measureTextWrap` 用的是 G2 韌體 LVGL 的真實字寬（含 CJK），所以中文
 * 混排也不會算錯行數。傳進來的要是容器的「內框」（扣掉 padding 與 border）。
 *
 * 改寫自官方 evenhub-templates/text-heavy（MIT）。
 */

/** EvenHub 的 LVGL 行高固定 27px。 */
const LINE_HEIGHT = 27

export interface PaginateBox {
  width: number
  height: number
}

export function linesPerPage(height: number): number {
  return Math.max(1, Math.floor(height / LINE_HEIGHT))
}

export function paginate(source: string, box: PaginateBox): string[] {
  const maxLines = linesPerPage(box.height)
  const paragraphs = source
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)

  const pages: string[] = []
  let buffer: string[] = []
  let bufferLines = 0

  const flush = () => {
    if (!buffer.length) return
    pages.push(buffer.join('\n\n'))
    buffer = []
    bufferLines = 0
  }

  for (const para of paragraphs) {
    const paraLines = measureTextWrap(para, box.width).lineCount

    if (paraLines > maxLines) {
      flush()
      for (const chunk of splitParagraph(para, box.width, maxLines)) pages.push(chunk)
      continue
    }

    // 同頁兩段之間的空行也要佔一行。
    const cost = paraLines + (buffer.length ? 1 : 0)
    if (bufferLines + cost > maxLines) {
      flush()
      buffer.push(para)
      bufferLines = paraLines
    } else {
      buffer.push(para)
      bufferLines += cost
    }
  }
  flush()
  return pages.length ? pages : ['']
}

function splitParagraph(text: string, width: number, maxLines: number): string[] {
  // 中文沒有空白可切，所以逐字累加；西文則靠 token 之間的空白自然斷開。
  const tokens = text.split(/(\s+)/).flatMap(token =>
    /\s/.test(token) || /^[\x00-\x7F]+$/.test(token) ? [token] : Array.from(token),
  )
  const chunks: string[] = []
  let current = ''

  for (const token of tokens) {
    const candidate = current + token
    const { lineCount } = measureTextWrap(candidate, width)
    if (lineCount > maxLines && current.trim()) {
      chunks.push(current.trim())
      current = token.replace(/^\s+/, '')
    } else {
      current = candidate
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/**
 * 以「行」為單位打包成頁，適合食材清單這種一項一行的內容。
 *
 * `paginate` 是段落導向的：段落之間會插空行，而且整段放不下時會退回逐字
 * 切割。清單用它會浪費垂直空間（標題自己佔一頁），所以另外走這條路。
 */
export function paginateLines(lines: string[], box: PaginateBox): string[] {
  const maxLines = linesPerPage(box.height)
  const pages: string[] = []
  let buffer: string[] = []
  let used = 0

  for (const line of lines) {
    // 一項太長會自己折行，要照實際佔用的行數計算。
    const cost = Math.max(1, measureTextWrap(line, box.width).lineCount)
    if (used + cost > maxLines && buffer.length) {
      pages.push(buffer.join('\n'))
      buffer = []
      used = 0
    }
    buffer.push(line)
    used += cost
  }
  if (buffer.length) pages.push(buffer.join('\n'))
  return pages.length ? pages : ['']
}
