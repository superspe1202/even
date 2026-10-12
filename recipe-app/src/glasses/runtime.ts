import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import {
  bySoonest,
  remainingSeconds,
  splitExpired,
  timerKey,
  type RunningTimer,
} from '../core/timer'
import type { Recipe } from '../core/types'
import { t } from '../i18n'
import {
  alarmFooter,
  alarmBody,
  BODY,
  BRIGHTNESS,
  FOOTER,
  HEADER,
  idleBody,
  RAIL,
  buildShoppingViews,
  buildViews,
  currentStepOf,
  doneBody,
  footerText,
  headerText,
  menuBody,
  menuHeaderText,
  menuRail,
  railSlots,
  timerLabel,
  type FooterTimer,
  type MenuItem,
  type MenuTimer,
  type RailSlot,
  type View,
} from './views'

/** 只宣告用到的部分，避免和 SDK 具體型別綁死。 */
interface GlassesBridge {
  createStartUpPageContainer(payload: CreateStartUpPageContainer): Promise<number>
  textContainerUpgrade(payload: TextContainerUpgrade): Promise<unknown>
  shutDownPageContainer(reason: number): unknown
  onEvenHubEvent(handler: (event: EvenEvent) => void): () => void
}

interface EventEnvelope {
  eventType?: OsEventTypeList | string
}
interface EvenEvent {
  sysEvent?: EventEnvelope
  textEvent?: EventEnvelope
  listEvent?: EventEnvelope
}

/** 計時結束後閃爍多久（毫秒），以及每次切換的間隔。 */
const ALARM_DURATION_MS = 10_000
const ALARM_BLINK_MS = 600
/** 標頭時間更新間隔。只顯示到分鐘，不必秒更新，省藍牙流量。 */
const CLOCK_TICK_MS = 20_000
const TIMER_TICK_MS = 1_000
/** 換頁後這段時間內收到的點擊視為多餘訊號，不處理。 */
const CLICK_GUARD_MS = 500
/**
 * App 關著的時候到期的計時器，重開時還在這段時間內就補響；更早的就不響了，
 * 免得隔天打開 App 還在對昨天的菜閃「時間到」。
 */
const LATE_ALARM_GRACE_MS = 30 * 60_000

export interface RuntimeCallbacks {
  /** 位置變動時通知外層做進度保存。`finished` 代表走到了「完成」頁。 */
  onPositionChange?: (recipeId: string, viewIndex: number, finished: boolean) => void
  onExit?: () => void
  /** 長按開主選單時，向外層要「可以選的項目」：煮到一半的菜、食譜庫、採購清單。 */
  menuItems?: () => Promise<MenuItem[]>
  /** 在主選單點了一項（目前顯示中的那道不會走到這裡，直接回到它）。 */
  onPickMenuItem?: (item: MenuItem) => void | Promise<void>
  /** 完成頁長按：這道菜已關閉（進度、計時都清掉了），外層同步自己的狀態。 */
  onDishClosed?: (recipeId: string) => void
  /** 計時器開始或到期時通知外層落盤，App 重開也接得回來。 */
  onTimersChange?: (timers: RunningTimer[]) => void
  /**
   * 眼鏡上看得到的任何東西變了（翻頁、換菜、計時開始／到期、響鈴開始／按掉）
   * 都會呼叫，讓手機畫面跟著同步。倒數本身每秒在變，手機自己用 `endsAt` 算，
   * 這裡不會每秒通知。
   */
  onStateChange?: (state: GlassesState) => void
  /** 每一個從眼鏡收到的原始事件。給手機上的「事件紀錄」用，實機排查手勢問題。 */
  onRawEvent?: (event: unknown) => void
}

/** 手機端要同步顯示的眼鏡狀態。 */
export interface GlassesState {
  /** 眼鏡正在顯示主選單（底下的 mode 是選單蓋住之前的畫面）。 */
  menu: boolean
  mode: 'idle' | 'recipe' | 'shopping'
  recipeId: string | null
  /** 標頭左半：食譜名、「採購清單」或 App 名稱。 */
  title: string
  /** 目前在哪一步（0 起算）；-1 是食材頁，等於 `stepTotal` 是完成頁。 */
  step: number
  stepTotal: number
  /** 所有在跑的計時器，最快到的排前面。 */
  timers: RunningTimer[]
  /** 正在閃「時間到」的那個；沒有就是 null。 */
  alarm: RunningTimer | null
}

