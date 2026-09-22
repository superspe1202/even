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
  constructor(private readonly bridge: StorageBridge) {}

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
    const progress = await this.getProgress()
    if (progress?.recipeId === id) await this.clearProgress()
  }

  async getProgress(): Promise<CookingProgress | null> {
    const raw = await this.bridge.getLocalStorage(PROGRESS_KEY)
    return parseJson<CookingProgress | null>(raw, null)
  }

  async setProgress(progress: CookingProgress): Promise<void> {
    await this.bridge.setLocalStorage(PROGRESS_KEY, JSON.stringify(progress))
  }

  async clearProgress(): Promise<void> {
    await this.bridge.setLocalStorage(PROGRESS_KEY, '')
  }
}
