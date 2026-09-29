import { CATALOG, type CatalogRecipe } from '../data/catalog'
import { newId } from './id'
import { DIFFICULTY_RANK, type Difficulty, type Recipe } from './types'

export type SortKey = 'difficulty' | 'time' | 'name'

export interface CatalogQuery {
  search: string
  /** 空集合代表不篩選。 */
  difficulties: Set<Difficulty>
  categories: Set<string>
  sort: SortKey
}

export function emptyQuery(): CatalogQuery {
  return { search: '', difficulties: new Set(), categories: new Set(), sort: 'difficulty' }
}

export const CATEGORIES = [...new Set(CATALOG.map(r => r.category))]

/**
 * 篩選並排序內建食譜。
 *
 * 搜尋同時比對名稱、簡介與食材 —— 使用者常常是「冰箱有絲瓜」而不是
 * 「我要做蛤蜊絲瓜」，只比對名稱會找不到。
 */
export function queryCatalog(query: CatalogQuery): CatalogRecipe[] {
  const needle = query.search.trim().toLowerCase()

  const matched = CATALOG.filter(recipe => {
    if (query.difficulties.size && !query.difficulties.has(recipe.difficulty)) return false
    if (query.categories.size && !query.categories.has(recipe.category)) return false
    if (!needle) return true
    const haystack = [
      recipe.name,
      recipe.summary,
      recipe.category,
      ...recipe.ingredients.map(i => i.item),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })

  const sorted = [...matched]
  switch (query.sort) {
    case 'time':
      sorted.sort((a, b) => a.totalMinutes - b.totalMinutes)
      break
    case 'name':
      // 中文要用 localeCompare 才會按筆劃/拼音排，直接比字碼是亂的。
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      break
    case 'difficulty':
      sorted.sort(
        (a, b) =>
          DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty] ||
          a.totalMinutes - b.totalMinutes,
      )
      break
  }
  return sorted
}

export function findCatalogRecipe(slug: string): CatalogRecipe | undefined {
  return CATALOG.find(r => r.slug === slug)
}

/**
 * 複製一份到使用者的食譜庫。
 *
 * 刻意深拷貝並重新產生所有 id：加入之後使用者怎麼改都不該回頭影響內建資料，
 * 同一道菜也可以加入兩次分別調整（例如一份加辣一份不加）。
 */
export function toRecipe(entry: CatalogRecipe): Recipe {
  const now = Date.now()
  return {
    id: newId(),
    name: entry.name,
    servings: entry.servings,
    totalMinutes: entry.totalMinutes,
    difficulty: entry.difficulty,
    source: 'catalog',
    ingredients: entry.ingredients.map(i => ({ id: newId(), item: i.item, amount: i.amount })),
    steps: entry.steps.map(s => ({
      id: newId(),
      text: s.text,
      ...(s.timerSeconds ? { timerSeconds: s.timerSeconds } : {}),
      ...(s.tip ? { tip: s.tip } : {}),
    })),
    createdAt: now,
    updatedAt: now,
  }
}
