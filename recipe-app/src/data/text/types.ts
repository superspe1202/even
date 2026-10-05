/** 一道內建食譜在某一種語言的全部文字。 */
export interface CatalogText {
  name: string
  /** 一句話簡介。 */
  summary: string
  /** [食材, 份量] */
  ing: [string, string][]
  /** 步驟文字，順序與 `CatalogBase.timers` 對齊。 */
  steps: string[]
  /** 某一步的小提醒，key 是步驟索引（0 起算）。 */
  tips?: Record<number, string>
}

export type CatalogTexts = Record<string, CatalogText>
