import { newId } from '../core/id'
import { ImportError, emptyRecipe, importFromUrl, isYouTube } from '../core/importer'
import type { RecipeStore } from '../core/storage'
import type { Recipe, RecipeIndexEntry } from '../core/types'

type Screen =
  | { name: 'library' }
  | { name: 'import' }
  | { name: 'editor'; recipe: Recipe; isNew: boolean }

export interface PhoneUiHooks {
  /** 使用者按下「開始烹飪」，把食譜推到眼鏡上。 */
  onCook: (recipe: Recipe) => Promise<void>
  /** 眼鏡端目前顯示的步驟，用來在手機上同步標示。 */
  cookingRecipeId: () => string | null
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/**
 * 手機端介面：食譜庫、URL 匯入、手動編輯。
 *
 * 刻意用最樸素的「重繪整頁 + 事件委派」寫法。這個畫面的互動很淺，
 * 引進框架換來的心智負擔比省下的多；而且 .ehpk 愈小、載入愈快。
 */
export class PhoneUi {
  private screen: Screen = { name: 'library' }
  private index: RecipeIndexEntry[] = []
  private busy = false
  private error = ''

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RecipeStore,
    private readonly hooks: PhoneUiHooks,
  ) {
    this.root.addEventListener('click', e => void this.onClick(e))
    this.root.addEventListener('input', e => this.onInput(e))
  }

  async start() {
    await this.refreshIndex()
  }

  private async refreshIndex() {
    this.index = await this.store.listIndex()
    this.render()
  }

  private go(screen: Screen) {
    this.screen = screen
    this.error = ''
    this.render()
    window.scrollTo(0, 0)
  }

  private fail(message: string) {
    this.error = message
    this.busy = false
    this.render()
  }

  // ---------- 事件 ----------

  private async onClick(event: Event) {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target) return
    const action = target.dataset.action!
    const id = target.dataset.id
    if (this.busy && action !== 'back') return

