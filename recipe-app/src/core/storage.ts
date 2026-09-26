import { ShoppingList } from './shopping'
import type { RunningTimer } from './timer'
import type { CookingProgress, Recipe, RecipeIndexEntry } from './types'

/**
 * 只取用到的兩個方法，避免和 SDK 的具體型別耦合。
 *
 * 一定要用 bridge 的 storage：Even App 的 Flutter WebView 裡，瀏覽器
 * `localStorage` 與 IndexedDB 在 App 重啟後可能整個消失。
 */
export interface StorageBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

const INDEX_KEY = 'rg.index'
const PROGRESS_KEY = 'rg.progress'
const SHOPPING_KEY = 'rg.shopping'
const TIMERS_KEY = 'rg.timers'
const RECIPE_PREFIX = 'rg.r.'
/** 單筆 value 太大有風險，長食譜切塊存。 */
const CHUNK_SIZE = 40_000

function chunkCountKey(id: string) {
  return `${RECIPE_PREFIX}${id}.n`
}
function chunkKey(id: string, i: number) {
  return `${RECIPE_PREFIX}${id}.${i}`
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    // 寫到一半被中斷的資料不該讓整個 App 打不開。
    console.warn('storage: 無法解析，已略過')
    return fallback
  }
}

export class RecipeStore {
  /**
   * 進度是「讀整份清單 → 改一筆 → 寫回去」，連續快速翻頁時兩次更新可能
   * 讀到同一份舊清單，後寫的把先寫的蓋掉。排成一列依序做就不會。
   */
  private progressQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly bridge: StorageBridge) {}

  private queueProgress(task: () => Promise<void>): Promise<void> {
    const run = this.progressQueue.then(task)
    this.progressQueue = run.catch(err => console.error('進度寫入失敗：', err))
    return run
  }

  async listIndex(): Promise<RecipeIndexEntry[]> {
    const raw = await this.bridge.getLocalStorage(INDEX_KEY)
    return parseJson<RecipeIndexEntry[]>(raw, [])
  }

  private async writeIndex(entries: RecipeIndexEntry[]) {
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    await this.bridge.setLocalStorage(INDEX_KEY, JSON.stringify(entries))
  }

  async get(id: string): Promise<Recipe | null> {
    const countRaw = await this.bridge.getLocalStorage(chunkCountKey(id))
    const count = Number(countRaw)
    if (!countRaw || !Number.isFinite(count) || count < 1) return null

    let json = ''
    for (let i = 0; i < count; i++) {
      json += await this.bridge.getLocalStorage(chunkKey(id, i))
    }
    return parseJson<Recipe | null>(json, null)
  }

  async save(recipe: Recipe): Promise<void> {
    recipe.updatedAt = Date.now()
    const json = JSON.stringify(recipe)
    const chunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE))

    // 先寫內容再寫塊數：中途失敗時塊數還是舊的，讀出來是舊版本而不是半截資料。
    for (let i = 0; i < chunks; i++) {
      await this.bridge.setLocalStorage(
        chunkKey(recipe.id, i),
        json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      )
    }
    await this.bridge.setLocalStorage(chunkCountKey(recipe.id), String(chunks))

    const index = await this.listIndex()
    const entry: RecipeIndexEntry = {
      id: recipe.id,
      name: recipe.name,
      stepCount: recipe.steps.length,
      totalMinutes: recipe.totalMinutes,
      difficulty: recipe.difficulty,
      updatedAt: recipe.updatedAt,
    }
    const at = index.findIndex(e => e.id === recipe.id)
    if (at >= 0) index[at] = entry
    else index.push(entry)
    await this.writeIndex(index)
  }

  async remove(id: string): Promise<void> {
    const countRaw = await this.bridge.getLocalStorage(chunkCountKey(id))
    const count = Number(countRaw) || 0
    // 先摘掉索引，這樣就算下面的清除中斷，食譜也不會再出現在清單裡。
    await this.writeIndex((await this.listIndex()).filter(e => e.id !== id))
    await this.bridge.setLocalStorage(chunkCountKey(id), '')
    for (let i = 0; i < count; i++) {
      await this.bridge.setLocalStorage(chunkKey(id, i), '')
    }
    await this.clearProgress(id)
  }

  /** 所有目前有進度的食譜，用來判斷「還有哪些食譜在煮」以支援切換。 */
  async listProgress(): Promise<CookingProgress[]> {
    const raw = await this.bridge.getLocalStorage(PROGRESS_KEY)
    const parsed = parseJson<unknown>(raw, [])
    return Array.isArray(parsed) ? (parsed as CookingProgress[]) : []
  }

  async getProgress(recipeId: string): Promise<CookingProgress | null> {
    return (await this.listProgress()).find(p => p.recipeId === recipeId) ?? null
  }

  /** 依 `recipeId` 更新或新增一筆，不影響其他食譜的進度。 */
  setProgress(progress: Omit<CookingProgress, 'updatedAt'>): Promise<void> {
    return this.queueProgress(async () => {
      const list = await this.listProgress()
      const entry: CookingProgress = { ...progress, updatedAt: Date.now() }
      const at = list.findIndex(p => p.recipeId === progress.recipeId)
      if (at >= 0) list[at] = entry
      else list.push(entry)
      await this.bridge.setLocalStorage(PROGRESS_KEY, JSON.stringify(list))
    })
  }

  clearProgress(recipeId: string): Promise<void> {
    return this.queueProgress(async () => {
      const list = (await this.listProgress()).filter(p => p.recipeId !== recipeId)
      await this.bridge.setLocalStorage(PROGRESS_KEY, JSON.stringify(list))
    })
  }

  async getTimers(): Promise<RunningTimer[]> {
    const parsed = parseJson<unknown>(await this.bridge.getLocalStorage(TIMERS_KEY), [])
    return Array.isArray(parsed) ? (parsed as RunningTimer[]) : []
  }

  async saveTimers(timers: RunningTimer[]): Promise<void> {
    await this.bridge.setLocalStorage(TIMERS_KEY, JSON.stringify(timers))
  }

  async getShoppingList(): Promise<ShoppingList> {
    const raw = await this.bridge.getLocalStorage(SHOPPING_KEY)
    return ShoppingList.from(parseJson<unknown>(raw, []))
  }

  async saveShoppingList(list: ShoppingList): Promise<void> {
    await this.bridge.setLocalStorage(SHOPPING_KEY, JSON.stringify(list.raw))
  }
}
