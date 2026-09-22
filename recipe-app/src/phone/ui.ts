import {
  CATEGORIES,
  emptyQuery,
  findCatalogRecipe,
  queryCatalog,
  toRecipe,
  type CatalogQuery,
  type SortKey,
} from '../core/catalog'
import { newId } from '../core/id'
import { ImportError, emptyRecipe, importFromUrl, isYouTube } from '../core/importer'
import type { ShoppingList } from '../core/shopping'
import type { RecipeStore } from '../core/storage'
import {
  DIFFICULTY_LABEL,
  type Difficulty,
  type Recipe,
  type RecipeIndexEntry,
} from '../core/types'

type Screen =
  | { name: 'library' }
  | { name: 'catalog' }
  | { name: 'import' }
  | { name: 'shopping' }
  | { name: 'detail'; recipe: Recipe }
  | { name: 'editor'; recipe: Recipe; isNew: boolean }

export interface PhoneUiHooks {
  /** 把食譜推到眼鏡上開始烹飪。 */
  onCook: (recipe: Recipe) => Promise<void>
  /** 把採購清單推到眼鏡上顯示。 */
  onShowShopping: (lines: string[]) => Promise<void>
  cookingRecipeId: () => string | null
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'difficulty', label: '由簡到難' },
  { key: 'time', label: '時間最短' },
  { key: 'name', label: '名稱' },
]

const icon = {
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6h15l-1.5 9h-12z"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M6 6L5 2H2"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
}

/**
 * 手機端介面。
 *
 * 刻意用「重繪整頁 + 事件委派」的樸素寫法：互動很淺，引進框架換來的
 * 心智負擔比省下的多，而且 .ehpk 愈小載入愈快。唯一的例外是編輯中的
 * 輸入不重繪 —— 重繪會讓輸入框失焦，中文輸入法打到一半就斷了。
 */
