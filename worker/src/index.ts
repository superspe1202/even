import { GENERIC_FAILURE, UserFacingError } from './errors'
import { extractTitle, htmlToText } from './readable'

export interface Env {
  /** 相容 OpenAI chat-completions 的端點，例如 https://api.openai.com/v1 */
  AI_BASE_URL: string
  AI_MODEL: string
  /**
   * 用 `wrangler secret put AI_API_KEY` 設定，絕不寫進 wrangler.toml。
   * 沒設就改用下面的 Workers AI，不需要任何金鑰。
   */
  AI_API_KEY?: string
  /** Cloudflare Workers AI 綁定（wrangler.toml 的 [ai]）。模型跑在自己的 Cloudflare 帳號裡。 */
  AI?: Ai
  WORKERS_AI_MODEL?: string
  /** 設成 'off' 可停用 response_format；預設會帶，被拒絕時自動退回重試。 */
  AI_JSON_MODE?: string
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
    if (request.method !== 'POST' || (url.pathname !== '/extract' && url.pathname !== '/generate')) {
      return json({ error: '不支援的路徑或方法' }, 404, origin)
    }
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return json({ error: '未授權' }, 401, origin)
    }

    if (url.pathname === '/generate') return handleGenerate(request, env, origin)
    return handleExtract(request, env, origin)
  },
}

async function handleExtract(request: Request, env: Env, origin: string): Promise<Response> {
  let body: { url?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: '請求格式不對。' }, 400, origin)
  }

  const target = typeof body.url === 'string' ? body.url.trim() : ''
  const problem = validateTarget(target)
  if (problem) return json({ error: problem }, 400, origin)

  try {
    const source = await loadSource(target)
    const recipe = await extractRecipe(source, env)
    return json(recipe, 200, origin)
  } catch (err) {
    console.error('extract 失敗：', err)
    return json({ error: userMessage(err) }, 502, origin)
  }
}

const MAX_QUERY_LENGTH = 60

/**
 * 直接請 AI 憑自己的知識生成幾種不同做法讓使用者挑，不接搜尋引擎。
 *
 * 「抓 Google 搜尋最上面的 AI 回答」做不到——那是 Google 網頁自己的介面
 * （AI Overview），沒有公開 API，爬蟲抓會違反服務條款而且畫面隨時會改版。
 * 這裡改成同樣的最終體驗（打幾個字、AI 生出食譜、使用者確認後才存檔），
 * 只是不真的上網搜尋，而是讓語言模型直接回答，跟匯入連結共用同一套
 * 「AI 產生 JSON → 前端 normalizeRecipe 收斂 → 進編輯器讓使用者過目」流程。
 */
async function handleGenerate(request: Request, env: Env, origin: string): Promise<Response> {
  let body: { query?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: '請求格式不對。' }, 400, origin)
  }

  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return json({ error: '請先輸入菜名。' }, 400, origin)
  if (query.length > MAX_QUERY_LENGTH) return json({ error: '菜名太長了，簡短一點就好。' }, 400, origin)

  try {
    const result = await generateRecipes(query, env)
    return json(result, 200, origin)
  } catch (err) {
    console.error('generate 失敗：', err)
    return json({ error: userMessage(err) }, 502, origin)
  }
}

/** 只有明確標成可給使用者看的訊息才原樣回傳，其餘一律換成通用的白話。 */
function userMessage(err: unknown): string {
  return err instanceof UserFacingError ? err.message : GENERIC_FAILURE
}

/**
 * 擋掉指向內網的目標。
 *
 * 這個 Worker 會去抓使用者給的任何網址，等於一個對外開放的抓取代理。
 * 雖然 Cloudflare Worker 本身碰不到你家的內網，但擋住這些位址能避免它
 * 被拿去探測其他服務，也讓錯誤訊息更明確。
 */
function validateTarget(target: string): string | null {
  if (!target) return '沒有收到網址。'
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return '網址看起來不完整，請確認有整段複製。'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '請貼上網頁連結（http 或 https 開頭）。'
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
  if (blocked) return '這個網址沒辦法讀取。'
  return null
}

interface SourceContent {
  title: string
  text: string
}

/**
 * 不支援 YouTube：讀字幕得直接抓影片頁面與字幕檔，不是走官方 API，
 * 有違反 YouTube 使用條款的疑慮；想做影片裡那道菜，用 AI 搜尋菜名就好。
 */
function isYouTube(target: string): boolean {
  const host = new URL(target).hostname.replace(/^www\./, '').toLowerCase()
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'
}

