/**
 * 把網頁 HTML 壓成純文字餵給模型。
 *
 * 不做完整的 readability 演算法：食譜頁的內容密度高，直接去掉
 * script/style/nav 之後的全文已經夠模型用，而且少一份相依就少一份
 * 在 Worker 上出事的機會。
 */

/** 送進模型的字數上限，避免一頁廣告把 token 燒光。 */
const MAX_CHARS = 24_000

export function htmlToText(html: string): string {
  const cleaned = html
    // 先拿掉不會有內容、卻很佔篇幅的區塊。
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 區塊標籤換成換行，保留「一行一項」的結構 —— 食材清單靠這個才不會黏成一坨。
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const text = decodeEntities(cleaned)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim()

  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
}

export function extractTitle(html: string): string {
  const raw =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    ''
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}