export class PhoneUi {
  private screen: Screen = { name: 'library' }
  private index: RecipeIndexEntry[] = []
  private shopping!: ShoppingList
  private query: CatalogQuery = emptyQuery()
  private busy = false
  private error = ''
  private toast = ''

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RecipeStore,
    private readonly hooks: PhoneUiHooks,
  ) {
    this.root.addEventListener('click', e => void this.onClick(e))
    this.root.addEventListener('input', e => this.onInput(e))
    this.root.addEventListener('change', e => void this.onChange(e))
  }

  async start() {
    this.shopping = await this.store.getShoppingList()
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

  private flash(message: string) {
    this.toast = message
    this.render()
    window.setTimeout(() => {
      if (this.toast === message) {
        this.toast = ''
        this.render()
      }
    }, 2200)
  }

  // ---------- 事件 ----------

  private async onClick(event: Event) {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!el) return
    const action = el.dataset.action!
    const id = el.dataset.id
    if (this.busy && action !== 'back') return

    switch (action) {
      case 'back':
        return this.go({ name: 'library' })
      case 'go-catalog':
        return this.go({ name: 'catalog' })
      case 'go-import':
        return this.go({ name: 'import' })
      case 'go-shopping':
        return this.go({ name: 'shopping' })
      case 'new-manual':
        return this.go({ name: 'editor', recipe: emptyRecipe(), isNew: true })
      case 'open':
        return this.openRecipe(id!)
      case 'edit':
        if (this.screen.name === 'detail') {
          return this.go({ name: 'editor', recipe: this.screen.recipe, isNew: false })
        }
        return
      case 'add-from-catalog':
        return this.addFromCatalog(id!)
      case 'toggle-difficulty':
        return this.toggleSet(this.query.difficulties, id!)
      case 'toggle-category':
        return this.toggleSet(this.query.categories, id!)
      case 'clear-filters':
        this.query = emptyQuery()
        return this.render()
      case 'run-import':
        return this.runImport()
      case 'save':
        return this.saveEditor()
      case 'delete':
        return this.deleteRecipe()
      case 'cook':
        return this.cook()
      case 'add-to-shopping':
        return this.addToShopping()
      case 'show-shopping-on-glasses':
        return this.showShoppingOnGlasses()
      case 'shopping-toggle':
        this.shopping.toggle(id!)
        return this.persistShopping()
      case 'shopping-remove':
        this.shopping.remove(id!)
        return this.persistShopping()
      case 'shopping-add-manual':
        return this.addManualShoppingItem()
      case 'shopping-clear-checked': {
        const n = this.shopping.clearChecked()
        await this.persistShopping()
        return n ? this.flash(`清掉 ${n} 項已買的`) : undefined
      }
      case 'shopping-clear-all':
        if (!window.confirm('清空整份採購清單？這個動作無法復原。')) return
        this.shopping.clearAll()
        return this.persistShopping()
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

  private toggleSet(set: Set<string>, value: string) {
    if (set.has(value)) set.delete(value)
    else set.add(value)
    this.render()
  }

  /** select 元素的變更（排序、難易度）走 change 而不是 input。 */
  private async onChange(event: Event) {
    const el = event.target as HTMLSelectElement
    if (el.dataset.field === 'sort') {
      this.query.sort = el.value as SortKey
      this.render()
      return
    }
    if (el.dataset.field === 'difficulty' && this.screen.name === 'editor') {
      this.screen.recipe.difficulty = el.value as Difficulty
    }
  }

  private onInput(event: Event) {
    const el = event.target as HTMLInputElement | HTMLTextAreaElement
    const field = el.dataset.field
    if (!field) return

    if (field === 'catalog-search') {
      this.query.search = el.value
      // 只重繪結果列，避免搜尋框失焦。
      this.renderCatalogResults()
      return
    }
    if (this.screen.name !== 'editor') return

    const recipe = this.screen.recipe
    const id = el.dataset.id
    switch (field) {
      case 'name':
        recipe.name = el.value
        break
      case 'servings':
        recipe.servings = Math.max(1, Number(el.value) || 1)
        break
      case 'minutes':
        recipe.totalMinutes = Math.max(1, Number(el.value) || 1)
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
        // 空白或 0 代表不計時，要真的移除欄位而不是存成 0。
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
    this.go({ name: 'detail', recipe })
  }

  private async addFromCatalog(slug: string) {
    const entry = findCatalogRecipe(slug)
    if (!entry) return this.fail('找不到這道菜。')
    const recipe = toRecipe(entry)
    await this.store.save(recipe)
    this.index = await this.store.listIndex()
    this.flash(`已加入「${recipe.name}」`)
  }

  private async persistShopping() {
    await this.store.saveShoppingList(this.shopping)
    this.render()
  }

  private async addToShopping() {
    if (this.screen.name !== 'detail') return
    const added = this.shopping.addRecipe(this.screen.recipe)
    await this.store.saveShoppingList(this.shopping)
    this.flash(added ? `加入 ${added} 項食材` : '這些食材都已經在清單裡了')
  }

  private async addManualShoppingItem() {
    const input = this.root.querySelector<HTMLInputElement>('#newItem')
    const value = input?.value ?? ''
    if (!this.shopping.addManual(value)) {
      if (value.trim()) this.flash('清單裡已經有這一項了')
      return
    }
    if (input) input.value = ''
    await this.persistShopping()
  }

  private async showShoppingOnGlasses() {
    const lines = this.shopping.toGlassesLines()
    this.busy = true
    this.render()
    try {
      await this.hooks.onShowShopping(lines)
      this.busy = false
      this.flash('已顯示在眼鏡上')
    } catch {
      this.fail('無法推送到眼鏡，請確認眼鏡已連線。')
    }
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
      this.busy = false
      // 直接進編輯器：AI 解析難免有出入，讓使用者先過目再存。
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
    this.go({ name: 'detail', recipe })
  }

  private async deleteRecipe() {
    if (this.screen.name !== 'detail') return
    const recipe = this.screen.recipe
    if (!window.confirm(`確定要刪除「${recipe.name}」？這個動作無法復原。`)) return
    await this.store.remove(recipe.id)
    await this.refreshIndex()
    this.go({ name: 'library' })
  }

  private async cook() {
    if (this.screen.name !== 'detail') return
    const recipe = this.screen.recipe
    this.busy = true
    this.render()
    try {
      await this.hooks.onCook(recipe)
      this.busy = false
      this.render()
    } catch {
      this.fail('無法推送到眼鏡，請確認眼鏡已連線。')
    }
  }

  // ---------- 畫面 ----------

  private render() {
    const banner =
      (this.error ? `<div class="error">${esc(this.error)}</div>` : '') +
      (this.toast ? `<div class="toast">${esc(this.toast)}</div>` : '')

    const body =
      this.screen.name === 'library'
        ? this.library()
        : this.screen.name === 'catalog'
          ? this.catalog()
          : this.screen.name === 'import'
            ? this.importScreen()
            : this.screen.name === 'shopping'
              ? this.shoppingScreen()
              : this.screen.name === 'detail'
                ? this.detail(this.screen.recipe)
                : this.editor(this.screen.recipe, this.screen.isNew)
    this.root.innerHTML = banner + body
  }

  private topBar(title: string, right = ''): string {
    return `
      <div class="between" style="margin-bottom:20px">
        <div class="row">
          <button class="icon ghost" data-action="back" aria-label="返回">${icon.back}</button>
          <h1>${esc(title)}</h1>
        </div>
        ${right}
      </div>`
  }

  private library(): string {
    const cooking = this.hooks.cookingRecipeId()
    const pending = this.shopping.pending.length
    const rows = this.index
      .map(
        e => `
        <a class="card tappable row" data-action="open" data-id="${esc(e.id)}">
          <div class="grow">
            <div class="title-row">${esc(e.name)}</div>
            <div class="caption">${e.stepCount} 步驟 · ${e.totalMinutes} 分 · ${
              DIFFICULTY_LABEL[e.difficulty] ?? '—'
            }</div>
          </div>
          ${
            e.id === cooking
              ? '<span class="badge accent">烹飪中</span>'
              : `<span class="chev">${icon.chevron}</span>`
          }
        </a>`,
      )
      .join('')

    return `
      <div class="between" style="margin-bottom:20px">
        <h1>我的食譜</h1>
        <div class="row">
          <button class="icon ghost" data-action="go-shopping" aria-label="採購清單">
            ${icon.cart}${pending ? `<span class="dot">${pending}</span>` : ''}
          </button>
        </div>
      </div>
      ${
        rows ||
        '<div class="empty">還沒有食譜。<br>從精選台灣料理挑一道，或貼上連結匯入。</div>'
      }
      <div class="stack" style="margin-top:16px">
        <button class="primary" data-action="go-catalog">瀏覽精選台灣料理</button>
        <div class="row">
          <button class="grow" data-action="go-import">貼上連結</button>
          <button class="grow" data-action="new-manual">自己輸入</button>
        </div>
      </div>`
  }

  private catalog(): string {
    const chip = (label: string, active: boolean, action: string, id: string) =>
      `<button class="chip${active ? ' on' : ''}" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`

    const filters = `
      <div class="chips">
        ${DIFFICULTIES.map(d =>
          chip(DIFFICULTY_LABEL[d], this.query.difficulties.has(d), 'toggle-difficulty', d),
        ).join('')}
      </div>
      <div class="chips">
        ${CATEGORIES.map(c =>
          chip(c, this.query.categories.has(c), 'toggle-category', c),
        ).join('')}
      </div>`

    return `
      ${this.topBar('精選台灣料理')}
      <div class="stack">
        <input id="q" type="search" data-field="catalog-search" value="${esc(this.query.search)}"
               placeholder="搜尋菜名或食材，例如「絲瓜」" />
        ${filters}
        <div class="row">
          <label for="sort" class="caption">排序</label>
          <select id="sort" data-field="sort" class="grow">
            ${SORTS.map(
              s =>
                `<option value="${s.key}"${this.query.sort === s.key ? ' selected' : ''}>${s.label}</option>`,
            ).join('')}
          </select>
          <button class="ghost" data-action="clear-filters">清除</button>
        </div>
      </div>
      <div id="results">${this.catalogResults()}</div>`
  }

  private catalogResults(): string {
    const owned = new Set(this.index.map(e => e.name))
    const results = queryCatalog(this.query)
    if (!results.length) {
      return '<div class="empty">沒有符合的料理。<br>換個關鍵字或清除篩選。</div>'
    }
    return `
      <p class="caption" style="margin:18px 4px 10px">${results.length} 道</p>
      <div class="stack">
        ${results
          .map(
            r => `
          <div class="card">
            <div class="between" style="gap:12px">
              <div class="grow">
                <div class="title-row">${esc(r.name)}</div>
                <div class="caption" style="margin-top:2px">${esc(r.summary)}</div>
                <div class="caption" style="margin-top:6px">
                  ${esc(r.category)} · ${DIFFICULTY_LABEL[r.difficulty]} · ${r.totalMinutes} 分 · ${r.steps.length} 步驟
                </div>
              </div>
              <button class="${owned.has(r.name) ? 'ghost' : 'primary'} small"
                      data-action="add-from-catalog" data-id="${esc(r.slug)}">
                ${owned.has(r.name) ? '再加一份' : '加入'}
              </button>
            </div>
          </div>`,
          )
          .join('')}
      </div>`
  }

  /** 只換結果列，保留搜尋框的焦點與輸入法狀態。 */
  private renderCatalogResults() {
    const host = this.root.querySelector('#results')
    if (host) host.innerHTML = this.catalogResults()
  }

  private shoppingScreen(): string {
    const items = this.shopping.all
    const rows = items
      .map(
        i => `
        <div class="card row" style="gap:10px">
          <label class="row grow" style="gap:12px;cursor:pointer;min-width:0">
            <input type="checkbox" ${i.checked ? 'checked' : ''}
                   data-action="shopping-toggle" data-id="${esc(i.id)}"
                   aria-label="${esc(i.item)}" />
            <span class="grow" style="min-width:0">
              <span class="${i.checked ? 'struck' : ''}">${esc(i.item)}</span>
              ${
                i.needs.length
                  ? `<span class="caption block">${i.needs
                      .map(n => esc([n.amount, n.from].filter(Boolean).join(' · ')))
                      .join('　')}</span>`
                  : ''
              }
            </span>
          </label>
          <button class="icon danger" data-action="shopping-remove" data-id="${esc(i.id)}"
                  aria-label="移除 ${esc(i.item)}">${icon.close}</button>
        </div>`,
      )
      .join('')

    const checked = items.filter(i => i.checked).length
    return `
      ${this.topBar('採購清單')}
      <div class="row" style="margin-bottom:14px">
        <input id="newItem" type="text" class="grow" placeholder="自己加一項，例如「醬油」" />
        <button data-action="shopping-add-manual">加入</button>
      </div>
      ${rows || '<div class="empty">清單是空的。<br>到食譜頁按「加入採購清單」。</div>'}
      ${
        items.length
          ? `
      <div class="stack" style="margin-top:16px">
        <button class="primary" data-action="show-shopping-on-glasses" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '傳送中…' : '在眼鏡上顯示'}
        </button>
        <div class="row">
          <button class="grow" data-action="shopping-clear-checked" ${checked ? '' : 'disabled'}>
            清掉已買（${checked}）
          </button>
          <button class="grow danger" data-action="shopping-clear-all">全部清空</button>
        </div>
      </div>`
          : ''
      }`
  }

  private importScreen(): string {
    return `
      ${this.topBar('貼上連結')}
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">網頁或 YouTube 連結</div>
          <input id="url" type="url" inputmode="url" placeholder="https://" ${
            this.busy ? 'disabled' : ''
          } />
        </div>
        <button class="primary" data-action="run-import" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '解析中…' : '開始解析'}
        </button>
        <p class="caption">
          解析結果會先進入編輯畫面讓你確認，確認後才存進食譜庫。
          YouTube 影片需要有字幕才能解析。
        </p>
      </div>`
  }

  private detail(recipe: Recipe): string {
    const ingredients = recipe.ingredients
      .map(
        i => `
        <div class="row" style="padding:11px 0;border-bottom:1px solid var(--hairline)">
          <span class="grow">${esc(i.item)}</span>
          <span class="caption">${esc(i.amount)}</span>
        </div>`,
      )
      .join('')

    const steps = recipe.steps
      .map(
        (s, n) => `
        <div class="row" style="align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--hairline)">
          <span class="step-no">${n + 1}</span>
          <div class="grow">
            <div class="row" style="gap:8px">
              <span class="grow">${esc(s.text)}</span>
              ${s.timerSeconds ? `<span class="badge accent">${Math.round(s.timerSeconds / 60)} 分</span>` : ''}
            </div>
            ${s.tip ? `<div class="caption" style="margin-top:4px">${esc(s.tip)}</div>` : ''}
          </div>
        </div>`,
      )
      .join('')

    return `
      ${this.topBar(recipe.name, '<button class="ghost" data-action="edit">編輯</button>')}
      <button class="primary big" data-action="cook" ${this.busy ? 'disabled' : ''}>
        ${this.busy ? '傳送中…' : '開始烹飪'}
      </button>
      <p class="caption" style="margin:14px 2px">
        ${recipe.steps.length} 步驟 · 約 ${recipe.totalMinutes} 分 ·
        ${DIFFICULTY_LABEL[recipe.difficulty]} · ${recipe.servings} 人份
        ${recipe.sourceUrl ? `<br>來源：${isYouTube(recipe.sourceUrl) ? 'YouTube' : '網頁'}` : ''}
      </p>

      <h2>食材</h2>
      <div class="card">${ingredients || '<p class="caption">沒有食材。</p>'}</div>
      <button style="width:100%;margin-top:10px" data-action="add-to-shopping">加入採購清單</button>

      <h2>步驟</h2>
      <div class="card">${steps}</div>

      <button class="danger" style="width:100%;margin-top:22px" data-action="delete">刪除食譜</button>`
  }

  private editor(recipe: Recipe, isNew: boolean): string {
    const ingredients = recipe.ingredients
      .map(
        i => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--hairline)">
          <input class="bare grow" data-field="ingredient-item" data-id="${esc(i.id)}"
                 value="${esc(i.item)}" placeholder="食材" aria-label="食材名稱" />
          <input class="mini" data-field="ingredient-amount" data-id="${esc(i.id)}"
                 value="${esc(i.amount)}" placeholder="份量" aria-label="份量" />
          <button class="icon danger" data-action="del-ingredient" data-id="${esc(i.id)}"
                  aria-label="刪除 ${esc(i.item)}">${icon.close}</button>
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
              <button class="icon" data-action="move-step-up" data-id="${esc(s.id)}" aria-label="上移">${icon.up}</button>
              <button class="icon" data-action="move-step-down" data-id="${esc(s.id)}" aria-label="下移">${icon.down}</button>
              <button class="icon danger" data-action="del-step" data-id="${esc(s.id)}" aria-label="刪除步驟">${icon.close}</button>
            </div>
          </div>
          <textarea data-field="step-text" data-id="${esc(s.id)}"
                    aria-label="步驟 ${n + 1} 內容"
                    placeholder="這一步要做什麼？">${esc(s.text)}</textarea>
          <div class="row" style="margin-top:8px">
            <span class="caption">計時</span>
            <input class="mini" type="number" min="0" step="0.5" inputmode="decimal"
                   data-field="step-timer" data-id="${esc(s.id)}"
                   aria-label="步驟 ${n + 1} 計時分鐘"
                   value="${s.timerSeconds ? s.timerSeconds / 60 : ''}" placeholder="—" />
            <span class="caption">分鐘 · 留空不計時</span>
          </div>
        </div>`,
      )
      .join('')

    return `
      ${this.topBar(isNew ? '新增食譜' : '編輯食譜', `<button class="ghost" data-action="save" ${this.busy ? 'disabled' : ''}>${this.busy ? '儲存中…' : '儲存'}</button>`)}
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">名稱（眼鏡上會顯示，10 字內）</div>
          <input data-field="name" value="${esc(recipe.name)}" placeholder="食譜名稱" aria-label="食譜名稱" />
        </div>
        <div class="row">
          <label for="d" class="caption">難易度</label>
          <select id="d" data-field="difficulty" class="grow">
            ${DIFFICULTIES.map(
              d =>
                `<option value="${d}"${recipe.difficulty === d ? ' selected' : ''}>${DIFFICULTY_LABEL[d]}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="row">
          <label for="sv" class="caption">份量</label>
          <input id="sv" class="mini" type="number" min="1" inputmode="numeric"
                 data-field="servings" value="${recipe.servings}" />
          <span class="caption">人份</span>
          <label for="mn" class="caption" style="margin-left:8px">時間</label>
          <input id="mn" class="mini" type="number" min="1" inputmode="numeric"
                 data-field="minutes" value="${recipe.totalMinutes}" />
          <span class="caption">分</span>
        </div>
      </div>

      <h2>食材</h2>
      <div class="card">${ingredients || '<p class="caption">還沒有食材。</p>'}</div>
      <button style="width:100%;margin-top:10px" data-action="add-ingredient">新增食材</button>

      <h2>步驟</h2>
      <div class="stack">${steps}</div>
      <button style="width:100%;margin-top:10px" data-action="add-step">新增步驟</button>`
  }
}
