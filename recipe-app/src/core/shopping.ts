import { newId } from './id'
import type { Recipe, ShoppingItem } from './types'

/**
 * 採購清單。
 *
 * 眼鏡的內建待辦清單無法由第三方 App 寫入 —— SDK 的 EvenAppMethod 只有
 * 畫面容器、儲存、音訊、IMU、定位與相簿相機，沒有任何筆記或待辦介面。
 * 所以清單自己存，再用既有的容器推到眼鏡上顯示，效果一樣而且不受制於人。
 */
export class ShoppingList {
  constructor(private readonly items: ShoppingItem[]) {}

  static from(raw: unknown): ShoppingList {
    return new ShoppingList(Array.isArray(raw) ? (raw as ShoppingItem[]) : [])
  }

  get all(): ShoppingItem[] {
    // 未買的排前面，其餘照加入順序，逛超市時不用一直跳著看。
    return [...this.items].sort(
      (a, b) => Number(a.checked) - Number(b.checked) || a.addedAt - b.addedAt,
    )
  }

  get pending(): ShoppingItem[] {
    return this.all.filter(i => !i.checked)
  }

  get raw(): ShoppingItem[] {
    return this.items
  }

  /**
   * 把一份食譜的食材併進清單。
   *
   * 份量是自由文字（「少許」「3-4 個」）沒辦法數值相加，所以同名食材
   * 不覆蓋也不硬加，而是各自保留一筆需求與出處，讓使用者自己判斷。
   * 同一份食譜重複加入則不會重複累積。
   */
  addRecipe(recipe: Recipe): number {
    let added = 0
    for (const ing of recipe.ingredients) {
      const item = ing.item.trim()
      if (!item) continue
      const need = { amount: ing.amount.trim(), from: recipe.name }
      const existing = this.items.find(i => i.item === item)
      if (existing) {
        const dup = existing.needs.some(n => n.from === need.from && n.amount === need.amount)
        if (!dup) {
          existing.needs.push(need)
          added++
        }
        // 重新加入代表又要買了，把已勾掉的復原。
        existing.checked = false
      } else {
        this.items.push({
          id: newId(),
          item,
          needs: [need],
          checked: false,
          addedAt: Date.now() + this.items.length,
        })
        added++
      }
    }
    return added
  }

  addManual(item: string): boolean {
    const name = item.trim()
    if (!name) return false
    const existing = this.items.find(i => i.item === name)
    if (existing) {
      existing.checked = false
      return false
    }
    this.items.push({
      id: newId(),
      item: name,
      needs: [],
      checked: false,
      addedAt: Date.now() + this.items.length,
    })
    return true
  }

  toggle(id: string): void {
    const found = this.items.find(i => i.id === id)
    if (found) found.checked = !found.checked
  }

  remove(id: string): void {
    const at = this.items.findIndex(i => i.id === id)
    if (at >= 0) this.items.splice(at, 1)
  }

  clearChecked(): number {
    const before = this.items.length
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].checked) this.items.splice(i, 1)
    }
    return before - this.items.length
  }

  clearAll(): void {
    this.items.length = 0
  }

  /** 眼鏡端一行一項。已買的加刪除線符號，未買的留白。 */
  toGlassesLines(): string[] {
    return this.all.map(i => {
      const amounts = i.needs.map(n => n.amount).filter(Boolean)
      const detail = amounts.length ? `  ${[...new Set(amounts)].join(' / ')}` : ''
      return `${i.checked ? '■' : '□'} ${i.item}${detail}`
    })
  }
}
