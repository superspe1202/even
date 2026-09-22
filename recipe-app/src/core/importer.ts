import { newId } from './id'
import type { Difficulty, Ingredient, Recipe, RecipeSource, Step } from './types'

/**
 * 解析服務的位置。打包時由 Vite 以 `VITE_API_BASE` 注入；
 * 這個網域也必須列在 app.json 的 network whitelist 裡，否則會被 Even 擋下。
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

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
 * 把網頁或 YouTube 連結送到後端解析成食譜。
 *
 * 抓取與 AI 呼叫都在後端做，原因有二：金鑰不能放進 .ehpk（任何人都能解壓縮），
 * 以及 WebView 的 CORS 會擋掉絕大多數第三方網站。
 */
export async function importFromUrl(url: string): Promise<Recipe> {
  if (!API_BASE) {
    throw new ImportError('尚未設定解析服務位置（VITE_API_BASE），請見 worker/README.md')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ImportError('網址格式不正確')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImportError('只支援 http / https 連結')
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch {
    // CORS 失敗與斷線在 fetch 看起來一樣，所以訊息兩種都提。
    throw new ImportError('無法連線到解析服務，請確認網路與 app.json 白名單設定')
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ImportError(`解析失敗（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }

  const payload = await response.json().catch(() => {
    throw new ImportError('解析服務回傳的不是有效 JSON')
  })

  return normalizeRecipe(payload, url, isYouTube(url) ? 'youtube' : 'web')
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
    throw new ImportError('沒有解析出任何步驟，這個連結可能不是食譜內容')
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