    switch (action) {
      case 'back':
        return this.go({ name: 'library' })
      case 'new-import':
        return this.go({ name: 'import' })
      case 'new-manual':
        return this.go({ name: 'editor', recipe: emptyRecipe(), isNew: true })
      case 'open':
        return this.openRecipe(id!)
      case 'run-import':
        return this.runImport()
      case 'save':
        return this.saveEditor()
      case 'delete':
        return this.deleteRecipe()
      case 'cook':
        return this.cook()
      case 'add-ingredient':
        return this.mutate(r => {
          r.ingredients.push({ id: newId(), item: '', amount: '' })
        })
      case 'del-ingredient':
        return this.mutate(r => {
          r.ingredients = r.ingredients.filter(i => i.id !== id)
        })
      case 'add-step':
        return this.mutate(r => {
          r.steps.push({ id: newId(), text: '' })
        })
      case 'del-step':
        return this.mutate(r => {
          r.steps = r.steps.filter(s => s.id !== id)
        })
      case 'move-step-up':
        return this.moveStep(id!, -1)
      case 'move-step-down':
        return this.moveStep(id!, 1)
    }
  }

  /**
   * 編輯中的輸入直接寫回記憶體中的 recipe，不重繪 ——
   * 重繪會讓輸入框失去焦點，中文輸入法打到一半就斷了。
   */
  private onInput(event: Event) {
    if (this.screen.name !== 'editor') return
    const el = event.target as HTMLInputElement | HTMLTextAreaElement
    const field = el.dataset.field
    if (!field) return
    const recipe = this.screen.recipe
    const id = el.dataset.id

    switch (field) {
      case 'name':
        recipe.name = el.value
        break
      case 'servings':
        recipe.servings = Math.max(1, Number(el.value) || 1)
        break
      case 'ingredient-item': {
        const it = recipe.ingredients.find(i => i.id === id)
        if (it) it.item = el.value
        break
      }
      case 'ingredient-amount': {
        const it = recipe.ingredients.find(i => i.id === id)
        if (it) it.amount = el.value
        break
      }
      case 'step-text': {
        const st = recipe.steps.find(s => s.id === id)
        if (st) st.text = el.value
        break
      }
      case 'step-timer': {
        const st = recipe.steps.find(s => s.id === id)
        if (!st) break
        const minutes = Number(el.value)
        // 空白或 0 代表這步不計時，要真的把欄位拿掉而不是存成 0。
        if (Number.isFinite(minutes) && minutes > 0) st.timerSeconds = Math.round(minutes * 60)
        else delete st.timerSeconds
        break
      }
    }
  }

  private mutate(fn: (recipe: Recipe) => void) {
    if (this.screen.name !== 'editor') return
    fn(this.screen.recipe)
    this.render()
  }

  private moveStep(id: string, delta: number) {
    this.mutate(r => {
      const at = r.steps.findIndex(s => s.id === id)
      const to = at + delta
      if (at < 0 || to < 0 || to >= r.steps.length) return
      const [step] = r.steps.splice(at, 1)
      r.steps.splice(to, 0, step)
    })
  }

  // ---------- 動作 ----------

  private async openRecipe(id: string) {
    const recipe = await this.store.get(id)
    if (!recipe) return this.fail('找不到這份食譜，可能已被刪除。')
    this.go({ name: 'editor', recipe, isNew: false })
  }

  private async runImport() {
    const input = this.root.querySelector<HTMLInputElement>('#url')
    const url = input?.value.trim() ?? ''
    if (!url) return this.fail('請先貼上網址。')

    this.busy = true
    this.error = ''
    this.render()
    try {
      const recipe = await importFromUrl(url)
      // 直接進編輯器而不是存檔：AI 解析難免有出入，讓使用者先過目再存。
      this.busy = false
      this.go({ name: 'editor', recipe, isNew: true })
    } catch (err) {
      this.fail(err instanceof ImportError ? err.message : '匯入失敗，請稍後再試。')
    }
  }

  private async saveEditor() {
    if (this.screen.name !== 'editor') return
    const recipe = this.screen.recipe
    recipe.name = recipe.name.trim() || '未命名食譜'
    recipe.ingredients = recipe.ingredients.filter(i => i.item.trim())
    recipe.steps = recipe.steps.filter(s => s.text.trim())
    if (!recipe.steps.length) return this.fail('至少要有一個步驟才能儲存。')

    this.busy = true
    this.render()
    await this.store.save(recipe)
    this.busy = false
    await this.refreshIndex()
    this.go({ name: 'library' })
  }

  private async deleteRecipe() {
    if (this.screen.name !== 'editor') return
    const recipe = this.screen.recipe
    if (!window.confirm(`確定要刪除「${recipe.name}」？這個動作無法復原。`)) return
    await this.store.remove(recipe.id)
    await this.refreshIndex()
    this.go({ name: 'library' })
  }

  private async cook() {
    if (this.screen.name !== 'editor') return
    const recipe = this.screen.recipe
    if (!recipe.steps.some(s => s.text.trim())) return this.fail('食譜沒有步驟，無法開始。')
    this.busy = true
    this.render()
    try {
      await this.store.save(recipe)
      await this.hooks.onCook(recipe)
      this.busy = false
      await this.refreshIndex()
      this.go({ name: 'library' })
    } catch {
      this.fail('無法推送到眼鏡，請確認眼鏡已連線。')
    }
  }

  // ---------- 畫面 ----------

  private render() {
    const body =
      this.screen.name === 'library'
        ? this.library()
        : this.screen.name === 'import'
          ? this.importScreen()
          : this.editor(this.screen.recipe, this.screen.isNew)
    this.root.innerHTML = (this.error ? `<div class="error">${esc(this.error)}</div>` : '') + body
  }

  private library(): string {
    const cooking = this.hooks.cookingRecipeId()
    const cards = this.index
      .map(
        e => `
        <div class="card tappable" data-action="open" data-id="${esc(e.id)}">
          <div class="between">
            <div class="grow">
              <div style="font-weight:500">${esc(e.name)}</div>
              <div class="caption">${e.stepCount} 個步驟</div>
            </div>
            ${e.id === cooking ? '<span class="badge">烹飪中</span>' : ''}
          </div>
        </div>`,
      )
      .join('')

    return `
      <div class="between" style="margin-bottom:24px">
        <h1>食譜庫</h1>
        <span class="caption">${this.index.length} 份</span>
      </div>
      ${cards || '<div class="empty">還沒有食譜。<br>從網頁或 YouTube 匯入，或手動新增。</div>'}
      <div class="sticky-actions">
        <button class="primary grow" data-action="new-import">匯入連結</button>
        <button class="grow" data-action="new-manual">手動新增</button>
      </div>`
  }

  private importScreen(): string {
    return `
      <div class="between" style="margin-bottom:24px">
        <h1>匯入食譜</h1>
        <button data-action="back">返回</button>
      </div>
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">網頁或 YouTube 連結</div>
          <input id="url" type="url" inputmode="url" placeholder="https://..." ${
            this.busy ? 'disabled' : ''
          } />
        </div>
        <button class="primary" data-action="run-import" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '解析中…' : '開始解析'}
        </button>
        <p class="caption">
          解析會把連結送到你自己的解析服務，由它抓取內容並整理成步驟與食材。
          YouTube 影片需要有字幕才能解析。解析結果會先進入編輯畫面，確認無誤再儲存。
        </p>
      </div>`
  }

  private editor(recipe: Recipe, isNew: boolean): string {
    const ingredients = recipe.ingredients
      .map(
        i => `
        <div class="row" data-id="${esc(i.id)}">
          <input class="grow" data-field="ingredient-item" data-id="${esc(i.id)}"
                 value="${esc(i.item)}" placeholder="食材" />
          <input style="width:34%" data-field="ingredient-amount" data-id="${esc(i.id)}"
                 value="${esc(i.amount)}" placeholder="份量" />
          <button class="danger icon" data-action="del-ingredient" data-id="${esc(i.id)}"
                  aria-label="刪除食材">✕</button>
        </div>`,
      )
      .join('')

    const steps = recipe.steps
      .map(
        (s, n) => `
        <div class="card">
          <div class="between" style="margin-bottom:8px">
            <span class="label">步驟 ${n + 1}</span>
            <div class="row">
              <button class="icon" data-action="move-step-up" data-id="${esc(s.id)}"
                      aria-label="上移">▲</button>
              <button class="icon" data-action="move-step-down" data-id="${esc(s.id)}"
                      aria-label="下移">▼</button>
              <button class="danger icon" data-action="del-step" data-id="${esc(s.id)}"
                      aria-label="刪除步驟">✕</button>
            </div>
          </div>
          <textarea data-field="step-text" data-id="${esc(s.id)}"
                    placeholder="這一步要做什麼？">${esc(s.text)}</textarea>
          <div class="row" style="margin-top:8px">
            <span class="caption">計時</span>
            <input style="width:88px" type="number" min="0" step="0.5" inputmode="decimal"
                   data-field="step-timer" data-id="${esc(s.id)}"
                   value="${s.timerSeconds ? s.timerSeconds / 60 : ''}" placeholder="—" />
            <span class="caption">分鐘（留空表示不計時）</span>
          </div>
        </div>`,
      )
      .join('')

    const sourceNote = recipe.sourceUrl
      ? `<p class="caption">來源：${isYouTube(recipe.sourceUrl) ? 'YouTube' : '網頁'} · ${esc(
          recipe.sourceUrl,
        )}</p>`
      : ''

    return `
      <div class="between" style="margin-bottom:24px">
        <h1>${isNew ? '新增食譜' : '編輯食譜'}</h1>
        <button data-action="back">返回</button>
      </div>
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">名稱（眼鏡上會顯示，建議 10 字內）</div>
          <input data-field="name" value="${esc(recipe.name)}" placeholder="食譜名稱" />
        </div>
        <div class="row">
          <span class="caption">份量</span>
          <input style="width:88px" type="number" min="1" inputmode="numeric"
                 data-field="servings" value="${recipe.servings}" />
          <span class="caption">人份</span>
        </div>
      </div>
      ${sourceNote}

      <h2>食材</h2>
      <div class="stack">
        ${ingredients || '<p class="caption">還沒有食材。</p>'}
        <button data-action="add-ingredient">新增食材</button>
      </div>

      <h2>步驟</h2>
      ${steps}
      <button data-action="add-step" style="width:100%">新增步驟</button>

      <div class="sticky-actions">
        <button class="primary grow" data-action="cook" ${this.busy ? 'disabled' : ''}>
          開始烹飪
        </button>
        <button data-action="save" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '儲存中…' : '儲存'}
        </button>
        ${isNew ? '' : '<button class="danger" data-action="delete">刪除</button>'}
      </div>`
  }
}
