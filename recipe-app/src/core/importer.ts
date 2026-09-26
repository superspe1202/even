import { newId } from './id'
import type { Difficulty, Ingredient, Recipe, RecipeSource, Step } from './types'

/**
 * 解析服務的位置。打包時由 Vite 以 `VITE_API_BASE` 注入；
 * 這個網域也必須列在 app.json 的 network whitelist 裡，否則會被 Even 擋下。
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/**
 * 後端還沒部署時，「貼上連結」和「AI 搜尋食譜」按了一定失敗——
 * 手機端乾脆不顯示這兩個入口，免得使用者點進去才看到錯誤。
 */
export const ONLINE_IMPORT_ENABLED = API_BASE !== ''

/** 訊息會直接顯示給使用者看，一律寫白話，不出現狀態碼或技術名詞。 */
export class ImportError extends Error {}

export function isYouTube(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
  } catch {
    return false
  }
}

/**
 * 把食譜網頁連結送到後端解析成食譜。
 *
 * 不支援 YouTube：讀字幕得抓影片頁面與字幕檔，不是官方 API，有違反 YouTube
 * 使用條款的疑慮。`isYouTube` 留著，是為了舊版匯入的食譜還能標出來源。
 *
 * 抓取與 AI 呼叫都在後端做，原因有二：金鑰不能放進 .ehpk（任何人都能解壓縮），
 * 以及 WebView 的 CORS 會擋掉絕大多數第三方網站。
 */
export async function importFromUrl(url: string): Promise<Recipe> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ImportError('網址看起來不完整，請確認有整段複製。')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImportError('請貼上網頁連結（http 或 https 開頭）。')
  }
  if (isYouTube(url)) {
    throw new ImportError('目前不支援 YouTube 影片。請貼食譜網頁，或直接用 AI 搜尋菜名。')
  }
  const payload = await postToService('/extract', { url })
  return normalizeRecipe(payload, url, 'web')
}

/**
 * 呼叫後端並把各種失敗翻成白話。
 *
 * 後端回的 `{ "error": "..." }` 已經是寫給使用者看的句子（例如「這部影片沒有
 * 字幕」），直接顯示；拿不到就依狀況給一句通用的，絕不把原始回應丟給使用者。
 */
async function postToService(path: string, body: unknown): Promise<unknown> {
  if (!API_BASE) throw new ImportError('這個功能目前還沒開放。')

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ImportError('連不上網路，請確認手機有網路後再試一次。')
  }

  if (!response.ok) {
    const message = await readErrorMessage(response)
    if (message) throw new ImportError(message)
    if (response.status === 401 || response.status === 403) {
      throw new ImportError('這個功能目前無法使用。')
    }
    throw new ImportError('整理食譜時出了點問題，請稍後再試。')
  }

  try {
    return await response.json()
  } catch {
    throw new ImportError('整理食譜時出了點問題，請稍後再試。')
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error.trim() : ''
  } catch {
    return ''
  }
}

const MAX_QUERY_LENGTH = 60

/** AI 搜尋給的其中一種做法。 */
export interface RecipeOption {
  /** 做法名稱，例如「電鍋版」。 */
  label: string
  /** 一句話說明特色。 */
  summary: string
  recipe: Recipe
}

/**
 * 用一個菜名／關鍵字請後端的 AI 給出幾種不同做法，讓使用者挑一種。
 *
 * 這不是「抓 Google 搜尋最上面的 AI 回答」——那是 Google 網頁自己的介面
 * （AI Overview），沒有公開 API，爬蟲抓會違反服務條款且畫面隨時會改版。
 * 這裡改成同樣的最終體驗：打幾個字、AI 生出食譜、使用者確認後才存檔，
 * 只是 AI 直接憑自己的知識回答，不會真的去查最新的網路內容。
 */