/**
 * 眼鏡端的執行時期：持有所有容器，負責導覽、計時與事件路由。
 *
 * 容器只在啟動時建立一次，之後一律用 `textContainerUpgrade` 就地更新 ——
 * `rebuildPageContainer` 每次都會整頁閃一下，翻步驟時很難看。
 */
export class GlassesRuntime {
  private recipe: Recipe | null = null
  /** 標頭左半的文字：烹飪時是食譜名，採購清單時是「採購清單」。 */
  private title = 'Recipe Glass'
  /** 正在顯示的採購清單（換語言時要照新語言重排）。顯示食譜或待命時是 null。 */
  private shoppingLines: string[] | null = null
  private views: View[] = []
  private index = 0
  /** 所有正在倒數的計時器，跨步驟、跨食譜，跟目前顯示哪個畫面無關。 */
  private timers: RunningTimer[] = []
  /**
   * 這次開 App 以來已經響過的步驟。回到那一步時點擊就是下一頁，
   * 不然剛按掉「時間到」、再點一下想往下走，會變成又重新計時一次。
   */
  private finishedTimers = new Set<string>()
  private timerHandle: ReturnType<typeof setInterval> | null = null
  /** 等著響的計時器，第一個是正在閃的那個。 */
  private alarms: RunningTimer[] = []
  private alarmUntil = 0
  private alarmHandle: ReturnType<typeof setInterval> | null = null
  private alarmPhase = false
  /**
   * 右欄五格上次寫入的內容與亮度。
   *
   * 每翻一頁都重寫五格等於五次藍牙往返，翻頁會明顯卡頓。所以記住上次的
   * 狀態，只寫真的變了的格子 —— 同一步驟內翻頁通常一格都不用動。
   */
  private lastRail: RailSlot[] = []
  /** 序列化 bridge 寫入，使用者連點時避免兩次更新互相覆蓋。 */
  private writing: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  /** 標頭右側時間，即使使用者不操作也要每隔一段時間自己刷新。 */
  private clockHandle: ReturnType<typeof setInterval> | null = null
  private lastHeader = ''
  /** 計時中頁尾每秒都會重算，文字沒變就不必再送一次藍牙封包。 */
  private lastFooter = ''
  /** 使用者選了「不使用計時」：不提示、不開始倒數，點擊一律是下一頁。 */
  private timersEnabled = true
  /** 上一次換畫面的時間，用來擋掉換頁後緊跟著來的多餘點擊。 */
  private lastNavAt = 0
  /**
   * 主選單。開著的時候底下的食譜／採購清單原封不動（計時照跑、進度保留），
   * 長按回去就還在原來那一頁；選了別項才換掉它。
   */
  private menu: { items: MenuItem[]; selected: number } | null = null
  private lastMenuBody = ''

  constructor(
    private readonly bridge: GlassesBridge,
    private readonly callbacks: RuntimeCallbacks = {},
  ) {}

