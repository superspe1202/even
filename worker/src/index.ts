import { extractTitle, htmlToText } from './readable'
import { fetchYouTubeContent } from './youtube'

export interface Env {
  /** 相容 OpenAI chat-completions 的端點，例如 https://api.openai.com/v1 */
  AI_BASE_URL: string
  AI_MODEL: string
  /** 用 `wrangler secret put AI_API_KEY` 設定，絕不寫進 wrangler.toml。 */
  AI_API_KEY: string
  /** 可選的共用權杖，擋掉隨手打到這個網址的請求。見 README 的說明與限制。 */
  APP_TOKEN?: string
  ALLOW_ORIGIN?: string
}

/** 抓回來的網頁最多讀這麼多位元組，避免一個大檔把 Worker 撐爆。 */
const MAX_FETCH_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 15_000

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOW_ORIGIN || '*'

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return json({ ok: true }, 200, origin)
    }
    if (request.method !== 'POST' || url.pathname !== '/extract') {
      return json({ error: '不支援的路徑或方法' }, 404, origin)
    }
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return json({ error: '未授權' }, 401, origin)
    }

    let body: { url?: unknown }
    try {
      body = await request.json()
    } catch {
      return json({ error: '請求內容不是有效的 JSON' }, 400, origin)
    }

    const target = typeof body.url === 'string' ? body.url.trim() : ''
    const problem = validateTarget(target)
    if (problem) return json({ error: problem }, 400, origin)

    try {
      const source = await loadSource(target)
      const recipe = await extractRecipe(source, env)
      return json(recipe, 200, origin)
    } catch (err) {
      const message = err instanceof Error ? err.message : '解析失敗'
      console.error('extract 失敗：', message)
      return json({ error: message }, 502, origin)
    }
  },
}

/**
 * 擋掉指向內網的目標。
 *
 * 這個 Worker 會去抓使用者給的任何網址，等於一個對外開放的抓取代理。
 * 雖然 Cloudflare Worker 本身碰不到你家的內網，但擋住這些位址能避免它
 * 被拿去探測其他服務，也讓錯誤訊息更明確。
 */
function validateTarget(target: string): string | null {
  if (!target) return '缺少 url 欄位'
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return '網址格式不正確'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '只支援 http / https 連結'
  }
  const host = parsed.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (blocked) return '不接受指向內部網路的網址'
  return null
}

interface SourceContent {
  kind: 'youtube' | 'web'
  title: string
  text: string
}

function isYouTube(target: string): boolean {
  const host = new URL(target).hostname.replace(/^www\./, '').toLowerCase()
  return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
}

async function loadSource(target: string): Promise<SourceContent> {
  if (isYouTube(target)) {
    const { title, transcript } = await fetchYouTubeContent(target)
    return { kind: 'youtube', title, text: transcript }
  }

  const response = await fetch(target, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`無法讀取網頁（${response.status}）`)

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !contentType.includes('html') && !contentType.includes('text')) {
    throw new Error('這個連結不是網頁內容')
  }

  const html = await readCapped(response)
  const text = htmlToText(html)
  if (text.length < 100) throw new Error('這個頁面幾乎沒有文字內容，可能需要登入或由 JavaScript 載入')
  return { kind: 'web', title: extractTitle(html), text }
}

/** 邊讀邊算大小，超過上限就截斷 —— 不能信任 content-length。 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()

  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(decoder.decode(value, { stream: true }))
    if (total >= MAX_FETCH_BYTES) {
      await reader.cancel()
      break
    }
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

const SYSTEM_PROMPT = `你是一位把料理內容整理成穿戴裝置食譜的編輯。

使用者會給你一篇網頁文字或一段影片字幕。請抽取出食譜，並以繁體中文（台灣用語）輸出。

規則：
- 只輸出 JSON，不要加上任何說明文字或 markdown 標記。
- name：食譜名稱，10 個字以內。
- servings：份量人數，整數。
- totalMinutes：總時間（分鐘），整數。
- ingredients：食材陣列，每項 { "item": "名稱", "amount": "份量" }。沒寫份量就給空字串。
- steps：步驟陣列，每項 { "text": "做什麼", "timerSeconds": 秒數, "tip": "提醒" }。
  - text 每步 60 字以內，寫成動作指令，不要編號。這會顯示在眼鏡上，太長會讀不完。
  - timerSeconds 只在原文明確提到等待或烹煮時間時才填（例如「煎五分鐘」填 300）。沒有就省略這個欄位。
  - tip 只在有重要提醒時才填，沒有就省略。
- 如果內容根本不是食譜，回傳 { "error": "這不是食譜內容" }。

輸出格式：
{"name":"","servings":2,"totalMinutes":30,"ingredients":[],"steps":[]}`

async function extractRecipe(source: SourceContent, env: Env): Promise<unknown> {
  if (!env.AI_API_KEY) throw new Error('伺服器未設定 AI_API_KEY')

  const label = source.kind === 'youtube' ? '影片字幕' : '網頁內容'
  const userContent = `標題：${source.title || '（無）'}\n\n以下是${label}：\n\n${source.text}`

  const response = await fetch(`${env.AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      temperature: 0.2,
      // 不是每個相容端點都支援 response_format，所以 system prompt 裡
      // 也明確要求「只輸出 JSON」，兩層保險。
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`AI 服務回應 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 服務沒有回傳內容')

  const recipe = parseJsonLoose(content)
  if (recipe && typeof recipe === 'object' && 'error' in recipe) {
    throw new Error(String((recipe as { error: unknown }).error))
  }
  return recipe
}

/** 有些模型還是會把 JSON 包在 ```json 圍欄裡，先剝掉再解析。 */
function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        // 落到下面統一報錯
      }
    }
    throw new Error('AI 回傳的內容不是有效的 JSON')
  }
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-app-token',
    'access-control-max-age': '86400',
  }
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  })
}