export async function generateFromQuery(query: string): Promise<RecipeOption[]> {
  const trimmed = query.trim()
  if (!trimmed) throw new ImportError('請先輸入菜名，例如「番茄炒蛋」。')
  if (trimmed.length > MAX_QUERY_LENGTH) throw new ImportError('菜名太長了，簡短一點就好。')
  const payload = await postToService('/generate', { query: trimmed })
  const raw = (payload as { options?: unknown } | null)?.options
  // 模型輸出不可信：缺步驟的那種做法直接略過，不要讓整次搜尋因為一種壞掉就失敗。
  const options = (Array.isArray(raw) ? raw : [])
    .map((entry, n): RecipeOption | null => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      try {
        return {
          label: asString(e.label) || `做法 ${n + 1}`,
          summary: asString(e.summary),
          recipe: normalizeRecipe(e.recipe, trimmed, 'ai'),
        }
      } catch {
        return null
      }
    })
    .filter((x): x is RecipeOption => x !== null)
  if (!options.length) throw new ImportError('找不到這道菜的做法，換個說法試試看。')
  return options
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/**
 * 把後端回來的東西整理成合法的 Recipe。
 *
 * 這一層不能省：輸出來自語言模型，欄位可能缺漏、型別可能不對、步驟可能是
 * 字串陣列而不是物件陣列。與其讓眼鏡端渲染時炸開，不如在入口就收斂。
 */
export function normalizeRecipe(raw: unknown, sourceUrl: string, source: RecipeSource): Recipe {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const ingredients: Ingredient[] = Array.isArray(obj.ingredients)
    ? obj.ingredients
        .map((entry): Ingredient | null => {
          if (typeof entry === 'string') {
            const item = entry.trim()
            return item ? { id: newId(), item, amount: '' } : null
          }
          if (entry && typeof entry === 'object') {
            const e = entry as Record<string, unknown>
            const item = asString(e.item) || asString(e.name)
            if (!item) return null
            return { id: newId(), item, amount: asString(e.amount) || asString(e.quantity) }
          }
          return null
        })
        .filter((x): x is Ingredient => x !== null)
    : []

  const steps: Step[] = Array.isArray(obj.steps)
    ? obj.steps
        .map((entry): Step | null => {
          if (typeof entry === 'string') {
            const text = entry.trim()
            return text ? { id: newId(), text } : null
          }
          if (entry && typeof entry === 'object') {
            const e = entry as Record<string, unknown>
            const text = asString(e.text) || asString(e.instruction)
            if (!text) return null
            const step: Step = { id: newId(), text }
            const seconds = Number(e.timerSeconds)
            if (Number.isFinite(seconds) && seconds > 0) step.timerSeconds = Math.round(seconds)
            const tip = asString(e.tip)
            if (tip) step.tip = tip
            return step
          }
          return null
        })
        .filter((x): x is Step => x !== null)
    : []

  if (!steps.length) {
    throw new ImportError('這裡面找不到做菜的步驟，換一個試試看。')
  }

  const now = Date.now()
  return {
    id: newId(),
    name: asString(obj.name) || asString(obj.title) || '未命名食譜',
    servings: asPositiveInt(obj.servings, 2),
    totalMinutes: asPositiveInt(obj.totalMinutes, 30),
    difficulty: asDifficulty(obj.difficulty, steps.length),
    source,
    sourceUrl,
    ingredients,
    steps,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 模型給的難易度不一定是我們的三級之一，甚至可能沒給。
 * 退而求其次用步驟數推估 —— 比硬塞一個「中等」誠實。
 */
function asDifficulty(value: unknown, stepCount: number): Difficulty {
  const raw = asString(value).toLowerCase()
  if (raw === 'easy' || raw.includes('簡單') || raw.includes('容易')) return 'easy'
  if (raw === 'hard' || raw.includes('困難') || raw.includes('難')) return 'hard'
  if (raw === 'medium' || raw.includes('中等')) return 'medium'
  if (stepCount <= 5) return 'easy'
  if (stepCount >= 10) return 'hard'
  return 'medium'
}

export function emptyRecipe(): Recipe {
  const now = Date.now()
  return {
    id: newId(),
    name: '新食譜',
    servings: 2,
    totalMinutes: 30,
    difficulty: 'easy',
    source: 'manual',
    ingredients: [],
    steps: [{ id: newId(), text: '' }],
    createdAt: now,
    updatedAt: now,
  }
}