async function loadSource(target: string): Promise<SourceContent> {
  if (isYouTube(target)) {
    throw new UserFacingError('目前不支援 YouTube 影片。請貼食譜網頁，或直接用 AI 搜尋菜名。')
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
  if (!response.ok) {
    console.error('網頁讀取失敗：', response.status)
    throw new UserFacingError('這個網頁打不開，可能要登入才看得到，或已經失效。')
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !contentType.includes('html') && !contentType.includes('text')) {
    throw new UserFacingError('這個連結不是網頁，沒辦法讀取。')
  }

  const html = await readCapped(response)
  const text = htmlToText(html)
  if (text.length < 100) {
    throw new UserFacingError('這個網頁幾乎沒有文字，可能要登入才看得到。')
  }
  return { title: extractTitle(html), text }
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

使用者會給你一篇網頁文字。請抽取出食譜，並以繁體中文（台灣用語）輸出。

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
  const userContent = `標題：${source.title || '（無）'}\n\n以下是網頁內容：\n\n${source.text}`
  return runRecipePrompt(SYSTEM_PROMPT, userContent, env)
}

/** 一次給幾種做法讓使用者挑。三種剛好一個畫面看得完，也不會讓回應慢太多。 */
const OPTION_COUNT = 3

const GENERATE_SYSTEM_PROMPT = `你是一位熟悉家常料理的廚師，正在幫穿戴裝置的食譜 App 生成食譜。

使用者只會給你一個菜名或料理關鍵字，不會提供任何原始資料。請憑你自己的知識，
給出這道菜 ${OPTION_COUNT} 種「一般常見、做得出來」但彼此明顯不同的做法，
讓使用者挑一種來做，以繁體中文（台灣用語）輸出。

做法之間要有實質差異，例如：傳統經典版、省時簡單版、不同地區或家庭的版本、
不同主要調味或烹調方式（燉／炒／電鍋）。不要只是份量不同，也不要硬湊不存在的做法。
如果這道菜真的只有一種合理做法，可以只給 1 到 2 種。

規則：
- 只輸出 JSON，不要加上任何說明文字或 markdown 標記。
- options：做法陣列，每項有：
  - label：這種做法的名稱，6 個字以內（例如「經典紅燒」「電鍋版」「快速版」）。
  - summary：一句話說明這個做法的特色，25 字以內。
  - recipe：完整食譜，欄位如下。
- name：食譜名稱，10 個字以內。
- servings：份量人數，整數。
- totalMinutes：總時間（分鐘），整數。
- ingredients：食材陣列，每項 { "item": "名稱", "amount": "份量" }。份量給常見的量（例如「2 大匙」），不確定就給「適量」。
- steps：步驟陣列，每項 { "text": "做什麼", "timerSeconds": 秒數, "tip": "提醒" }。
  - text 每步 60 字以內，寫成動作指令，不要編號。這會顯示在眼鏡上，太長會讀不完。
  - timerSeconds 只在這步驟通常需要等待或烹煮一段時間時才填（例如「小火燉 20 分鐘」填 1200）。不確定就省略。
  - tip 只在有值得提醒的細節時才填，沒有就省略。
- 如果這個關鍵字看起來不是食物或料理名稱，回傳 { "error": "這看起來不是料理名稱" }。

輸出格式：
{"options":[{"label":"","summary":"","recipe":{"name":"","servings":2,"totalMinutes":30,"ingredients":[],"steps":[]}}]}`

async function generateRecipes(query: string, env: Env): Promise<unknown> {
  const payload = await runRecipePrompt(GENERATE_SYSTEM_PROMPT, `料理關鍵字：${query}`, env)
  const options = (payload as { options?: unknown } | null)?.options
  if (!Array.isArray(options) || !options.length) throw new Error('AI 沒有回傳任何做法')
  // 模型偶爾會多給；超過就截掉，手機畫面是照三種設計的。
  return { options: options.slice(0, OPTION_COUNT) }
}

/** `/extract` 與 `/generate` 共用的呼叫、重試與解析邏輯，差別只在 system prompt 與使用者內容。 */
async function runRecipePrompt(
  systemPrompt: string,
  userContent: string,
  env: Env,
): Promise<unknown> {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]

  // 沒有外部 AI 金鑰就用 Cloudflare 自己的 Workers AI。
  const recipe = env.AI_API_KEY
    ? await runExternal(messages, env)
    : env.AI
      ? await runWorkersAi(messages, env)
      : (() => {
          throw new Error('伺服器沒有設定 AI_API_KEY，也沒有 Workers AI 綁定')
        })()

  if (recipe && typeof recipe === 'object' && 'error' in recipe) {
    // 這是 system prompt 要求 AI 在「不是食譜／不是料理名稱」時回的句子，本來就寫給人看。
    throw new UserFacingError(String((recipe as { error: unknown }).error))
  }
  return recipe
}

const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

async function runWorkersAi(messages: ChatMessage[], env: Env): Promise<unknown> {
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL
  // 型別只列得出 Cloudflare 當下已知的模型；這裡的型號來自設定檔，所以放寬型別。
  const run = env.AI!.run.bind(env.AI) as (model: string, input: unknown) => Promise<unknown>
  // Workers AI 預設只輸出 256 個 token，三種完整食譜遠遠不夠，一定要調高。
  const result = (await run(model, { messages, max_tokens: 6000, temperature: 0.2 })) as {
    response?: unknown
  }
  const response = result?.response
  if (response && typeof response === 'object') return response
  if (typeof response !== 'string' || !response.trim()) throw new Error('Workers AI 沒有回傳內容')
  return parseJsonLoose(response)
}

async function runExternal(messages: ChatMessage[], env: Env): Promise<unknown> {
  // 各家相容端點對 response_format 的支援程度不一，被拒絕時退回不帶它重試一次。
  // system prompt 本身就要求「只輸出 JSON」，加上 parseJsonLoose 會剝掉
  // markdown 圍欄，所以少了這個參數仍然能正常運作。
  let response = await callChatCompletions(env, messages, env.AI_JSON_MODE !== 'off')
  if (response.status === 400 && env.AI_JSON_MODE !== 'off') {
    const detail = await response.clone().text().catch(() => '')
    if (/response_format|json_object|json_schema/i.test(detail)) {
      console.warn('端點不接受 response_format，改用純提示模式重試')
      response = await callChatCompletions(env, messages, false)
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`AI 服務回應 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 服務沒有回傳內容')
  return parseJsonLoose(content)
}

interface ChatMessage {
  role: string
  content: string
}

function callChatCompletions(
  env: Env,
  messages: ChatMessage[],
  jsonMode: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: env.AI_MODEL,
    temperature: 0.2,
    messages,
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  return fetch(`${env.AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
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
