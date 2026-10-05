import { CATALOG_BASE, type CatalogBase, type CatalogCategory, type Region } from '../data/catalog'
import { CATALOG_TEXTS, type CatalogText } from '../data/text'
import { getLang, t, type Lang } from '../i18n'
import { newId } from './id'
import { DIFFICULTY_RANK, type Difficulty, type Recipe } from './types'

export type { CatalogCategory, Region }
export type SortKey = 'difficulty' | 'time' | 'name'

export interface CatalogQuery {
  search: string
  /** 空集合代表不篩選。 */
  difficulties: Set<Difficulty>
  categories: Set<CatalogCategory>
  regions: Set<Region>
  sort: SortKey
}

export function emptyQuery(): CatalogQuery {
  return {
    search: '',
    difficulties: new Set(),
    categories: new Set(),
    regions: new Set(),
    sort: 'difficulty',
  }
}

export const REGIONS: Region[] = ['tw', 'jp', 'kr']
export const CATEGORIES: CatalogCategory[] = ['home', 'noodle_rice', 'soup', 'snack', 'cold']

export interface CatalogStep {
  text: string
  timerSeconds?: number
  tip?: string
}

/** 內建食譜在目前語言的樣子（資料 + 該語言的文字）。 */
export interface CatalogItem extends CatalogBase {
  name: string
  summary: string
  ingredients: { item: string; amount: string }[]
  steps: CatalogStep[]
}

/**
 * 某道菜某語言的文字。缺的話依序退到英文、繁體中文，
 * 所以新增一種語言可以只翻一部分，其餘暫時顯示英文。
 */
function textFor(slug: string, lang: Lang): CatalogText | undefined {
  return CATALOG_TEXTS[lang][slug] ?? CATALOG_TEXTS.en[slug] ?? CATALOG_TEXTS.zh[slug]
}

export function localize(base: CatalogBase, lang: Lang = getLang()): CatalogItem | null {
  const text = textFor(base.slug, lang)
  if (!text) return null
  return {
    ...base,
    name: text.name,
    summary: text.summary,
    ingredients: text.ing.map(([item, amount]) => ({ item, amount })),
    steps: text.steps.map((step, i) => ({
      text: step,
      ...(base.timers[i] ? { timerSeconds: base.timers[i] } : {}),
      ...(text.tips?.[i] ? { tip: text.tips[i] } : {}),
    })),
  }
}

function allItems(lang: Lang): CatalogItem[] {
  return CATALOG_BASE.map(b => localize(b, lang)).filter((x): x is CatalogItem => x !== null)
}

/**
 * 篩選並排序內建食譜（用目前的語言）。
 *
 * 搜尋同時比對名稱、簡介與食材，也比對英文名稱——使用者常常是「冰箱有絲瓜」
 * 而不是「我要做蛤蜊絲瓜」，也常用 kimchi、sushi 這種各國通用的名字找。
 */
export function queryCatalog(query: CatalogQuery, lang: Lang = getLang()): CatalogItem[] {
  const needle = query.search.trim().toLowerCase()

  const matched = allItems(lang).filter(recipe => {
    if (query.difficulties.size && !query.difficulties.has(recipe.difficulty)) return false
    if (query.categories.size && !query.categories.has(recipe.category)) return false
    if (query.regions.size && !query.regions.has(recipe.region)) return false
    if (!needle) return true
    const haystack = [
      recipe.name,
      CATALOG_TEXTS.en[recipe.slug]?.name ?? '',
      recipe.summary,
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
      // 要用 localeCompare 才會照該語言的排序規則（中文筆劃／拼音、日文五十音…），
      // 直接比字碼是亂的。
      sorted.sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-Hant' : lang))
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

export function findCatalogRecipe(slug: string, lang: Lang = getLang()): CatalogItem | undefined {
  const base = CATALOG_BASE.find(r => r.slug === slug)
  return base ? (localize(base, lang) ?? undefined) : undefined
}

export function categoryLabel(c: CatalogCategory): string {
  return t(`cat.${c}`)
}

export function regionLabel(r: Region): string {
  return t(`region.${r}`)
}

/**
 * 複製一份到使用者的食譜庫。
 *
 * 刻意深拷貝並重新產生所有 id：加入之後使用者怎麼改都不該回頭影響內建資料，
 * 同一道菜也可以加入兩次分別調整（例如一份加辣一份不加）。
 * 記下 `catalogSlug`，之後換語言瀏覽時才知道哪些菜已經加過。
 */
export function toRecipe(entry: CatalogItem): Recipe {
  const now = Date.now()
  return {
    id: newId(),
    name: entry.name,
    servings: entry.servings,
    totalMinutes: entry.totalMinutes,
    difficulty: entry.difficulty,
    source: 'catalog',
    catalogSlug: entry.slug,
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