  /** 建立啟動頁。必須在使用任何眼鏡端功能之前成功執行一次。 */
  async init(): Promise<boolean> {
    const mk = (
      c: { x: number; y: number; w: number; h: number; pad: number; id: number; name: string },
      content: string,
      capture: 0 | 1,
      brightness: number,
    ) =>
      new TextContainerProperty({
        xPosition: c.x,
        yPosition: c.y,
        width: c.w,
        height: c.h,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: c.pad,
        containerID: c.id,
        containerName: c.name,
        content,
        isEventCapture: capture,
        textColor: brightness,
      })

    // 右欄五格。containerName 上限 16 字元，r0~r4 很安全。
    const rail = Array.from({ length: RAIL.slots }, (_, i) =>
      mk(
        {
          x: RAIL.x,
          y: RAIL.top + i * RAIL.pitch,
          w: RAIL.w,
          h: RAIL.h,
          pad: RAIL.pad,
          id: RAIL.firstId + i,
          name: `r${i}`,
        },
        '',
        0,
        BRIGHTNESS.dim,
      ),
    )
    this.lastRail = Array.from({ length: RAIL.slots }, () => ({
      content: '',
      brightness: BRIGHTNESS.dim,
    }))

    this.lastHeader = headerText(this.title, 0, null, new Date())
    this.lastFooter = this.footer()
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3 + RAIL.slots,
        textObject: [
          mk(HEADER, this.lastHeader, 0, BRIGHTNESS.header),
          // 所有容器裡必須剛好有一個設 isEventCapture: 1。
          mk(BODY, idleBody(), 1, BRIGHTNESS.bright),
          mk(FOOTER, this.lastFooter, 0, BRIGHTNESS.dim),
          ...rail,
        ],
      }),
    )
    if (result !== 0) {
      console.error('createStartUpPageContainer 失敗：', result)
      return false
    }
    this.listen()
    this.clockHandle = setInterval(() => void this.renderHeader(), CLOCK_TICK_MS)
    return true
  }

  /** 載入食譜並跳到指定畫面（例如還原上次進度、或切換到另一道食譜）。 */
  async load(recipe: Recipe, viewIndex = 0): Promise<void> {
    this.menu = null
    this.recipe = recipe
    this.shoppingLines = null
    this.title = recipe.name
    this.views = buildViews(recipe)
    this.index = Math.min(Math.max(0, viewIndex), this.views.length - 1)
    await this.render()
  }

  /**
   * 改為顯示採購清單。
   *
   * 計時器照樣在跑——逛完超市回來，鍋裡的東西不會因為看了清單就停火。
   */
  async loadShoppingList(lines: string[]): Promise<void> {
    this.menu = null
    this.recipe = null
    this.shoppingLines = lines
    this.title = t('g.shoppingTitle')
    this.views = buildShoppingViews(lines)
    this.index = 0
    await this.render()
  }

  /**
   * 語言變了：照新語言重排眼鏡上所有的字，並停在同一個步驟。
   *
   * 食譜本身的文字是使用者存下來的那一份，不會變；變的是「食材」「步驟 3/6」
   * 這類標籤、頁尾提示、待命與完成畫面。
   */
  async relocalize(): Promise<void> {
    if (this.recipe) {
      const cur = this.view
      this.views = buildViews(this.recipe)
      const same = cur
        ? this.views.findIndex(
            v =>
              v.kind === cur.kind &&
              (v.kind !== 'step' || (cur.kind === 'step' && v.stepIndex === cur.stepIndex)),
          )
        : -1
      this.index = same >= 0 ? same : Math.min(this.index, this.views.length - 1)
    } else if (this.shoppingLines) {
      this.title = t('g.shoppingTitle')
      this.views = buildShoppingViews(this.shoppingLines)
      this.index = Math.min(this.index, this.views.length - 1)
    }
    if (this.menu) {
      // 選單項目的說明文字（「6 步驟 · 15 分」）也是翻譯過的，重新向外層要一份，選中項不變。
      const keep = this.menu.items[this.menu.selected]?.id
      const items = (await this.callbacks.menuItems?.()) ?? []
      const at = items.findIndex(i => i.id === keep)
      this.menu = { items, selected: Math.max(0, at) }
      this.lastMenuBody = ''
    }
    // 各容器的「上次寫入」快取清掉，確保每一格都照新語言重寫一次。
    this.lastHeader = ''
    this.lastFooter = ''
    this.lastRail = this.lastRail.map(() => ({ content: '\0', brightness: -1 }))
    await this.render()
  }

  /** 手機端點某一步：跳到那一步的第一頁。找不到（步驟被刪了）就不動。 */
  async jumpToStep(stepIndex: number): Promise<void> {
    const target = this.views.findIndex(
      v => v.kind === 'step' && v.stepIndex === stepIndex && v.page === 0,
    )
    if (target >= 0) await this.jumpTo(target)
  }

  /**
   * 以「步驟」為單位前後移動（手機上的上一步／下一步）。眼鏡上的滑動是一頁一頁走，
   * 手機按鈕則直接跳到下一步的第一頁；從食材頁往後是第一步，最後一步往後是完成頁。
   */
  async stepBy(delta: number): Promise<void> {
    const view = this.view
    if (!this.recipe || !view) return
    const stepTotal = this.recipe.steps.length
    const target = currentStepOf(view, stepTotal) + delta
    if (target < 0) return this.jumpTo(0)
    if (target >= stepTotal) return this.jumpTo(this.views.length - 1)
    return this.jumpToStep(target)
  }

  /** 某一步在眼鏡上的畫面索引，給外層切換食譜時直接載到那一步用。 */
  static viewIndexOfStep(recipe: Recipe, stepIndex: number): number {
    const target = buildViews(recipe).findIndex(
      v => v.kind === 'step' && v.stepIndex === stepIndex && v.page === 0,
    )
    return Math.max(0, target)
  }

  /**
   * App 重開或背景還原時把計時器放回來。還在跑的接著倒數；關著的時候
   * 剛到期的補響一次；到期太久的就直接略過。
   */
  restoreTimers(saved: RunningTimer[]): void {
    const now = Date.now()
    const { expired, running } = splitExpired(saved, now)
    this.timers = running
    for (const t of expired) this.finishedTimers.add(timerKey(t.recipeId, t.stepIndex))
    if (expired.length) this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()

    const late = expired.filter(t => now - t.endsAt <= LATE_ALARM_GRACE_MS)
    if (late.length) this.queueAlarms(late)
    else void this.renderFooter()
    this.notify()
  }

  /**
   * 食譜被刪掉、或在手機上按了「結束烹飪」：它的計時器、還沒響完的提醒都拿掉，
   * 響過的紀錄也清掉——之後重新開始煮這道菜，計時要能再開。
   */
  cancelTimersFor(recipeId: string): void {
    const before = this.timers.length
    this.timers = this.timers.filter(t => t.recipeId !== recipeId)
    for (const key of [...this.finishedTimers]) {
      if (key.startsWith(`${recipeId}#`)) this.finishedTimers.delete(key)
    }
    if (this.timers.length !== before) {
      this.callbacks.onTimersChange?.(this.timers)
      this.syncTicker()
    }

    const blinking = this.alarms[0]
    this.alarms = this.alarms.filter(a => a.recipeId !== recipeId)
    if (blinking && blinking.recipeId === recipeId) {
      // 正在閃的就是這道菜的：停掉，後面還有別道的就接著響，沒有就回原畫面。
      if (this.alarmHandle !== null) {
        clearInterval(this.alarmHandle)
        this.alarmHandle = null
      }
      if (this.alarms.length) this.startAlarm()
      else void this.render()
      return
    }
    void this.renderFooter()
    this.notify()
  }

  /** 眼鏡回到待命畫面（例如手機上結束了正在顯示的那道菜，又沒有別道在煮）。 */
  async unload(): Promise<void> {
    this.menu = null
    this.recipe = null
    this.shoppingLines = null
    this.title = 'Recipe Glass'
    this.views = []
    this.index = 0
    await this.render()
  }

  /** 手機設定「步驟計時」改了。關掉時，已經在跑的計時照跑，只是不再提示開始新的。 */
  setTimersEnabled(on: boolean): void {
    if (this.timersEnabled === on) return
    this.timersEnabled = on
    void this.renderFooter()
    this.notify()
  }

  get timersOn(): boolean {
    return this.timersEnabled
  }

  get currentIndex() {
    return this.index
  }

  get loadedRecipeId() {
    return this.recipe?.id ?? null
  }

  get state(): GlassesState {
    const view = this.view
    const stepTotal = this.recipe?.steps.length ?? 0
    return {
      menu: this.menu !== null,
      mode: this.recipe ? 'recipe' : this.views.length ? 'shopping' : 'idle',
      recipeId: this.recipe?.id ?? null,
      title: this.title,
      step: view ? currentStepOf(view, stepTotal) : -1,
      stepTotal,
      timers: bySoonest(this.timers),
      alarm: this.alarms[0] ?? null,
    }
  }

  private notify() {
    this.callbacks.onStateChange?.(this.state)
  }

  /** 背景保存用。回傳複本，外面拿去序列化不會動到內部狀態。 */
  get timersSnapshot(): RunningTimer[] {
    return this.timers.map(t => ({ ...t }))
  }

  private get view(): View | null {
    return this.views[this.index] ?? null
  }

  private listen() {
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      this.callbacks.onRawEvent?.(event)
      const sysType = typeOf(event.sysEvent)
      const textType = typeOf(event.textEvent)
      const listType = typeOf(event.listEvent)
      const is = (type: OsEventTypeList) =>
        sysType === type || textType === type || listType === type

      // 系統確認離開、或連線異常中斷：這時才收拾。
      if (
        sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.dispose()
        this.callbacks.onExit?.()
        return
      }
      // 前景切換、IMU 之類的系統事件不是手勢，不能掉到下面被當成點擊。
      if (
        sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
        sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
        sysType === OsEventTypeList.IMU_DATA_REPORT ||
        is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
      ) {
        return
      }

      // 雙擊離開放在最前面：不論事件從哪個信封來，使用者都必須能退出。
      // 只叫出系統的「確定離開？」對話框，這裡不收拾——使用者按取消的話
      // App 還在畫面上，要繼續收得到事件。確定離開會再送 SYSTEM_EXIT_EVENT。
      if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
        this.bridge.shutDownPageContainer(1)
        return
      }

      // 正在響鈴時，任何動作都先當作「我知道了」，不翻頁也不切換食譜。
      if (this.alarms.length) {
        if (
          is(OsEventTypeList.SCROLL_TOP_EVENT) ||
          is(OsEventTypeList.SCROLL_BOTTOM_EVENT) ||
          is(OsEventTypeList.CLICK_EVENT) ||
          is(OsEventTypeList.LONG_PRESS_EVENT)
        ) {
          void this.dismissAlarm()
        }
        return
      }

      // 主選單開著：上下滑選擇、點擊打開、長按返回。
      if (this.menu) {
        if (is(OsEventTypeList.SCROLL_TOP_EVENT)) void this.moveMenu(-1)
        else if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) void this.moveMenu(1)
        else if (is(OsEventTypeList.LONG_PRESS_EVENT)) void this.closeMenu()
        else if (is(OsEventTypeList.CLICK_EVENT)) {
          if (Date.now() - this.lastNavAt < CLICK_GUARD_MS) return
          void this.pickMenuItem()
        }
        return
      }

      if (is(OsEventTypeList.SCROLL_TOP_EVENT)) {
        void this.go(-1)
        return
      }
      // 下滑永遠是下一頁（也是有計時的步驟不想計時時的「跳過」）。
      if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
        void this.go(1)
        return
      }
      // 長按：開主選單，換另一道菜或回主選單。完成頁的長按同時關掉這道菜。
      if (is(OsEventTypeList.LONG_PRESS_EVENT)) {
        void this.openMenu()
        return
      }
      // CLICK_EVENT 是 0，protobuf 會省略零值，所以它是「沒有型別」的退路，
      // 一定要放在所有具名事件之後才判斷。
      // 點擊只用來開始計時；翻頁一律用下滑，不會因為誤觸就跳頁。
      if (is(OsEventTypeList.CLICK_EVENT)) {
        // 剛換到這一頁（滑過來、手機跳過來）半秒內的「點擊」不算數：實機上滑動之後
        // 可能緊跟著一個沒有型別的事件，會被當成點擊，一到計時步驟就自己開始倒數。
        if (Date.now() - this.lastNavAt < CLICK_GUARD_MS) return
        const view = this.view
        if (this.recipe && view?.kind === 'step' && this.startableSeconds() !== null) {
          this.startTimerFor(this.recipe, view.stepIndex)
        }
        return
      }
    })
  }

  async go(delta: number): Promise<void> {
    const next = this.index + delta
    if (next < 0 || next >= this.views.length || next === this.index) return
    this.index = next
    await this.render()
  }

  /** 讓手機端可以直接跳到某一步。 */
  async jumpTo(viewIndex: number): Promise<void> {
    if (viewIndex < 0 || viewIndex >= this.views.length) return
    this.index = viewIndex
    await this.render()
  }

  private async render(): Promise<void> {
    this.lastNavAt = Date.now()
    const view = this.view

    await this.renderHeader()
    // 響鈴中內文歸閃爍畫面管，這裡不能蓋掉它；響完會再重畫一次。
    if (!this.alarms.length) await this.write(BODY.id, BODY.name, this.bodyText())
    await this.renderRail()
    await this.renderFooter()

    // 採購清單、主選單都沒有進度可保存。
    if (this.recipe && view && !this.menu) {
      this.callbacks.onPositionChange?.(this.recipe.id, this.index, view.kind === 'done')
    }
    this.notify()
  }

  private bodyText(): string {
    if (this.menu) {
      const text = this.menuBodyText()
      this.lastMenuBody = text
      return text
    }
    const view = this.view
    if (!view) return idleBody()
    if (view.kind === 'done') return doneBody(this.title)
    return view.body
  }

  // ---- 主選單 ----

  private menuTimers(item: MenuItem): MenuTimer[] {
    if (item.kind !== 'dish') return []
    return bySoonest(this.timers.filter(tm => tm.recipeId === item.id)).map(tm => ({
      stepIndex: tm.stepIndex,
      remaining: remainingSeconds(tm, Date.now()),
    }))
  }

  private menuBodyText(): string {
    const m = this.menu
    return menuBody(m ? (m.items[m.selected] ?? null) : null, m ? this.menuTimersOfSelected() : [])
  }

  private menuTimersOfSelected(): MenuTimer[] {
    const m = this.menu
    const item = m?.items[m.selected]
    return item ? this.menuTimers(item) : []
  }

  /**
   * 長按：開主選單。完成頁的長按等於「這道菜煮完了」——進度早在走到完成頁時就清掉，
   * 這裡再把它的計時器清零並放掉這道菜，選單裡就不會再看到它、返回也回到待命畫面。
   */
  async openMenu(): Promise<void> {
    if (this.menu || this.alarms.length) return
    if (this.recipe && this.view?.kind === 'done') {
      const id = this.recipe.id
      this.cancelTimersFor(id)
      this.recipe = null
      this.views = []
      this.index = 0
      this.title = 'Recipe Glass'
      this.callbacks.onDishClosed?.(id)
    }
    const items = (await this.callbacks.menuItems?.()) ?? []
    // 預設選在「另一道煮到一半的菜」：長按之後馬上點擊，就是在兩道菜之間切換。
    const loaded = this.recipe?.id
    const other = items.findIndex(i => i.kind === 'dish' && i.progress && i.id !== loaded)
    const current = items.findIndex(i => i.id === loaded)
    this.menu = { items, selected: other >= 0 ? other : Math.max(0, current) }
    this.lastMenuBody = ''
    await this.render()
  }

  async closeMenu(): Promise<void> {
    if (!this.menu) return
    this.menu = null
    await this.render()
  }

  private async moveMenu(delta: number): Promise<void> {
    const m = this.menu
    if (!m || !m.items.length) return
    const next = Math.min(Math.max(m.selected + delta, 0), m.items.length - 1)
    if (next === m.selected) return
    m.selected = next
    await this.render()
  }

  private async pickMenuItem(): Promise<void> {
    const m = this.menu
    const item = m?.items[m.selected]
    if (!item) return
    // 選到現在顯示著的這道：不重新載入，直接回到它停著的那一頁。
    if (item.kind === 'dish' && item.id === this.recipe?.id) return this.closeMenu()
    await this.callbacks.onPickMenuItem?.(item)
  }

  /**
   * 這一頁點擊是否該「開始計時」而不是下一頁：有計時、還沒開始、還沒響過，
   * 而且是這一步的最後一頁（步驟內容看完了才開始，不會讀到一半就被搶走點擊）。
   */
  private startableSeconds(): number | null {
    if (!this.timersEnabled) return null
    const view = this.view
    if (!this.recipe || !view || view.kind !== 'step') return null
    if (view.page !== view.pageCount - 1) return null
    const seconds = this.recipe.steps[view.stepIndex]?.timerSeconds
    if (!seconds) return null
    const key = timerKey(this.recipe.id, view.stepIndex)
    if (this.finishedTimers.has(key)) return null
    if (this.timers.some(t => timerKey(t.recipeId, t.stepIndex) === key)) return null
    return seconds
  }

  /**
   * 開始某道菜某一步的計時。眼鏡上點擊、手機上按「開始計時」都走這裡，
   * 所以不限於眼鏡目前顯示的那道菜。已經在跑就不重複開；響過的可以再開一次
   * （從手機明確按下去，就是想再計一次）。
   */
  startTimerFor(recipe: Recipe, stepIndex: number): void {
    const seconds = recipe.steps[stepIndex]?.timerSeconds
    if (!seconds) return
    const key = timerKey(recipe.id, stepIndex)
    if (this.timers.some(t => timerKey(t.recipeId, t.stepIndex) === key)) return
    this.finishedTimers.delete(key)
    this.timers.push({
      recipeId: recipe.id,
      recipeName: recipe.name,
      stepIndex,
      stepText: recipe.steps[stepIndex].text,
      totalSeconds: seconds,
      endsAt: Date.now() + seconds * 1000,
    })
    this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()
    void this.renderFooter()
    this.notify()
  }

  /** 有計時器在跑才每秒醒來，沒有就完全不耗電。 */
  private syncTicker() {
    if (this.timers.length && this.timerHandle === null) {
      this.timerHandle = setInterval(() => this.tick(), TIMER_TICK_MS)
    } else if (!this.timers.length && this.timerHandle !== null) {
      clearInterval(this.timerHandle)
      this.timerHandle = null
    }
  }

  private tick() {
    const { expired, running } = splitExpired(this.timers, Date.now())
    if (!expired.length) {
      void this.renderFooter()
      void this.refreshMenuTimers()
      return
    }
    this.timers = running
    for (const t of expired) this.finishedTimers.add(timerKey(t.recipeId, t.stepIndex))
    this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()
    this.queueAlarms(expired)
    this.notify()
  }

  /** 主選單開著時，倒數每秒在變：只重寫真的變了的欄位（選中項詳情與右欄）。 */
  private async refreshMenuTimers(): Promise<void> {
    if (!this.menu || this.alarms.length) return
    const text = this.menuBodyText()
    if (text !== this.lastMenuBody) {
      this.lastMenuBody = text
      await this.write(BODY.id, BODY.name, text)
    }
    await this.renderRail()
  }

  private queueAlarms(list: RunningTimer[]) {
    const idle = this.alarms.length === 0
    this.alarms.push(...bySoonest(list))
    if (idle) this.startAlarm()
  }

  private startAlarm() {
    const alarm = this.alarms[0]
    if (!alarm) return
    const where =
      alarm.recipeId === this.recipe?.id
        ? t('g.alarmWhereStep', { n: alarm.stepIndex + 1 })
        : t('g.alarmWhereDish', { name: alarm.recipeName, n: alarm.stepIndex + 1 })
    const body = alarmBody(where, alarm.stepText)

    this.alarmUntil = Date.now() + ALARM_DURATION_MS
    this.alarmPhase = true
    if (this.alarmHandle !== null) clearInterval(this.alarmHandle)
    this.alarmHandle = setInterval(() => {
      if (Date.now() >= this.alarmUntil) {
        void this.dismissAlarm()
        return
      }
      this.alarmPhase = !this.alarmPhase
      // 整片亮 / 整片暗的交替，是沒有喇叭時唯一能引起注意的手段。
      void this.write(BODY.id, BODY.name, this.alarmPhase ? body : '')
    }, ALARM_BLINK_MS)
    void this.write(BODY.id, BODY.name, body)
    void this.renderFooter()
    this.notify()
  }

  /**
   * 按掉目前這個；後面還有同時到期的就接著響下一個，都響完才回到原畫面。
   * 手機上的「知道了」也呼叫這個。
   */
  async dismissAlarm(): Promise<void> {
    if (!this.alarms.length) return
    if (this.alarmHandle !== null) {
      clearInterval(this.alarmHandle)
      this.alarmHandle = null
    }
    this.alarms.shift()
    if (this.alarms.length) {
      this.startAlarm()
      return
    }
    await this.render()
  }

  /**
   * 標頭左半（食譜名／步驟數）加右側時間。
   *
   * 由 `render()`（畫面切換）與時間輪詢兩邊共用，兩邊都只在文字真的變了
   * 才寫入——閒置時每 20 秒醒一次，分鐘沒跳動就不必送這次藍牙封包。
   */
  private async renderHeader(): Promise<void> {
    const stepTotal = this.recipe?.steps.length ?? 0
    const text = this.menu
      ? menuHeaderText(this.menu.selected, this.menu.items.length, new Date())
      : headerText(this.title, stepTotal, this.view, new Date())
    if (text === this.lastHeader) return
    this.lastHeader = text
    await this.write(HEADER.id, HEADER.name, text)
  }

  /** 只寫內容或亮度真的變了的格子，避免每翻一頁就五次藍牙往返。 */
  private async renderRail(): Promise<void> {
    const view = this.view
    const slots = this.menu
      ? menuRail(this.menu.items, this.menu.selected, item => this.menuTimers(item)[0] ?? null)
      : railSlots(this.recipe, view ? currentStepOf(view, this.recipe?.steps.length ?? 0) : -1)
    for (let i = 0; i < slots.length; i++) {
      const next = slots[i]
      const prev = this.lastRail[i]
      if (prev && prev.content === next.content && prev.brightness === next.brightness) continue
      this.lastRail[i] = { ...next }
      await this.write(RAIL.firstId + i, `r${i}`, next.content, next.brightness)
    }
  }

  private footer(): string {
    if (this.alarms.length) return alarmFooter()
    return footerText({
      view: this.view,
      timer: this.footerTimer(),
      startable: this.startableSeconds(),
      menu: this.menu !== null,
    })
  }

  /** 頁尾只放得下一個計時器：顯示最快到的那個，其他的用「+N」帶過。 */
  private footerTimer(): FooterTimer | null {
    if (!this.timers.length) return null
    const [first, ...rest] = bySoonest(this.timers)
    const view = this.view
    const currentStep = view ? currentStepOf(view, this.recipe?.steps.length ?? 0) : -1
    const { label, short } = timerLabel(first, this.recipe?.id ?? null, currentStep)
    return {
      remaining: remainingSeconds(first, Date.now()),
      total: first.totalSeconds,
      label,
      labelShort: short,
      others: rest.length,
    }
  }

  private async renderFooter(): Promise<void> {
    const text = this.footer()
    if (text === this.lastFooter) return
    this.lastFooter = text
    await this.write(FOOTER.id, FOOTER.name, text)
  }

  /** `brightness` 省略表示保持容器目前的亮度，不必每次都送。 */
  private write(
    containerID: number,
    containerName: string,
    content: string,
    brightness?: number,
  ): Promise<unknown> {
    this.writing = this.writing
      .then(() =>
        this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID,
            containerName,
            content,
            ...(brightness === undefined ? {} : { textColor: brightness }),
          }),
        ),
      )
      .catch(err => console.error('textContainerUpgrade 失敗：', err))
    return this.writing
  }

  dispose() {
    if (this.alarmHandle !== null) {
      clearInterval(this.alarmHandle)
      this.alarmHandle = null
    }
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle)
      this.timerHandle = null
    }
    if (this.clockHandle !== null) {
      clearInterval(this.clockHandle)
      this.clockHandle = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

/**
 * 從單一信封讀出事件型別。
 *
 * CLICK_EVENT 是 0，protobuf 在線路上會省略零值欄位，所以單擊送來的封包
 * 根本沒有 eventType。預設值必須在「信封存在」的檢查「內部」解析 ——
 * 寫成 `event.sysEvent?.eventType ?? CLICK_EVENT` 會讓所有沒有 sysEvent 的
 * 事件（滾動、生命週期、音訊）都被當成單擊。
 */
function typeOf(envelope?: EventEnvelope): OsEventTypeList | null {
  if (!envelope) return null
  const raw = envelope.eventType
  if (raw === undefined || raw === null) return OsEventTypeList.CLICK_EVENT
  if (typeof raw === 'number') return raw
  // 宿主有時送字串（"CLICK_EVENT"、"CLICK"），交給 SDK 的正規化。
  return OsEventTypeList.fromJson(raw) ?? OsEventTypeList.CLICK_EVENT
}
