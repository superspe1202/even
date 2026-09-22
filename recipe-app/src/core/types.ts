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

export type RecipeSource = 'manual' | 'web' | 'youtube'

export interface Recipe {
  id: string
  /** 眼鏡端標頭會顯示，超過會被裁切，建議 10 字內。 */
  name: string
  servings: number
  totalMinutes: number
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
  updatedAt: number
}

/** 上次烹飪到哪裡，重開 App 可以接著煮。 */
export interface CookingProgress {
  recipeId: string
  /** -1 代表食材總覽頁，0 以上是步驟索引。 */
  stepIndex: number
}
