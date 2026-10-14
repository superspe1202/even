import type { Difficulty } from '../core/types'

/**
 * 內建食譜庫：不分語言的資料（地區、分類、難易度、時間、計時秒數）。
 *
 * 菜名、簡介、食材、步驟的文字另外放在 `data/text/<語言>.ts`，用 slug 對應。
 * 這樣加一種語言只要多一個文字檔，不必動這裡；加一道菜則是這裡加一筆、
 * 每個語言檔各加一段（`npm run check:i18n` 會檢查有沒有漏）。
 *
 * 使用者瀏覽後「加入我的食譜」才會複製一份（用當時的語言）到自己的食譜庫，
 * 之後隨意增刪改都不影響這裡的原始資料。
 */

export type Region = 'tw' | 'jp' | 'kr'
export type CatalogCategory = 'home' | 'noodle_rice' | 'soup' | 'snack' | 'cold'

export interface CatalogBase {
  slug: string
  region: Region
  category: CatalogCategory
  difficulty: Difficulty
  servings: number
  totalMinutes: number
  /** 每一步要等幾秒；0 代表這一步不用計時。長度等於步驟數。 */
  timers: number[]
}

export const CATALOG_BASE: CatalogBase[] = [
  { slug: 'tomato-egg', region: 'tw', category: 'home', difficulty: 'easy', servings: 2, totalMinutes: 15, timers: [0, 90, 300, 60, 0, 0] },
  { slug: 'scallion-omelette', region: 'tw', category: 'home', difficulty: 'easy', servings: 2, totalMinutes: 10, timers: [0, 120, 90, 30] },
  { slug: 'smashed-cucumber', region: 'tw', category: 'cold', difficulty: 'easy', servings: 3, totalMinutes: 20, timers: [0, 600, 0, 0, 900] },
  { slug: 'century-egg-tofu', region: 'tw', category: 'cold', difficulty: 'easy', servings: 2, totalMinutes: 10, timers: [0, 0, 0, 0] },
  { slug: 'garlic-water-spinach', region: 'tw', category: 'home', difficulty: 'easy', servings: 3, totalMinutes: 10, timers: [0, 0, 30, 60, 0] },
  { slug: 'radish-omelette', region: 'tw', category: 'home', difficulty: 'easy', servings: 3, totalMinutes: 15, timers: [600, 0, 180, 0, 180, 120] },
  { slug: 'clam-luffa', region: 'tw', category: 'home', difficulty: 'easy', servings: 3, totalMinutes: 20, timers: [1800, 0, 45, 180, 240, 0] },
  { slug: 'basil-eggplant', region: 'tw', category: 'home', difficulty: 'medium', servings: 3, totalMinutes: 25, timers: [0, 60, 0, 30, 120, 0] },
  { slug: 'three-cup-chicken', region: 'tw', category: 'home', difficulty: 'medium', servings: 4, totalMinutes: 35, timers: [0, 240, 60, 300, 90, 600, 120, 30] },
  { slug: 'braised-pork-rice', region: 'tw', category: 'noodle_rice', difficulty: 'medium', servings: 6, totalMinutes: 90, timers: [0, 0, 600, 180, 120, 0, 3600, 600] },
  { slug: 'sesame-oil-chicken', region: 'tw', category: 'soup', difficulty: 'medium', servings: 4, totalMinutes: 40, timers: [0, 300, 300, 0, 1200, 180] },
  { slug: 'hakka-stir-fry', region: 'tw', category: 'home', difficulty: 'medium', servings: 4, totalMinutes: 30, timers: [1800, 0, 300, 180, 120, 60, 45] },
  { slug: 'scallion-beef', region: 'tw', category: 'home', difficulty: 'medium', servings: 3, totalMinutes: 25, timers: [900, 0, 0, 60, 45, 45, 0] },
  { slug: 'garlic-pork-slices', region: 'tw', category: 'cold', difficulty: 'medium', servings: 4, totalMinutes: 40, timers: [0, 1500, 600, 300, 0, 0] },
  { slug: 'popcorn-chicken', region: 'tw', category: 'snack', difficulty: 'medium', servings: 3, totalMinutes: 45, timers: [0, 1800, 300, 240, 180, 30, 0] },
  { slug: 'beef-noodle-soup', region: 'tw', category: 'noodle_rice', difficulty: 'hard', servings: 4, totalMinutes: 180, timers: [300, 0, 0, 300, 120, 180, 180, 0, 300, 9000, 240, 0] },
  { slug: 'pearl-meatballs', region: 'tw', category: 'snack', difficulty: 'hard', servings: 4, totalMinutes: 60, timers: [7200, 0, 0, 300, 1200, 0, 0, 0, 1500] },
  { slug: 'taro-rice-noodle-soup', region: 'tw', category: 'soup', difficulty: 'medium', servings: 4, totalMinutes: 45, timers: [0, 180, 120, 180, 300, 1200, 360, 0] },
  { slug: 'oyster-omelette', region: 'tw', category: 'snack', difficulty: 'medium', servings: 2, totalMinutes: 25, timers: [0, 90, 60, 120, 0] },
  { slug: 'oyster-vermicelli', region: 'tw', category: 'soup', difficulty: 'medium', servings: 4, totalMinutes: 40, timers: [0, 60, 180, 300, 60, 90, 0] },
  { slug: 'kuan-rou-rice', region: 'tw', category: 'noodle_rice', difficulty: 'medium', servings: 4, totalMinutes: 90, timers: [180, 300, 120, 0, 3600, 1200, 0] },
  { slug: 'fried-rice-noodles', region: 'tw', category: 'noodle_rice', difficulty: 'easy', servings: 4, totalMinutes: 30, timers: [600, 0, 180, 180, 60, 240] },
  { slug: 'hakka-salted-pork', region: 'tw', category: 'home', difficulty: 'medium', servings: 4, totalMinutes: 40, timers: [0, 0, 7200, 480, 0] },
  { slug: 'pan-fried-radish-cake', region: 'tw', category: 'snack', difficulty: 'medium', servings: 4, totalMinutes: 60, timers: [600, 0, 0, 0, 2400, 360] },
  { slug: 'gua-bao', region: 'tw', category: 'snack', difficulty: 'easy', servings: 4, totalMinutes: 25, timers: [0, 300, 480, 0] },
  { slug: 'ants-climbing-tree', region: 'tw', category: 'home', difficulty: 'easy', servings: 3, totalMinutes: 20, timers: [300, 180, 60, 0, 240, 0] },
  { slug: 'ginger-duck-hotpot', region: 'tw', category: 'soup', difficulty: 'hard', servings: 4, totalMinutes: 120, timers: [180, 600, 300, 120, 0, 5400, 600, 0] },
  { slug: 'buddha-jumps-over-wall', region: 'tw', category: 'soup', difficulty: 'hard', servings: 6, totalMinutes: 180, timers: [3600, 300, 300, 180, 0, 0, 7200, 0] },
  { slug: 'oyakodon', region: 'jp', category: 'noodle_rice', difficulty: 'easy', servings: 2, totalMinutes: 20, timers: [0, 0, 300, 45, 30, 0] },
  { slug: 'tonkatsu', region: 'jp', category: 'home', difficulty: 'medium', servings: 2, totalMinutes: 30, timers: [0, 0, 0, 240, 120, 180, 0] },
  { slug: 'miso-soup', region: 'jp', category: 'soup', difficulty: 'easy', servings: 2, totalMinutes: 20, timers: [600, 60, 120, 0, 0] },
  { slug: 'gyudon', region: 'jp', category: 'noodle_rice', difficulty: 'easy', servings: 2, totalMinutes: 20, timers: [0, 0, 300, 180, 0] },
  { slug: 'karaage', region: 'jp', category: 'snack', difficulty: 'medium', servings: 3, totalMinutes: 45, timers: [0, 1800, 0, 180, 180, 60, 0] },
  { slug: 'tamagoyaki', region: 'jp', category: 'home', difficulty: 'easy', servings: 2, totalMinutes: 15, timers: [0, 0, 0, 0, 60] },
  { slug: 'japanese-curry', region: 'jp', category: 'noodle_rice', difficulty: 'medium', servings: 4, totalMinutes: 60, timers: [0, 600, 180, 0, 1200, 0, 600] },
  { slug: 'nikujaga', region: 'jp', category: 'home', difficulty: 'medium', servings: 3, totalMinutes: 40, timers: [0, 120, 60, 0, 900, 600] },
  { slug: 'kimchi-jjigae', region: 'kr', category: 'soup', difficulty: 'medium', servings: 3, totalMinutes: 35, timers: [0, 300, 60, 900, 300, 0] },
  { slug: 'bibimbap', region: 'kr', category: 'noodle_rice', difficulty: 'medium', servings: 2, totalMinutes: 40, timers: [0, 60, 0, 180, 120, 0, 0] },
  { slug: 'bulgogi', region: 'kr', category: 'home', difficulty: 'medium', servings: 3, totalMinutes: 45, timers: [0, 0, 1800, 120, 120, 0] },
  { slug: 'tteokbokki', region: 'kr', category: 'snack', difficulty: 'easy', servings: 2, totalMinutes: 25, timers: [600, 0, 0, 480, 120] },
  { slug: 'japchae', region: 'kr', category: 'noodle_rice', difficulty: 'medium', servings: 4, totalMinutes: 60, timers: [1800, 0, 0, 0, 360, 120, 0] },
  { slug: 'kimchi-fried-rice', region: 'kr', category: 'noodle_rice', difficulty: 'easy', servings: 2, totalMinutes: 15, timers: [0, 180, 60, 180, 0] },
  { slug: 'pajeon', region: 'kr', category: 'snack', difficulty: 'easy', servings: 3, totalMinutes: 20, timers: [0, 0, 0, 240, 180, 0] },
  { slug: 'doenjang-jjigae', region: 'kr', category: 'soup', difficulty: 'easy', servings: 3, totalMinutes: 30, timers: [0, 600, 0, 300, 180, 120, 0] },
]
