import {
  CATEGORIES,
  REGIONS,
  categoryLabel,
  emptyQuery,
  findCatalogRecipe,
  queryCatalog,
  regionLabel,
  toRecipe,
  type CatalogCategory,
  type CatalogQuery,
  type Region,
  type SortKey,
} from '../core/catalog'
import { newId } from '../core/id'
import {
  ImportError,
  ONLINE_IMPORT_ENABLED,
  type RecipeOption,
  emptyRecipe,
  generateFromQuery,
  importFromUrl,
  isYouTube,
} from '../core/importer'
import type { ShoppingList } from '../core/shopping'
import type { RecipeStore } from '../core/storage'
import { formatClock, formatDuration, remainingSeconds, timerKey } from '../core/timer'
import type { GlassesState } from '../glasses/runtime'
import {
  difficultyLabel,
  type Difficulty,
  type Recipe,
  type RecipeIndexEntry,
} from '../core/types'
import {
  LANG_CODES,
  LANG_NAMES,
  getLang,
  t,
  type LangSetting,
} from '../i18n'

type Screen =
  | { name: 'library' }
  | { name: 'catalog' }
  | { name: 'import' }
  | { name: 'search' }
  | { name: 'shopping' }
  | { name: 'events' }
  | { name: 'settings' }
  | { name: 'detail'; recipe: Recipe }
  | { name: 'editor'; recipe: Recipe; isNew: boolean }

/** 還沒煮完的一道菜，以及做到哪一步。 */
export interface ActiveDish {
  recipeId: string
  name: string
  /** 0 起算；-1 是食材頁。 */
  step: number
  stepTotal: number
}

export interface PhoneUiHooks {
  /** 把食譜推到眼鏡上開始烹飪；已經煮到一半就接續。「換到這道」也用這個。 */
  onCook: (recipe: Recipe) => Promise<void>
  /** 眼鏡直接跳到某道菜的某一步（不是眼鏡上那道就先換過去）。 */
  onJumpToStep: (recipe: Recipe, stepIndex: number) => Promise<void>
  onStartTimer: (recipe: Recipe, stepIndex: number) => void
  onDismissAlarm: () => void
  /** 眼鏡上的菜往前／往後一步（手機上的上一步、下一步、不用計時直接下一步）。 */
  onStepBy: (delta: number) => Promise<void>
  /** 步驟計時有沒有開。關掉時不提示、不倒數，點擊一律下一頁。 */
  timersEnabled: () => boolean
  onSetTimersEnabled: (on: boolean) => Promise<void>
  /** 使用者選的語言（`auto` 是跟著手機）、手機目前回報的語言標籤，以及改語言。 */
  languageSetting: () => Promise<LangSetting>
  phoneLanguage: () => string
  onSetLanguage: (lang: LangSetting) => Promise<void>
  /** 結束所有正在煮、煮到一半的菜，清掉全部計時，眼鏡回待命。 */
  onStopAll: () => Promise<void>
  /** 不煮了：清掉這道菜的進度與計時器；眼鏡正在顯示它就換到別道或回待命。 */
  onStopCooking: (recipeId: string) => Promise<void>
  /** 把採購清單推到眼鏡上顯示。 */
  onShowShopping: (lines: string[]) => Promise<void>
  glassesState: () => GlassesState
  cookingRecipeId: () => string | null
  /** 有進度、但目前沒有顯示在眼鏡上的菜——在眼鏡上長按或手機上按一下可以切過去。 */
  otherActiveDishes: () => ActiveDish[]
  /** 食譜被刪除時通知外層，清掉對應的進度追蹤。 */
  onRecipeDeleted: (id: string) => void
}

/** 「步驟 3/6」「食材」「完成」——跟眼鏡標頭同一種說法。 */
function stepLabel(step: number, stepTotal: number): string {
  if (step < 0) return t('step.ingredients')
  if (step >= stepTotal) return t('step.done')
  return t('step.of', { n: step + 1, total: stepTotal })
}

/**
 * 計時器：圖示＋「還剩」＋倒數。只寫「04:58」會被當成現在時間，
 * 所以一律包成這個樣子，一眼看得出是在倒數。
 */
function timerChip(endsAt: number): string {
  return `<span class="timer-chip">${icon.timer}<span>${t('u.timer.left')}</span>${countdown(endsAt)}</span>`
}

