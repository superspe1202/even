/** 食材項目。`amount` 是自由文字（「2 大匙」「約 300g」），不做單位解析。 */
export interface Ingredient {
  id: string
  item: string
  amount: string
}

/**
 * 一個烹飪步驟。`timerSeconds` 有值時，進入該步驟會自動起算倒數，
 * 離開步驟就停止 —— 使用者雙手髒的時候不需要任何額外操作。
 */
export interface Step {
  id: string
  text: string
  timerSeconds?: number
  tip?: string
}

export type RecipeSource = 'manual' | 'web' | 'youtube' | 'catalog'

/** 難易度。只有三級 —— 再細分使用者也分不出差別。 */
export type Difficulty = 'easy' | 'medium' | 'hard'

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '簡單',
  medium: '中等',
  hard: '困難',
}

/** 排序用的權重，讓「由簡到難」有明確順序。 */
export const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 }

export interface Recipe {
  id: string
  /** 眼鏡端標頭會顯示，超過會被裁切，建議 10 字內。 */
  name: string
  servings: number
  totalMinutes: number
  difficulty: Difficulty
  source: RecipeSource
  sourceUrl?: string
  ingredients: Ingredient[]
  steps: Step[]
  createdAt: number
  updatedAt: number
}

/** 食譜庫索引，只存輕量欄位，避免每次開 App 都反序列化全部內容。 */
export interface RecipeIndexEntry {
  id: string
  name: string
  stepCount: number
  totalMinutes: number
  difficulty: Difficulty
  updatedAt: number
}

/** 上次烹飪到哪裡，重開 App 可以接著煮。 */
export interface CookingProgress {
  recipeId: string
  /** -1 代表食材總覽頁，0 以上是步驟索引。 */
  stepIndex: number
}

/**
 * 採購清單的一項。
 *
 * 份量是自由文字（「少許」「3-4 個」），沒辦法數值相加，所以同一種食材
 * 來自不同食譜時各自保留一筆份量與出處，讓使用者自己判斷要買多少。
 */
export interface ShoppingItem {
  id: string
  item: string
  /** 每一筆 = 一份食譜的需求。 */
  needs: { amount: string; from: string }[]
  checked: boolean
  addedAt: number
}
