import {
  LANG_PROMPT_NAMES,
  UserFacingError,
  isCjk,
  messageFor,
  parseLang,
  type ErrorCode,
  type Lang,
} from './errors'
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
      return failure('not_found', 404, origin, 'en')
    }
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return failure('unauthorized', 401, origin, 'en')
    }

    if (url.pathname === '/generate') return handleGenerate(request, env, origin)
    return handleExtract(request, env, origin)
  },
}

async function handleExtract(request: Request, env: Env, origin: string): Promise<Response> {
  let body: { url?: unknown; lang?: unknown }
  try {
    body = await request.json()
  } catch {
    return failure('bad_request', 400, origin, 'en')
  }
  const lang = parseLang(body.lang)

  const target = typeof body.url === 'string' ? body.url.trim() : ''
  const problem = validateTarget(target)
  if (problem) return failure(problem, 400, origin, lang)

  try {
    const source = await loadSource(target, lang)
    const recipe = await extractRecipe(source, env, lang)
    return json(recipe, 200, origin)
  } catch (err) {
    console.error('extract 失敗：', err)
    return failure(errorCode(err), 502, origin, lang)
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
  let body: { query?: unknown; lang?: unknown }
  try {
    body = await request.json()
  } catch {
    return failure('bad_request', 400, origin, 'en')
  }
  const lang = parseLang(body.lang)

  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return failure('query_empty', 400, origin, lang)
  if (query.length > MAX_QUERY_LENGTH) return failure('query_too_long', 400, origin, lang)

  try {
    const result = await generateRecipes(query, env, lang)
    return json(result, 200, origin)
  } catch (err) {
    console.error('generate 失敗：', err)
    return failure(errorCode(err), 502, origin, lang)
  }
}

/** 只有明確標成可給使用者看的錯誤才回具體代碼，其餘一律換成通用的 `generic`。 */
function errorCode(err: unknown): ErrorCode {
  return err instanceof UserFacingError ? err.code : 'generic'
}

/** `{ error, code }`：App 看 `code` 翻成使用者語言；`error` 只是後備。 */
function failure(code: ErrorCode, status: number, origin: string, lang: Lang): Response {
  return json({ error: messageFor(code, lang), code }, status, origin)
}

/**
 * 擋掉指向內網的目標。
 *
 * 這個 Worker 會去抓使用者給的任何網址，等於一個對外開放的抓取代理。
 * 雖然 Cloudflare Worker 本身碰不到你家的內網，但擋住這些位址能避免它
 * 被拿去探測其他服務，也讓錯誤訊息更明確。
 */
function validateTarget(target: string): ErrorCode | null {
  if (!target) return 'invalid_url'
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return 'invalid_url'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'invalid_scheme'
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
  if (blocked) return 'page_unreachable'
  return null
}

interface SourceContent {
  title: string
  text: string
}

/**
 * 影片連結（YouTube、TikTok、Bilibili、Vimeo、IG／FB 短影音）。目前只接受食譜網頁，
 * 不做影片分析：讀影片內容得抓頁面或字幕檔，不是走官方 API，有違反平台條款的疑慮。
 */
function isVideoLink(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '')
    const path = u.pathname.toLowerCase()
    if (/(^|\.)(youtube\.com|youtu\.be|tiktok\.com|douyin\.com|bilibili\.com|b23\.tv|vimeo\.com|fb\.watch)$/.test(host)) {
      return true
    }
    if (/(^|\.)instagram\.com$/.test(host) && /^\/(reel|reels|tv)\//.test(path)) return true
    if (/(^|\.)facebook\.com$/.test(host) && /^\/(watch|reel)/.test(path)) return true
    return false
  } catch {
    return false
  }
}