/** 倒數文字。手機每秒只改這些元素的文字，不整頁重繪，按鈕才不會按到一半消失。 */
function countdown(endsAt: number): string {
  return `<span class="countdown" data-ends="${endsAt}">${formatClock(
    remainingSeconds({ endsAt }, Date.now()),
  )}</span>`
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']
const SORT_KEYS: SortKey[] = ['difficulty', 'time', 'name']

const icon = {
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  cart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6h15l-1.5 9h-12z"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M6 6L5 2H2"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  book: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3"/><path d="M12 8.2c-1-1.4-3.2-.8-3.2 1 0 1.6 3.2 3.3 3.2 3.3s3.2-1.7 3.2-3.3c0-1.8-2.2-2.4-3.2-1z"/></svg>',
  sparkle: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  link: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  pencil: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  starOutline: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  stop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/></svg>',
  trash: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
  timer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2"/><path d="M9.5 2.5h5"/><path d="M12 2.5V6"/></svg>',
  gear: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
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
  /** 整頁重繪會清掉輸入框；失敗時要留著使用者打的字，不必重打。 */
  private draftUrl = ''
  private draftQuery = ''
  /** AI 搜尋給的幾種做法。挑了一種進編輯器後按返回，還能回來換另一種。 */
  private searchResults: RecipeOption[] = []
  private editorBaseline = ''
  /** 設定頁目前選的語言（`auto` 是跟著手機）。進設定頁時從儲存讀進來。 */
  private languageChoice: LangSetting = 'auto'
  /** 最近收到的眼鏡原始事件（新的在前），給「眼鏡訊號」頁排查手勢用。 */
  private glassesEvents: { at: number; json: string }[] = []
  /** 加了星號的食譜，排在食譜庫前面。 */
  private favorites = new Set<string>()
  /** 食譜庫左滑：正在拖的那一列，以及目前滑開的那一列。 */
  private swipe: { el: HTMLElement; x: number; y: number; dx: number; dragging: boolean; base: number } | null = null
  private swipeOpen: HTMLElement | null = null
  /** 剛拖完手指放開時瀏覽器還會補送一次 click，這段時間內不當成「打開食譜」。 */
  private swipeEndedAt = 0
  /** 食譜庫的搜尋字。食譜超過一個畫面才會出現搜尋框。 */
  private librarySearch = ''
  /** 上一次看到的「時間到」，換了新的才震動，同一個不重複震。 */
  private lastAlarmKey = ''

  constructor(
    private readonly root: HTMLElement,
    private readonly store: RecipeStore,
    private readonly hooks: PhoneUiHooks,
  ) {
    this.root.addEventListener('click', e => void this.onClick(e))
    this.root.addEventListener('input', e => this.onInput(e))
    this.root.addEventListener('change', e => void this.onChange(e))
    this.root.addEventListener('pointerdown', e => this.onSwipeStart(e))
    this.root.addEventListener('pointermove', e => this.onSwipeMove(e))
    this.root.addEventListener('pointerup', () => this.onSwipeEnd())
    this.root.addEventListener('pointercancel', () => this.onSwipeEnd(true))
    // 鍵盤打開時 iOS 會把整個文件往上推；收起後沒推回來，畫面就會錯位、底部內容點不到。
    // 我們的內容只在 #scroller 裡捲，文件本身永遠該在最上面。
    document.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0)
      }, 100)
    })
    // 倒數每秒走一格。只改數字，不動其他元素。
    window.setInterval(() => this.tickCountdowns(), 1000)
  }

  /**
   * 眼鏡狀態變了（翻頁、換菜、計時開始或到期、響鈴）時由外層呼叫。
   *
   * 食譜庫與詳情頁沒有輸入框，整頁重繪最簡單；其他畫面可能正在打字，
   * 只更新最上面的「時間到」橫幅，不去動輸入框。
   */
  syncFromGlasses() {
    const alarm = this.hooks.glassesState().alarm
    const key = alarm ? `${timerKey(alarm.recipeId, alarm.stepIndex)}@${alarm.endsAt}` : ''
    if (key && key !== this.lastAlarmKey) navigator.vibrate?.([400, 200, 400])
    this.lastAlarmKey = key

    if (this.screen.name === 'library' || this.screen.name === 'detail') this.render()
    else {
      const live = this.root.querySelector('#live')
      if (live) live.innerHTML = this.alarmHtml()
    }
  }

  /**
   * 語言換了：整個畫面照新語言重畫。
   *
   * 食譜庫的清單、加過的食譜名稱是使用者存下來的文字，不會變；變的是畫面上的
   * 標籤、按鈕、提示，以及「精選料理」裡內建食譜的名稱與內容。
   */
  relocalize() {
    this.error = ''
    this.searchResults = []
    this.render()
  }

  /** 外層每收到一個眼鏡事件就呼叫。只留最近 30 筆。 */
  logGlassesEvent(event: unknown) {
    let json: string
    try {
      json = JSON.stringify(event)
    } catch {
      json = String(event)
    }
    this.glassesEvents.unshift({ at: Date.now(), json })
    this.glassesEvents.length = Math.min(this.glassesEvents.length, 30)
    if (this.screen.name === 'events') this.render()
  }

  private tickCountdowns() {
    const now = Date.now()
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-ends]')) {
      const text = formatClock(remainingSeconds({ endsAt: Number(el.dataset.ends) }, now))
      if (el.textContent !== text) el.textContent = text
    }
  }

  async start() {
    this.shopping = await this.store.getShoppingList()
    this.favorites = new Set(await this.store.getFavorites())
    await this.refreshIndex()
  }

  private async refreshIndex() {
    this.index = await this.store.listIndex()
    this.render()
  }

  private go(screen: Screen) {
    this.screen = screen
    this.error = ''
    // 記下進編輯器時的樣子，按返回時才判斷得出有沒有改過、要不要提醒。
    if (screen.name === 'editor') this.editorBaseline = JSON.stringify(screen.recipe)
    this.render()
    // 捲動的是 #scroller（見 index.html），不是整個視窗。
    document.getElementById('scroller')?.scrollTo(0, 0)
  }

  private fail(message: string) {
    this.error = message
    this.busy = false
    this.render()
  }

  /**
   * 短暫提示。浮在畫面上方、不佔版面，出現和消失時內容不會跳動；
   * 也不整頁重繪，編輯到一半跳出提示不會打斷輸入。
   */
  private flash(message: string) {
    this.toast = message
    let el = document.querySelector<HTMLElement>('#toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'toast'
      el.setAttribute('role', 'status')
      document.body.appendChild(el)
    }
    el.textContent = message
    el.classList.add('show')
    window.setTimeout(() => {
      if (this.toast !== message) return
      this.toast = ''
      el!.classList.remove('show')
    }, 2200)
  }

  // ---------- 事件 ----------

  private async onClick(event: Event) {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!el) return
    // 手指剛拖完放開，瀏覽器補送的 click 不算數。
    if (Date.now() - this.swipeEndedAt < 350) return
    // 有一列滑開時，點那一列（不是按鈕）只是把它收回去，不打開食譜。
    if (this.swipeOpen && el.classList.contains('swipe-front')) {
      this.closeSwipe()
      return
    }
    const action = el.dataset.action!
    const id = el.dataset.id
    if (this.busy && action !== 'back') return

    switch (action) {
      case 'back':
        if (this.screen.name === 'editor') return this.leaveEditor()
        return this.go({ name: 'library' })
      case 'go-catalog':
        return this.go({ name: 'catalog' })
      case 'go-import':
        return this.go({ name: 'import' })
      case 'go-search':
        return this.go({ name: 'search' })
      case 'go-settings':
        this.languageChoice = await this.hooks.languageSetting()
        return this.go({ name: 'settings' })
      case 'set-language':
        this.languageChoice = id as LangSetting
        // 存起來並換語言；換語言會觸發 relocalize() 重畫整個畫面。
        await this.hooks.onSetLanguage(this.languageChoice)
        return
      case 'set-timers':
        await this.hooks.onSetTimersEnabled(id === 'ask')
        return this.render()
      case 'timers-off-from-ask':
        await this.hooks.onSetTimersEnabled(false)
        this.render()
        return this.flash(t('u.toast.timersOff'))
      case 'go-events':
        return this.go({ name: 'events' })
      case 'clear-events':
        this.glassesEvents = []
        return this.render()
      case 'go-shopping':
        return this.go({ name: 'shopping' })
      case 'new-manual':
        return this.go({ name: 'editor', recipe: emptyRecipe(), isNew: true })
      case 'open':
        return this.openRecipe(id!)
      case 'edit':
        if (this.screen.name === 'detail') {
          // 編輯複本：沒按儲存就離開，詳情頁看到的還是原本的內容。
          return this.go({
            name: 'editor',
            recipe: JSON.parse(JSON.stringify(this.screen.recipe)) as Recipe,
            isNew: false,
          })
        }
        return
      case 'add-from-catalog':
        return this.addFromCatalog(id!)
      case 'toggle-difficulty':
        return this.toggleSet(this.query.difficulties, id as Difficulty)
      case 'toggle-category':
        return this.toggleSet(this.query.categories, id as CatalogCategory)
      case 'toggle-region':
        return this.toggleSet(this.query.regions, id as Region)
      case 'clear-filters':
        this.query = emptyQuery()
        return this.render()
      case 'run-import':
        return this.runImport()
      case 'run-search':
        return this.runSearch()
      case 'pick-option': {
        const option = this.searchResults[Number(id)]
        // 給編輯器一份複本：改到一半按返回再換別的做法，原本那份不會被改掉。
        if (option) {
          this.go({ name: 'editor', recipe: JSON.parse(JSON.stringify(option.recipe)) as Recipe, isNew: true })
        }
        return
      }
      case 'save':
        return this.saveEditor()
      case 'delete':
        return this.deleteRecipe()
      case 'cook':
        return this.cook()
      case 'switch-to':
        return this.switchTo(id!)
      case 'jump-step':
        return this.jumpStep(Number(id))
      case 'start-timer':
        if (this.screen.name === 'detail') {
          this.hooks.onStartTimer(this.screen.recipe, Number(id))
        }
        return
      case 'toggle-fav':
        return this.toggleFavorite(id!)
      case 'delete-from-list':
        return this.deleteFromList(id!)
      case 'stop-all':
        return this.stopAll()
      case 'stop-cooking':
        if (this.screen.name !== 'detail') return
        return this.stopCooking(this.screen.recipe.id, this.screen.recipe.name)
      case 'stop-from-list': {
        const entry = this.index.find(e => e.id === id)
        return entry ? this.stopCooking(entry.id, entry.name) : undefined
      }
      case 'step-by':
        try {
          await this.hooks.onStepBy(Number(id))
        } catch {
          this.fail(t('e.send_glasses'))
        }
        return
      case 'scroll-current':
        this.root.querySelector(`#step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      case 'dismiss-alarm':
        return this.hooks.onDismissAlarm()
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
        return n ? this.flash(t('u.sh.cleared', { n })) : undefined
      }
      case 'shopping-clear-all':
        if (!window.confirm(t('u.sh.confirmClear'))) return
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

  private toggleSet<T>(set: Set<T>, value: T) {
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

    if (field === 'library-search') {
      this.librarySearch = el.value
      // 只換清單，搜尋框不重繪才不會失焦。
      const host = this.root.querySelector('#library-list')
      if (host) host.innerHTML = this.libraryList()
      return
    }
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
      case 'step-timer-min':
      case 'step-timer-sec': {
        const st = recipe.steps.find(s => s.id === id)
        if (!st) break
        const read = (f: string) => {
          const input = this.root.querySelector<HTMLInputElement>(
            `[data-field="${f}"][data-id="${CSS.escape(id ?? '')}"]`,
          )
          const n = Math.floor(Number(input?.value))
          return Number.isFinite(n) && n > 0 ? n : 0
        }
        const total = read('step-timer-min') * 60 + read('step-timer-sec')
        // 兩格都空白或 0 代表不計時，要真的移除欄位而不是存成 0。
        if (total > 0) st.timerSeconds = total
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
    if (!recipe) return this.fail(t('e.recipe_missing'))
    this.go({ name: 'detail', recipe })
  }

  private async addFromCatalog(slug: string) {
    const entry = findCatalogRecipe(slug)
    if (!entry) return this.fail(t('e.dish_missing'))
    const recipe = toRecipe(entry)
    await this.store.save(recipe)
    this.index = await this.store.listIndex()
    this.renderCatalogResults()
    this.flash(t('u.toast.added', { name: recipe.name }))
  }

  private async persistShopping() {
    await this.store.saveShoppingList(this.shopping)
    this.render()
  }

  private async addToShopping() {
    if (this.screen.name !== 'detail') return
    const added = this.shopping.addRecipe(this.screen.recipe)
    await this.store.saveShoppingList(this.shopping)
    this.flash(added ? t('u.sh.added', { n: added }) : t('u.sh.allIn'))
  }

  private async addManualShoppingItem() {
    const input = this.root.querySelector<HTMLInputElement>('#newItem')
    const value = input?.value ?? ''
    if (!this.shopping.addManual(value)) {
      if (value.trim()) this.flash(t('u.sh.dup'))
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
      this.flash(t('u.sh.shown'))
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  private async runImport() {
    const input = this.root.querySelector<HTMLInputElement>('#url')
    const url = input?.value.trim() ?? ''
    this.draftUrl = url
    if (!url) return this.fail(t('e.paste_url'))

    this.busy = true
    this.error = ''
    this.render()
    try {
      const recipe = await importFromUrl(url)
      this.busy = false
      this.draftUrl = ''
      // 直接進編輯器：AI 解析難免有出入，讓使用者先過目再存。
      this.go({ name: 'editor', recipe, isNew: true })
    } catch (err) {
      this.fail(err instanceof ImportError ? err.message : t('e.read_failed'))
    }
  }

  private async runSearch() {
    const input = this.root.querySelector<HTMLInputElement>('#query')
    const query = input?.value.trim() ?? ''
    this.draftQuery = query
    if (!query) return this.fail(t('e.search_empty'))

    this.busy = true
    this.error = ''
    this.searchResults = []
    this.render()
    try {
      this.searchResults = await generateFromQuery(query)
      this.busy = false
      // 先列出幾種做法讓使用者挑；挑了才進編輯器過目、確認後才存。
      this.render()
      // 結果在搜尋框下面，手機一個畫面放不下；捲過去讓使用者知道下面還有。
      this.root.querySelector('#options')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch (err) {
      this.fail(err instanceof ImportError ? err.message : t('e.generate_failed'))
    }
  }

  /** 編輯器按返回：有改過先確認；編輯既有的回到它的詳情頁，AI 挑的回到做法清單。 */
  private async leaveEditor() {
    if (this.screen.name !== 'editor') return
    const { recipe, isNew } = this.screen
    const changed = JSON.stringify(recipe) !== this.editorBaseline
    if (changed && !window.confirm(t('u.cf.leave'))) return
    if (!isNew) return this.openRecipe(recipe.id)
    // 從 AI 搜尋挑的做法還沒存就按返回：回到那幾種做法，方便換一種看看。
    if (recipe.source === 'ai' && this.searchResults.length) return this.go({ name: 'search' })
    this.go({ name: 'library' })
  }

  private async saveEditor() {
    if (this.screen.name !== 'editor') return
    const recipe = this.screen.recipe
    recipe.name = recipe.name.trim() || t('name.untitled')
    recipe.ingredients = recipe.ingredients.filter(i => i.item.trim())
    recipe.steps = recipe.steps.filter(s => s.text.trim())
    if (!recipe.steps.length) return this.fail(t('e.need_step'))

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
    if (!window.confirm(t('u.cf.delete', { name: recipe.name }))) return
    await this.store.remove(recipe.id)
    this.hooks.onRecipeDeleted(recipe.id)
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
      // 眼鏡上的變化手機這邊看不到，不回應一聲使用者會以為沒按到、一直重按。
      this.flash(t('u.toast.sent'))
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  /** 手機上按「換到這道」：眼鏡換過去，回到那道菜上次的那一步。 */
  private async switchTo(recipeId: string) {
    const recipe = await this.store.get(recipeId)
    if (!recipe) return
    try {
      await this.hooks.onCook(recipe)
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  // ---------- 食譜庫左滑 ----------

  /** 一列滑開時露出的寬度：每顆按鈕 76px，正在煮的菜多一顆「結束烹飪」。 */
  private static swipeWidth(front: HTMLElement): number {
    return Number(front.dataset.w) || 152
  }

  private onSwipeStart(e: PointerEvent) {
    const front = (e.target as HTMLElement).closest<HTMLElement>('.swipe-front')
    if (this.swipeOpen && this.swipeOpen !== front) this.closeSwipe()
    if (!front) return
    const base = front === this.swipeOpen ? -PhoneUi.swipeWidth(front) : 0
    this.swipe = { el: front, x: e.clientX, y: e.clientY, dx: 0, dragging: false, base }
  }

  private onSwipeMove(e: PointerEvent) {
    const s = this.swipe
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.dragging) {
      // 先判斷手指是在左右滑還是上下捲；上下就交給頁面捲動。
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        this.swipe = null
        return
      }
      if (Math.abs(dx) < 10) return
      s.dragging = true
      s.el.style.transition = 'none'
      // 底下的按鈕平常藏起來，不然圓角邊緣會透出一點紅色。
      s.el.parentElement?.classList.add('swiping')
    }
    s.dx = dx
    const offset = Math.min(0, Math.max(-PhoneUi.swipeWidth(s.el) - 24, s.base + dx))
    PhoneUi.setSwipe(s.el, offset)
  }

  private onSwipeEnd(cancelled = false) {
    const s = this.swipe
    this.swipe = null
    if (!s || !s.dragging) return
    this.swipeEndedAt = Date.now()
    const offset = s.base + s.dx
    const width = PhoneUi.swipeWidth(s.el)
    const open = !cancelled && offset < -width / 2
    s.el.style.transition = ''
    PhoneUi.setSwipe(s.el, open ? -width : 0)
    this.swipeOpen = open ? s.el : null
    if (!open) this.hideActionsLater(s.el)
  }

  private closeSwipe() {
    const el = this.swipeOpen
    this.swipeOpen = null
    if (!el) return
    PhoneUi.setSwipe(el, 0)
    this.hideActionsLater(el)
  }

  /**
   * 卡片右邊往左縮，而不是整張往左推：整張推的話左邊的菜名會被推出畫面，
   * 看不到自己正要刪的是哪一道。
   */
  private static setSwipe(front: HTMLElement, offset: number) {
    front.style.width = offset ? `calc(100% - ${-offset}px)` : ''
  }

  /** 等收回的動畫跑完再把底下的按鈕藏起來。 */
  private hideActionsLater(front: HTMLElement) {
    window.setTimeout(() => {
      if (this.swipeOpen !== front && this.swipe?.el !== front) {
        front.parentElement?.classList.remove('swiping')
      }
    }, 260)
  }

  private refreshLibraryList() {
    this.swipeOpen = null
    const host = this.root.querySelector('#library-list')
    if (host) host.innerHTML = this.libraryList()
    else this.render()
  }

  private async toggleFavorite(id: string) {
    const on = !this.favorites.has(id)
    if (on) this.favorites.add(id)
    else this.favorites.delete(id)
    await this.store.setFavorite(id, on)
    if (this.screen.name === 'library') this.refreshLibraryList()
    else this.render()
    this.flash(on ? t('u.toast.fav') : t('u.toast.unfav'))
  }

  private async deleteFromList(id: string) {
    const entry = this.index.find(e => e.id === id)
    if (!entry) return
    if (!window.confirm(t('u.cf.delete', { name: entry.name }))) {
      this.closeSwipe()
      return
    }
    await this.store.remove(id)
    this.favorites.delete(id)
    this.hooks.onRecipeDeleted(id)
    this.index = await this.store.listIndex()
    this.refreshLibraryList()
    this.flash(t('u.toast.deleted', { name: entry.name }))
  }

  private async stopAll() {
    const state = this.hooks.glassesState()
    const names = new Set<string>()
    if (state.mode === 'recipe') names.add(state.title)
    for (const d of this.hooks.otherActiveDishes()) names.add(d.name)
    const timerCount = state.timers.length
    const lines = [
      names.size
        ? t('u.cf.stopDishes', { n: names.size, names: [...names].join(t('list.sep')) })
        : '',
      timerCount ? t('u.cf.stopTimers', { n: timerCount }) : '',
      t('u.cf.stopNote'),
    ].filter(Boolean)
    if (!window.confirm(`${t('u.cf.stopAllTitle')}\n\n${lines.join('\n')}`)) return
    try {
      await this.hooks.onStopAll()
      this.flash(t('u.toast.stoppedAll'))
      this.render()
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  /** 結束單一道菜：詳情頁的按鈕和食譜庫左滑的「結束烹飪」都走這裡。 */
  private async stopCooking(id: string, name: string) {
    const hasTimers = this.hooks.glassesState().timers.some(t => t.recipeId === id)
    const ok = window.confirm(t(hasTimers ? 'u.cf.stopOneT' : 'u.cf.stopOne', { name }))
    if (!ok) {
      this.closeSwipe()
      return
    }
    try {
      await this.hooks.onStopCooking(id)
      this.flash(t('u.toast.stopped', { name }))
      this.render()
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  /** 詳情頁點某一步：眼鏡直接跳過去。畫面會隨眼鏡狀態自動更新，不必另外提示。 */
  private async jumpStep(stepIndex: number) {
    if (this.screen.name !== 'detail') return
    try {
      await this.hooks.onJumpToStep(this.screen.recipe, stepIndex)
    } catch {
      this.fail(t('e.send_glasses'))
    }
  }

  // ---------- 畫面 ----------

  private render() {
    // 整頁重繪會把正在打字的輸入框直接拿掉。iOS 的 WebView 在鍵盤開著、焦點元素
    // 被移除時，常會卡在「頁面捲不動」的狀態（實機上 AI 搜尋完再去精選料理就滑不動），
    // 所以重繪前先把焦點移開、讓鍵盤正常收起。
    const focused = document.activeElement
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.blur()
    // 重繪後原本滑開的那一列已經不在了。
    this.swipeOpen = null
    const banner = this.error ? `<div class="error">${esc(this.error)}</div>` : ''

    const body =
      this.screen.name === 'library'
        ? this.library()
        : this.screen.name === 'catalog'
          ? this.catalog()
          : this.screen.name === 'import'
            ? this.importScreen()
            : this.screen.name === 'search'
              ? this.searchScreen()
              : this.screen.name === 'shopping'
                ? this.shoppingScreen()
                : this.screen.name === 'events'
                  ? this.eventsScreen()
                  : this.screen.name === 'settings'
                    ? this.settingsScreen()
                : this.screen.name === 'detail'
                  ? this.detail(this.screen.recipe)
                : this.editor(this.screen.recipe, this.screen.isNew)
    this.root.innerHTML = `<div id="live">${this.alarmHtml()}</div>` + banner + body
  }

  /** 「時間到」橫幅。任何畫面都顯示，黏在最上面，眼鏡沒戴著也看得到。 */
  private alarmHtml(): string {
    const alarm = this.hooks.glassesState().alarm
    if (!alarm) return ''
    return `
      <div class="alarm row">
        <div class="grow">
          <div class="alarm-title">${t('u.alarm.title')}</div>
          <div>${esc(t('g.alarmWhereDish', { name: alarm.recipeName, n: alarm.stepIndex + 1 }))}</div>
          <div class="caption alarm-step">${esc(alarm.stepText)}</div>
        </div>
        <button class="small" data-action="dismiss-alarm">${t('u.alarm.ok')}</button>
      </div>`
  }

  /**
   * 「眼鏡上」面板：眼鏡現在顯示什麼、所有在跑的計時器、還有哪幾道菜可以
   * 換過去。沒在煮東西時整塊不出現。
   */
  private livePanel(viewing?: string): string {
    const state = this.hooks.glassesState()
    // 在某道菜的詳情頁時，那道菜自己的狀態頁面上方已經寫了，這裡不重複。
    const others = this.hooks.otherActiveDishes().filter(d => d.recipeId !== viewing)
    const showNow = state.mode !== 'idle' && state.recipeId !== viewing
    // 正在看的這道菜自己的計時，頁面上的步驟列與狀態卡已經顯示，這裡只列別道菜的。
    const timerList = state.timers.filter(t => t.recipeId !== viewing)
    if (!showNow && !timerList.length && !others.length) return ''

    const now = !showNow
      ? ''
      : state.mode === 'recipe' && state.recipeId
        ? `<a class="live-row tappable" data-action="open" data-id="${esc(state.recipeId)}">
             <span class="grow"><b>${esc(state.title)}</b> · ${stepLabel(state.step, state.stepTotal)}</span>
             <span class="chev">${icon.chevron}</span>
           </a>`
        : state.mode === 'shopping'
          ? `<div class="live-row"><b>${t('u.shopping')}</b></div>`
          : `<div class="live-row caption">${t('u.live.none')}</div>`

    const timers = timerList
      .map(
        timer => `
        <a class="live-row tappable" data-action="open" data-id="${esc(timer.recipeId)}">
          <span class="grow">${esc(t('g.alarmWhereDish', { name: timer.recipeName, n: timer.stepIndex + 1 }))}</span>
          ${timerChip(timer.endsAt)}
        </a>`,
      )
      .join('')

    const switches = others
      .map(
        d => `
        <button class="small switch" data-action="switch-to" data-id="${esc(d.recipeId)}">
          ${esc(t('u.live.switch', { name: d.name, step: stepLabel(d.step, d.stepTotal) }))}
        </button>`,
      )
      .join('')

    const cookingCount =
      (state.mode === 'recipe' ? 1 : 0) + this.hooks.otherActiveDishes().length
    const stopAll =
      viewing === undefined && (cookingCount > 0 || state.timers.length > 0)
        ? `<button class="stop" data-action="stop-all">${t('u.live.stopAll')}</button>`
        : ''

    return `
      <div class="card live">
        ${now ? `<div class="label">${t('u.live.glasses')}</div>${now}` : ''}
        ${timers ? `<div class="label"${now ? ' style="margin-top:10px"' : ''}>${t('u.live.timers')}</div>${timers}` : ''}
        ${
          switches
            ? `${now || timers ? `<div class="label" style="margin-top:12px">${t('u.live.also')}</div>` : `<div class="label">${t('u.live.also')}</div>`}
               <div class="stack" style="margin-top:8px;gap:8px">${switches}</div>`
            : ''
        }
        ${stopAll}
      </div>`
  }

  private topBar(title: string, right = ''): string {
    return `
      <div class="between" style="margin-bottom:20px">
        <div class="row">
          <button class="icon ghost" data-action="back" aria-label="${t('u.back')}">${icon.back}</button>
          <h1>${esc(title)}</h1>
        </div>
        ${right}
      </div>`
  }

  /** 食譜庫的清單本體。搜尋時只換這一塊，搜尋框不重繪，中文輸入法才不會被打斷。 */
  private libraryList(): string {
    const cooking = this.hooks.cookingRecipeId()
    const others = new Set(this.hooks.otherActiveDishes().map(d => d.recipeId))
    // 正在煮、煮到一半的排最前面：做菜時打開 App 最常要找的就是它們；
    // 接著是加了星號的。
    const rank = (id: string) =>
      id === cooking ? 0 : others.has(id) ? 1 : this.favorites.has(id) ? 2 : 3
    const entries = [...this.index].sort((a, b) => rank(a.id) - rank(b.id))
    const filter = this.librarySearch.trim()
    const shown = filter
      ? entries.filter(e => e.name.toLowerCase().includes(filter.toLowerCase()))
      : entries

    const rows = shown
      .map(e => {
        const fav = this.favorites.has(e.id)
        const cookingNow = e.id === cooking || others.has(e.id)
        return `
        <div class="swipe">
          <div class="swipe-actions">
            ${
              cookingNow
                ? `<button class="swipe-stop" data-action="stop-from-list" data-id="${esc(e.id)}">
                     ${icon.stop}<span>${t('u.stopCooking')}</span>
                   </button>`
                : ''
            }
            <button class="swipe-fav" data-action="toggle-fav" data-id="${esc(e.id)}">
              ${icon.starOutline}<span>${fav ? t('u.unstar') : t('u.star')}</span>
            </button>
            <button class="swipe-del" data-action="delete-from-list" data-id="${esc(e.id)}">
              ${icon.trash}<span>${t('u.delete')}</span>
            </button>
          </div>
        <a class="card tappable row swipe-front" data-action="open" data-id="${esc(e.id)}" data-w="${cookingNow ? 228 : 152}">
          <div class="grow">
            <div class="title-row">${fav ? `<span class="fav-star" aria-label="${t('u.starred')}">${icon.star}</span>` : ''}${esc(e.name)}</div>
            <div class="caption">${t('u.rowMeta', {
              n: e.stepCount,
              min: e.totalMinutes,
              diff: difficultyLabel(e.difficulty),
            })}</div>
          </div>
          ${
            e.id === cooking
              ? `<span class="badge accent">${t('u.cooking')}</span>`
              : others.has(e.id)
                ? `<span class="badge">${t('u.inProgress')}</span>`
                : `<span class="chev">${icon.chevron}</span>`
          }
        </a>
        </div>`
      })
      .join('')

    if (rows) {
      const anyCooking = shown.some(e => e.id === cooking || others.has(e.id))
      return `${rows}
        <div class="swipe-hint">
          <div><b>${t('u.swipeBold')}</b>${t('u.swipeRest')}</div>
          ${anyCooking ? `<div>${t('u.swipeCooking')}</div>` : ''}
        </div>`
    }
    if (filter) return `<div class="empty">${t('u.libNoMatch')}</div>`
    return `<div class="empty">${t('u.libEmpty')}</div>`
  }

  private library(): string {
    const pending = this.shopping.pending.length
    // 新增食譜的入口放在最上面、一排排開：食譜多了以後也不會被擠到畫面外找不到。
    const tiles = [
      { action: 'go-catalog', icon: icon.book, label: t('u.tile.catalog') },
      ...(ONLINE_IMPORT_ENABLED
        ? [
            { action: 'go-search', icon: icon.sparkle, label: t('u.tile.search') },
            { action: 'go-import', icon: icon.link, label: t('u.tile.import') },
          ]
        : []),
      { action: 'new-manual', icon: icon.pencil, label: t('u.tile.manual') },
    ]
      .map(
        tile => `
        <button class="tile" data-action="${tile.action}">
          ${tile.icon}<span>${tile.label}</span>
        </button>`,
      )
      .join('')

    return `
      <div class="between" style="margin-bottom:16px">
        <h1>${t('u.recipes')}</h1>
        <div class="row" style="gap:2px">
          <button class="icon ghost" data-action="go-shopping" aria-label="${t('u.shopping')}">
            ${icon.cart}${pending ? `<span class="dot">${pending}</span>` : ''}
          </button>
          <button class="icon ghost" data-action="go-settings" aria-label="${t('u.settings')}">${icon.gear}</button>
        </div>
      </div>
      ${this.livePanel()}
      <div class="label" style="margin:0 2px 8px">${t('u.addRecipe')}</div>
      <div class="tiles">${tiles}</div>
      ${
        this.index.length > 6
          ? `<input id="library-search" data-field="library-search" type="search"
                    placeholder="${t('u.searchMine')}" value="${esc(this.librarySearch)}"
                    style="margin:18px 0 10px" />`
          : '<div style="height:18px"></div>'
      }
      <div id="library-list">${this.libraryList()}</div>
      <button class="ghost" style="width:100%;margin-top:18px;font-size:14px" data-action="go-events">
        ${t('u.eventsLink')}
      </button>`
  }

  private catalog(): string {
    const chip = (label: string, active: boolean, action: string, id: string) =>
      `<button class="chip${active ? ' on' : ''}" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`

    const filters = `
      <div class="chips">
        ${REGIONS.map(r =>
          chip(regionLabel(r), this.query.regions.has(r), 'toggle-region', r),
        ).join('')}
      </div>
      <div class="chips">
        ${DIFFICULTIES.map(d =>
          chip(difficultyLabel(d), this.query.difficulties.has(d), 'toggle-difficulty', d),
        ).join('')}
      </div>
      <div class="chips">
        ${CATEGORIES.map(c =>
          chip(categoryLabel(c), this.query.categories.has(c), 'toggle-category', c),
        ).join('')}
      </div>`

    return `
      ${this.topBar(t('u.catalogTitle'))}
      <div class="stack">
        <input id="q" type="search" data-field="catalog-search" value="${esc(this.query.search)}"
               placeholder="${esc(t('u.catalogPh'))}" />
        ${filters}
        <div class="row">
          <label for="sort" class="caption">${t('u.sort')}</label>
          <select id="sort" data-field="sort" class="grow">
            ${SORT_KEYS.map(
              key =>
                `<option value="${key}"${this.query.sort === key ? ' selected' : ''}>${t(`u.sort.${key}`)}</option>`,
            ).join('')}
          </select>
          <button class="ghost" data-action="clear-filters">${t('u.clear')}</button>
        </div>
      </div>
      <div id="results">${this.catalogResults()}</div>`
  }

  private catalogResults(): string {
    // 加過的認 slug（換語言後名字不同也認得）；舊版加的沒有 slug，退回用名字比。
    const bySlug = new Map(this.index.filter(e => e.catalogSlug).map(e => [e.catalogSlug!, e.id]))
    const byName = new Map(this.index.map(e => [e.name, e.id]))
    const ownedId = (r: { slug: string; name: string }) => bySlug.get(r.slug) ?? byName.get(r.name)
    const results = queryCatalog(this.query)
    if (!results.length) {
      return `<div class="empty">${t('u.catEmpty')}</div>`
    }
    return `
      <p class="caption" style="margin:18px 4px 10px">${t('u.count', { n: results.length })}</p>
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
                  ${esc(
                    t('u.catMeta', {
                      region: regionLabel(r.region),
                      cat: categoryLabel(r.category),
                      diff: difficultyLabel(r.difficulty),
                      min: r.totalMinutes,
                      n: r.steps.length,
                    }),
                  )}
                </div>
              </div>
              ${
                // 已經加過的不再鼓勵重複加入，改成「已加入」，點了直接打開自己那份。
                ownedId(r)
                  ? `<button class="small added" data-action="open" data-id="${esc(ownedId(r)!)}">
                       ${icon.check} ${t('u.added')}
                     </button>`
                  : `<button class="primary small" data-action="add-from-catalog" data-id="${esc(r.slug)}">
                       ${t('u.add')}
                     </button>`
              }
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

  private settingsScreen(): string {
    const on = this.hooks.timersEnabled()
    const card = (action: string, id: string, active: boolean, title: string, desc = '') => `
      <button class="option-card${active ? ' on' : ''}" data-action="${action}" data-id="${id}"
              role="radio" aria-checked="${active}">
        <span class="radio">${active ? icon.check : ''}</span>
        <span class="grow">
          <span class="option-title">${esc(title)}</span>
          ${desc ? `<span class="caption">${esc(desc)}</span>` : ''}
        </span>
      </button>`
    const auto = this.languageChoice === 'auto'
    return `
      ${this.topBar(t('u.set.title'))}
      <h2 style="margin-top:0">${t('u.set.lang')}</h2>
      <div class="stack" role="radiogroup">
        ${card(
          'set-language',
          'auto',
          auto,
          t('u.set.langAuto'),
          t('u.set.langAutoDesc', { lang: this.hooks.phoneLanguage() || '?' }),
        )}
        ${LANG_CODES.map(code =>
          card('set-language', code, this.languageChoice === code, LANG_NAMES[code]),
        ).join('')}
      </div>
      <h2>${t('u.set.timers')}</h2>
      <div class="stack" role="radiogroup">
        ${card('set-timers', 'ask', on, t('u.set.ask'), t('u.set.askDesc'))}
        ${card('set-timers', 'off', !on, t('u.set.off'), t('u.set.offDesc'))}
      </div>
      <p class="caption" style="margin:14px 2px 0">${t('u.set.note')}</p>`
  }

  /**
   * 眼鏡訊號：把眼鏡送來的原始事件列出來。模擬器和實機的事件格式不一定一樣，
   * 手勢沒反應時，截這個畫面就知道眼鏡到底送了什麼。
   */
  private eventsScreen(): string {
    const time = (ts: number) =>
      new Date(ts).toLocaleTimeString(getLang() === 'zh' ? 'zh-TW' : getLang(), { hour12: false })
    const rows = this.glassesEvents
      .map(
        e => `
        <div class="event-row">
          <span class="caption">${time(e.at)}</span>
          <code>${esc(e.json)}</code>
        </div>`,
      )
      .join('')
    return `
      ${this.topBar(t('u.ev.title'), `<button class="ghost" data-action="clear-events">${t('u.clear')}</button>`)}
      <p class="caption" style="margin:0 2px 12px">${t('u.ev.intro')}</p>
      <div class="card">${rows || `<p class="caption">${t('u.ev.empty')}</p>`}</div>`
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
                      .join(t('u.sh.sep'))}</span>`
                  : ''
              }
            </span>
          </label>
          <button class="icon danger" data-action="shopping-remove" data-id="${esc(i.id)}"
                  aria-label="${esc(t('u.sh.remove', { name: i.item }))}">${icon.close}</button>
        </div>`,
      )
      .join('')

    const checked = items.filter(i => i.checked).length
    return `
      ${this.topBar(t('u.shopping'))}
      <div class="row" style="margin-bottom:14px">
        <input id="newItem" type="text" class="grow" placeholder="${esc(t('u.sh.addPh'))}" />
        <button data-action="shopping-add-manual">${t('u.add')}</button>
      </div>
      ${rows || `<div class="empty">${t('u.sh.empty')}</div>`}
      ${
        items.length
          ? `
      <div class="stack" style="margin-top:16px">
        <button class="primary" data-action="show-shopping-on-glasses" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? t('u.sending') : t('u.sh.send')}
        </button>
        <div class="row">
          <button class="grow" data-action="shopping-clear-checked" ${checked ? '' : 'disabled'}>
            ${t('u.sh.clearChecked', { n: checked })}
          </button>
          <button class="grow danger" data-action="shopping-clear-all">${t('u.sh.clearAll')}</button>
        </div>
      </div>`
          : ''
      }`
  }

  private importScreen(): string {
    return `
      ${this.topBar(t('u.imp.title'))}
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">${t('u.imp.label')}</div>
          <input id="url" type="url" inputmode="url" placeholder="${esc(t('u.imp.ph'))}" value="${esc(this.draftUrl)}" ${
            this.busy ? 'disabled' : ''
          } />
        </div>
        <button class="primary" data-action="run-import" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? t('u.imp.busy') : t('u.imp.run')}
        </button>
        <p class="caption">${t('u.imp.note')}</p>
      </div>`
  }

  private searchScreen(): string {
    return `
      ${this.topBar(t('u.se.title'))}
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">${t('u.se.label')}</div>
          <input id="query" type="text" placeholder="${esc(t('u.se.ph'))}" maxlength="60" value="${esc(this.draftQuery)}" ${
            this.busy ? 'disabled' : ''
          } />
        </div>
        <button class="${this.searchResults.length ? '' : 'primary'}" data-action="run-search" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? t('u.se.busy') : this.searchResults.length ? t('u.se.again') : t('u.se.run')}
        </button>
        <p class="caption">
          ${this.busy ? t('u.se.wait') : t('u.se.hint')}
        </p>
      </div>
      ${this.searchResults.length ? this.searchOptions() : ''}`
  }

  private searchOptions(): string {
    const cards = this.searchResults
      .map((o, n) => {
        const r = o.recipe
        const preview = r.ingredients
          .slice(0, 5)
          .map(i => i.item)
          .join(t('list.sep'))
        return `
        <div class="card option" data-action="pick-option" data-id="${n}">
          <div class="row" style="gap:8px;margin-bottom:4px">
            <span class="badge accent">${esc(o.label)}</span>
            <span class="title-row grow">${esc(r.name)}</span>
          </div>
          ${o.summary ? `<div>${esc(o.summary)}</div>` : ''}
          <div class="caption" style="margin-top:6px">
            ${esc(
              t('u.se.meta', {
                n: r.steps.length,
                min: r.totalMinutes,
                diff: difficultyLabel(r.difficulty),
                servings: r.servings,
              }),
            )}
          </div>
          ${
            preview
              ? `<div class="caption">${esc(
                  r.ingredients.length > 5
                    ? t('u.se.ingredientsMore', { list: preview, n: r.ingredients.length })
                    : t('u.se.ingredients', { list: preview }),
                )}</div>`
              : ''
          }
          <button class="primary" style="width:100%;margin-top:12px" data-action="pick-option" data-id="${n}">
            ${t('u.se.pick')}
          </button>
        </div>`
      })
      .join('')
    return `
      <h2 id="options">${t('u.se.heading', { n: this.searchResults.length })}</h2>
      ${cards}`
  }

  /**
   * 眼鏡正在顯示這道菜時的狀態卡：在第幾步、上一步／下一步，以及這一步要不要計時。
   *
   * 要計時的步驟由使用者自己決定：可以按「開始計時」，也可以「不用計時，下一步」
   * 直接往下走——不會因為沒計時就卡住。
   */
  private nowCard(recipe: Recipe, state: GlassesState): string {
    const step = state.step
    const inSteps = step >= 0 && step < state.stepTotal
    const seconds = inSteps ? recipe.steps[step]?.timerSeconds : undefined
    const running = inSteps
      ? state.timers.find(t => t.recipeId === recipe.id && t.stepIndex === step)
      : undefined
    const choose = !!seconds && !running && this.hooks.timersEnabled()

    return `
      <div class="now-card">
        <div class="between">
          <div class="grow">
            <div class="now-title">${t('u.now.title')}</div>
            <div>${stepLabel(step, state.stepTotal)}</div>
          </div>
          ${
            inSteps
              ? `<button class="small" data-action="scroll-current" data-id="${step}">${t('u.now.look')}</button>`
              : ''
          }
        </div>
        ${running ? `<div style="margin-top:10px">${timerChip(running.endsAt)}</div>` : ''}
        ${
          choose
            ? `
        <div class="timer-ask">
          <div class="timer-ask-q">${icon.timer} ${esc(t('u.now.ask', { d: formatDuration(seconds!) }))}</div>
          <div class="row" style="gap:8px">
            <button class="grow dark" data-action="start-timer" data-id="${step}">${t('u.now.start')}</button>
            <button class="grow" data-action="step-by" data-id="1">${t('u.now.skip')}</button>
          </div>
          <button class="link" data-action="timers-off-from-ask">${t('u.now.never')}</button>
        </div>`
            : ''
        }
        <div class="row nav-row">
          <button class="grow" data-action="step-by" data-id="-1" ${step < 0 ? 'disabled' : ''}>${t('u.now.prev')}</button>
          ${
            choose
              ? ''
              : `<button class="grow" data-action="step-by" data-id="1" ${step >= state.stepTotal ? 'disabled' : ''}>${
                  step === state.stepTotal - 1 ? t('u.now.finish') : t('u.now.next')
                }</button>`
          }
        </div>
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

    const state = this.hooks.glassesState()
    const onGlasses = state.mode === 'recipe' && state.recipeId === recipe.id
    const waiting = this.hooks.otherActiveDishes().find(d => d.recipeId === recipe.id)
    // 在眼鏡上、或煮到一半的菜，步驟可以點；只是瀏覽的菜點了不會突然推到眼鏡上。
    const live = onGlasses || !!waiting
    const current = onGlasses ? state.step : (waiting?.step ?? null)

    const steps = recipe.steps
      .map((s, n) => {
        const running = state.timers.find(t => t.recipeId === recipe.id && t.stepIndex === n)
        const timer = !s.timerSeconds
          ? ''
          : running
            ? timerChip(running.endsAt)
            : live && this.hooks.timersEnabled()
              ? `<button class="small timer-btn" data-action="start-timer" data-id="${n}">${icon.timer}${esc(t('u.timer.start', { d: formatDuration(s.timerSeconds) }))}</button>`
              : `<span class="badge accent timer-need">${icon.timer}${esc(t('u.timer.need', { d: formatDuration(s.timerSeconds) }))}</span>`
        const tag = live ? 'a' : 'div'
        const attrs = live ? ` data-action="jump-step" data-id="${n}"` : ''
        return `
        <${tag} id="step-${n}" class="step-row${live ? ' tappable' : ''}${n === current ? ' current' : ''}"${attrs}>
          <span class="step-no">${n + 1}</span>
          <div class="grow">
            <div>${esc(s.text)}</div>
            ${s.tip ? `<div class="caption" style="margin-top:4px">${esc(s.tip)}</div>` : ''}
            ${timer ? `<div style="margin-top:8px">${timer}</div>` : ''}
            ${n === current ? `<div class="here">${onGlasses ? t('u.det.here1') : t('u.det.here2')}</div>` : ''}
          </div>
        </${tag}>`
      })
      .join('')

    const source =
      recipe.source === 'ai'
        ? recipe.sourceUrl
          ? esc(t('u.det.srcAiQuery', { q: recipe.sourceUrl }))
          : t('u.det.srcAi')
        : recipe.sourceUrl
          ? isYouTube(recipe.sourceUrl)
            ? t('u.det.srcYoutube')
            : t('u.det.srcWeb')
          : ''

    // 眼鏡正在顯示這道菜時，不放一顆按不下去的灰按鈕（看起來像壞掉），
    // 改成一張狀態卡，並提供「看目前步驟」直接捲到那一步。
    const action = onGlasses
      ? this.nowCard(recipe, state)
      : `
      <button class="primary big" data-action="cook" ${this.busy ? 'disabled' : ''}>
        ${
          this.busy
            ? t('u.sending')
            : waiting
              ? esc(t('u.det.switch', { step: stepLabel(waiting.step, waiting.stepTotal) }))
              : t('u.det.cook')
        }
      </button>`

    return `
      ${this.topBar(
        recipe.name,
        `<div class="row" style="gap:2px">
          <button class="icon ghost${this.favorites.has(recipe.id) ? ' fav-on' : ''}" data-action="toggle-fav"
                  data-id="${esc(recipe.id)}" aria-label="${this.favorites.has(recipe.id) ? t('u.unstar') : t('u.star')}">
            ${this.favorites.has(recipe.id) ? icon.star : icon.starOutline}
          </button>
          <button class="ghost" data-action="edit">${t('u.det.edit')}</button>
        </div>`,
      )}
      <div class="chips meta">
        <span class="chip">${difficultyLabel(recipe.difficulty)}</span>
        <span class="chip">${t('u.chip.time', { n: recipe.totalMinutes })}</span>
        <span class="chip">${t('u.chip.steps', { n: recipe.steps.length })}</span>
        <span class="chip">${t('u.chip.serves', { n: recipe.servings })}</span>
      </div>
      ${action}
      <p class="caption" style="margin:10px 2px 0">
        ${
          live
            ? this.hooks.timersEnabled()
              ? t('u.det.help1')
              : t('u.det.help2')
            : t('u.det.help3')
        }
      </p>
      ${
        live
          ? `<button class="stop" data-action="stop-cooking">${
              state.timers.some(tm => tm.recipeId === recipe.id) ? t('u.det.stopT') : t('u.det.stop')
            }</button>`
          : ''
      }
      <div style="margin-top:14px">${this.livePanel(recipe.id)}</div>

      <h2>${t('u.det.ingredients')}</h2>
      <div class="card">${ingredients || `<p class="caption">${t('u.det.noIngredients')}</p>`}</div>
      <button style="width:100%;margin-top:10px" data-action="add-to-shopping">${t('u.det.addShop')}</button>

      <h2>${t('u.det.steps')}</h2>
      <div class="card">${steps}</div>

      ${source ? `<p class="caption" style="margin:14px 2px 0">${source}</p>` : ''}
      <button class="danger" style="width:100%;margin-top:22px" data-action="delete">${t('u.det.delete')}</button>`
  }

  private editor(recipe: Recipe, isNew: boolean): string {
    const ingredients = recipe.ingredients
      .map(
        i => `
        <div class="row" style="padding:8px 0;border-bottom:1px solid var(--hairline)">
          <input class="bare grow" data-field="ingredient-item" data-id="${esc(i.id)}"
                 value="${esc(i.item)}" placeholder="${t('u.ed.ingredientPh')}" aria-label="${t('u.ed.ingredientName')}" />
          <input class="mini" data-field="ingredient-amount" data-id="${esc(i.id)}"
                 value="${esc(i.amount)}" placeholder="${t('u.ed.amountPh')}" aria-label="${t('u.ed.amountPh')}" />
          <button class="icon danger" data-action="del-ingredient" data-id="${esc(i.id)}"
                  aria-label="${esc(t('u.ed.removeIngredient', { name: i.item }))}">${icon.close}</button>
        </div>`,
      )
      .join('')

    const steps = recipe.steps
      .map(
        (s, n) => `
        <div class="card">
          <div class="between" style="margin-bottom:8px">
            <span class="label">${t('step.n', { n: n + 1 })}</span>
            <div class="row">
              <button class="icon" data-action="move-step-up" data-id="${esc(s.id)}" aria-label="${t('u.ed.up')}">${icon.up}</button>
              <button class="icon" data-action="move-step-down" data-id="${esc(s.id)}" aria-label="${t('u.ed.down')}">${icon.down}</button>
              <button class="icon danger" data-action="del-step" data-id="${esc(s.id)}" aria-label="${t('u.ed.delStep')}">${icon.close}</button>
            </div>
          </div>
          <textarea data-field="step-text" data-id="${esc(s.id)}"
                    aria-label="${t('u.ed.stepContent', { n: n + 1 })}"
                    placeholder="${t('u.ed.stepPh')}">${esc(s.text)}</textarea>
          <div class="row" style="margin-top:8px">
            <span class="caption">${t('u.ed.timer')}</span>
            <input class="mini short" type="number" min="0" inputmode="numeric"
                   data-field="step-timer-min" data-id="${esc(s.id)}"
                   aria-label="${t('u.ed.timerMin', { n: n + 1 })}"
                   value="${s.timerSeconds && s.timerSeconds >= 60 ? Math.floor(s.timerSeconds / 60) : ''}" placeholder="—" />
            <span class="caption">${t('u.ed.minUnit')}</span>
            <input class="mini short" type="number" min="0" max="59" inputmode="numeric"
                   data-field="step-timer-sec" data-id="${esc(s.id)}"
                   aria-label="${t('u.ed.timerSec', { n: n + 1 })}"
                   value="${s.timerSeconds && s.timerSeconds % 60 ? s.timerSeconds % 60 : ''}" placeholder="—" />
            <span class="caption">${t('u.ed.secUnit')}</span>
          </div>
        </div>`,
      )
      .join('')

    return `
      ${this.topBar(isNew ? t('u.ed.new') : t('u.ed.edit'), `<button class="primary small" data-action="save" ${this.busy ? 'disabled' : ''}>${this.busy ? t('u.ed.saving') : t('u.ed.save')}</button>`)}
      <div class="stack">
        <div>
          <div class="label" style="margin-bottom:6px">${t('u.ed.name')}</div>
          <input data-field="name" value="${esc(recipe.name)}" placeholder="${t('u.ed.namePh')}" aria-label="${t('u.ed.namePh')}" />
        </div>
        <div class="row">
          <label for="d" class="caption">${t('u.ed.difficulty')}</label>
          <select id="d" data-field="difficulty" class="grow">
            ${DIFFICULTIES.map(
              d =>
                `<option value="${d}"${recipe.difficulty === d ? ' selected' : ''}>${difficultyLabel(d)}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="row">
          <label for="sv" class="caption">${t('u.ed.servings')}</label>
          <input id="sv" class="mini" type="number" min="1" inputmode="numeric"
                 data-field="servings" value="${recipe.servings}" />
          <span class="caption">${t('u.ed.servingsUnit')}</span>
          <label for="mn" class="caption" style="margin-left:8px">${t('u.ed.time')}</label>
          <input id="mn" class="mini" type="number" min="1" inputmode="numeric"
                 data-field="minutes" value="${recipe.totalMinutes}" />
          <span class="caption">${t('u.ed.minUnit')}</span>
        </div>
      </div>

      <h2>${t('u.det.ingredients')}</h2>
      <div class="card">${ingredients || `<p class="caption">${t('u.ed.noIngredients')}</p>`}</div>
      <button style="width:100%;margin-top:10px" data-action="add-ingredient">${t('u.ed.addIngredient')}</button>

      <h2>${t('u.det.steps')}</h2>
      <p class="caption" style="margin:-4px 2px 10px">${t('u.ed.timerHelp')}</p>
      <div class="stack">${steps}</div>
      <button style="width:100%;margin-top:10px" data-action="add-step">${t('u.ed.addStep')}</button>
      <button class="primary big" style="margin-top:26px" data-action="save" ${this.busy ? 'disabled' : ''}>
        ${this.busy ? t('u.ed.saving') : t('u.ed.saveFull')}
      </button>`
  }
}
