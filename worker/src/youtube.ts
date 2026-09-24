/**
 * YouTube 字幕抓取。
 *
 * YouTube 沒有公開的字幕 API，所以只能抓 watch 頁面、從內嵌的
 * `ytInitialPlayerResponse` 撈出字幕軌網址再取回內容。這是非官方路徑，
 * YouTube 改版時會壞掉 —— 呼叫端必須把失敗當成正常情況處理，而不是例外。
 */

import { UserFacingError } from './errors'

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string
}

/** 偏好的字幕語言，依序挑選。 */
const LANGUAGE_PREFERENCE = ['zh-Hant', 'zh-TW', 'zh-Hans', 'zh-CN', 'zh', 'en']

export interface YouTubeContent {
  title: string
  transcript: string
}

export async function fetchYouTubeContent(url: string): Promise<YouTubeContent> {
  const page = await fetch(url, {
    headers: {
      // 沒帶這兩個標頭時 YouTube 會回精簡版頁面，裡面沒有字幕資訊。
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  })
  if (!page.ok) {
    console.error('YouTube 頁面讀取失敗：', page.status)
    throw new UserFacingError('讀不到這部 YouTube 影片，請確認連結是對的。')
  }
  const html = await page.text()

  const title = decodeEntities(
    html.match(/<meta name="title" content="([^"]*)"/)?.[1] ??
      html.match(/<title>([^<]*)<\/title>/)?.[1] ??
      '',
  ).replace(/\s*-\s*YouTube$/, '')

  const tracks = extractCaptionTracks(html)
  if (!tracks.length) {
    throw new UserFacingError('這部影片沒有字幕，沒辦法整理成食譜。')
  }

  const track = pickTrack(tracks)
  const transcript = await fetchTranscript(track.baseUrl)
  if (!transcript.trim()) throw new UserFacingError('這部影片的字幕是空的，沒辦法整理成食譜。')

  return { title, transcript }
}

export function extractCaptionTracks(html: string): CaptionTrack[] {
  const marker = '"captionTracks":'
  const at = html.indexOf(marker)
  if (at === -1) return []

  // 從 `"captionTracks":` 後面的 `[` 開始做括號配對，把整個陣列切出來。
  // 直接用正則匹配 `\[.*?\]` 會被字幕標題裡的中括號切斷。
  const start = html.indexOf('[', at)
  if (start === -1) return []
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1)) as CaptionTrack[]
          return parsed.filter(t => typeof t?.baseUrl === 'string')
        } catch {
          return []
        }
      }
    }
  }
  return []
}

export function pickTrack(tracks: CaptionTrack[]): CaptionTrack {
  for (const lang of LANGUAGE_PREFERENCE) {
    // 人工字幕優先於自動產生的（kind === 'asr'），品質差很多。
    const manual = tracks.find(t => t.languageCode === lang && t.kind !== 'asr')
    if (manual) return manual
  }
  for (const lang of LANGUAGE_PREFERENCE) {
    const any = tracks.find(t => t.languageCode === lang)
    if (any) return any
  }
  return tracks[0]
}

async function fetchTranscript(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl)
  if (!response.ok) {
    console.error('YouTube 字幕讀取失敗：', response.status)
    throw new UserFacingError('讀不到這部影片的字幕，請稍後再試。')
  }
  const xml = await response.text()

  const lines: string[] = []
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
    if (text) lines.push(text)
  }
  return lines.join('\n')
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