async function loadSource(target: string, lang: Lang): Promise<SourceContent> {
  if (isVideoLink(target)) throw new UserFacingError('video_unsupported')

  const response = await fetch(target, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': `${lang === 'zh' ? 'zh-TW' : lang},${lang === 'zh' ? 'zh' : lang};q=0.9,en;q=0.8`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    console.error('網頁讀取失敗：', response.status)
    throw new UserFacingError('page_unreachable')
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !contentType.includes('html') && !contentType.includes('text')) {
    throw new UserFacingError('not_html')
  }

  const html = await readCapped(response)
  const text = htmlToText(html)
  if (text.length < 100) {
    throw new UserFacingError('page_empty')
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

/**
 * 依語言調整的長度上限。眼鏡內文欄約 392 px 寬：中日韓一個字佔一格，
 * 拉丁字母約半格，所以非 CJK 語言的字數上限放寬一倍左右。
 */
function limits(lang: Lang) {
  return isCjk(lang)
    ? { name: 10, label: 6, summary: 25, step: 60 }
    : { name: 28, label: 16, summary: 70, step: 130 }
}

/** 提示詞一律用英文寫（模型最穩），再明講輸出語言；輸出裡的欄位名稱維持英文不翻。 */
function languageRule(lang: Lang): string {
  const name = LANG_PROMPT_NAMES[lang]
  const extra =
    lang === 'zh'
      ? ' Use Taiwanese wording and Traditional Chinese characters only (never Simplified).'
      : lang === 'ko'
        ? ' Prefer common everyday words, because the display font has a limited set of Hangul syllables.'
        : ''
  return `Write every text value (name, label, summary, ingredient names and amounts, steps, tips) in ${name}.${extra} Keep the JSON keys in English exactly as specified. Use metric units (grams, millilitres) unless the source clearly uses others.`
}

function extractPrompt(lang: Lang): string {
  const l = limits(lang)
  return `You are an editor who turns cooking content into recipes for a smart-glasses app.

The user gives you the text of a web page. Extract the recipe from it.

${languageRule(lang)}

Rules:
- Output JSON only. No explanations and no markdown.
- name: the recipe name, at most ${l.name} characters.
- servings: number of servings, an integer.
- totalMinutes: total time in minutes, an integer.
- ingredients: an array of { "item": "name", "amount": "quantity" }. Use an empty string when no quantity is given.
- steps: an array of { "text": "what to do", "timerSeconds": seconds, "tip": "reminder" }.
  - text: at most ${l.step} characters per step, written as an instruction, without numbering. It is shown on the glasses, so long text cannot be read.
  - timerSeconds: only when the source clearly mentions a waiting or cooking time (for example "fry for five minutes" gives 300). Omit the field otherwise.
  - tip: only for an important reminder. Omit it otherwise.
- If the content is not a recipe at all, return { "error": "not_recipe" }. Return the literal code, not a sentence.

Output format:
{"name":"","servings":2,"totalMinutes":30,"ingredients":[],"steps":[]}`
}

async function extractRecipe(source: SourceContent, env: Env, lang: Lang): Promise<unknown> {
  const userContent = `Title: ${source.title || '(none)'}\n\nWeb page content:\n\n${source.text}`
  return runRecipePrompt(extractPrompt(lang), userContent, env)
}

/** 一次給幾種做法讓使用者挑。三種剛好一個畫面看得完，也不會讓回應慢太多。 */
const OPTION_COUNT = 3

function generatePrompt(lang: Lang): string {
  const l = limits(lang)
  return `You are a cook who knows home cooking well, generating recipes for a smart-glasses recipe app.

The user gives you only a dish name or a cooking keyword, with no source material. Using your own knowledge,
give ${OPTION_COUNT} commonly made, workable versions of the dish that are clearly different from each other,
so the user can pick one to cook.

${languageRule(lang)}

The versions must differ in substance, for example: the traditional classic, a quick and simple version,
a regional or family variation, or a different main seasoning or cooking method (braised, stir-fried, rice cooker).
Do not just change the quantities, and do not invent versions that do not exist.
If the dish really has only one sensible way of making it, give only 1 or 2 versions.

Rules:
- Output JSON only. No explanations and no markdown.
- options: an array of versions, each with:
  - label: the name of this version, at most ${l.label} characters (for example "Classic", "Quick").
  - summary: one sentence about what makes this version special, at most ${l.summary} characters.
  - recipe: the full recipe, with the fields below.
- name: the recipe name, at most ${l.name} characters.
- servings: number of servings, an integer.
- totalMinutes: total time in minutes, an integer.
- ingredients: an array of { "item": "name", "amount": "quantity" }. Give a common quantity (for example "2 tbsp"), or "to taste" when unsure.
- steps: an array of { "text": "what to do", "timerSeconds": seconds, "tip": "reminder" }.
  - text: at most ${l.step} characters per step, written as an instruction, without numbering. It is shown on the glasses, so long text cannot be read.
  - timerSeconds: only when the step usually needs a wait or a cooking time (for example "simmer 20 minutes" gives 1200). Omit it when unsure.
  - tip: only for a detail worth reminding. Omit it otherwise.
- If the keyword does not look like food or a dish name, return { "error": "not_food" }. Return the literal code, not a sentence.

Output format:
{"options":[{"label":"","summary":"","recipe":{"name":"","servings":2,"totalMinutes":30,"ingredients":[],"steps":[]}}]}`
}

async function generateRecipes(query: string, env: Env, lang: Lang): Promise<unknown> {
  const payload = await runRecipePrompt(generatePrompt(lang), `Dish keyword: ${query}`, env)
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
    // prompt 要求 AI 在「不是食譜／不是料理名稱」時回固定代碼；
    // 認不得的內容（模型自己發揮了一句話）一律當通用錯誤，不把任意文字傳給使用者。
    const code = String((recipe as { error: unknown }).error)
    throw new UserFacingError(code === 'not_food' ? 'not_food' : code === 'not_recipe' ? 'not_recipe' : 'generic')
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
