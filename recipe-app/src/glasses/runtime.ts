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
import {
  ALARM_FOOTER,
  alarmBody,
  BODY,
  BRIGHTNESS,
  FOOTER,
  HEADER,
  IDLE_BODY,
  RAIL,
  buildShoppingViews,
  buildViews,
  currentStepOf,
  footerText,
  headerText,
  railSlots,
  timerLabel,
  type FooterTimer,
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
  eventType?: OsEventTypeList
}
interface EvenEvent {
  sysEvent?: EventEnvelope
  textEvent?: EventEnvelope
}

/** 計時結束後閃爍多久（毫秒），以及每次切換的間隔。 */
const ALARM_DURATION_MS = 10_000
const ALARM_BLINK_MS = 600
/** 標頭時間更新間隔。只顯示到分鐘，不必秒更新，省藍牙流量。 */
const CLOCK_TICK_MS = 20_000
const TIMER_TICK_MS = 1_000
/**
 * App 關著的時候到期的計時器，重開時還在這段時間內就補響；更早的就不響了，
 * 免得隔天打開 App 還在對昨天的菜閃「時間到」。
 */
const LATE_ALARM_GRACE_MS = 30 * 60_000

export interface RuntimeCallbacks {
  /** 位置變動時通知外層做進度保存。`finished` 代表走到了「完成」頁。 */
  onPositionChange?: (recipeId: string, viewIndex: number, finished: boolean) => void
  onExit?: () => void
  /** 長按：使用者想切換到另一道也在煮的食譜，不影響目前這份的進度。 */
  onSwitchRecipe?: () => void
  /** 計時器開始或到期時通知外層落盤，App 重開也接得回來。 */
  onTimersChange?: (timers: RunningTimer[]) => void
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
  /** 有沒有另一道也在煮的食譜可以長按切過去，決定頁尾提示要不要提「長按切換」。 */
  private canSwitch = false

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
          mk(BODY, IDLE_BODY, 1, BRIGHTNESS.bright),
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
    this.recipe = recipe
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
    this.recipe = null
    this.title = '採購清單'
    this.views = buildShoppingViews(lines)
    this.index = 0
    await this.render()
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
  }

  /** 食譜被刪掉時，它的計時器也沒必要再響。 */
  cancelTimersFor(recipeId: string): void {
    const before = this.timers.length
    this.timers = this.timers.filter(t => t.recipeId !== recipeId)
    if (this.timers.length === before) return
    this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()
    void this.renderFooter()
  }

  /**
   * 外層（`main.ts`）在有進度的食譜集合改變時呼叫，更新頁尾要不要提示
   * 「長按切換」。只在真的變了才重畫頁尾，避免每次翻頁都多寫一次。
   */
  setSwitchable(canSwitch: boolean): void {
    if (this.canSwitch === canSwitch) return
    this.canSwitch = canSwitch
    void this.renderFooter()
  }

  get currentIndex() {
    return this.index
  }

  get loadedRecipeId() {
    return this.recipe?.id ?? null
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
      const sysType = typeOf(event.sysEvent)
      const textType = typeOf(event.textEvent)
      const is = (type: OsEventTypeList) => sysType === type || textType === type

      // 雙擊離開放在最前面：不論事件從哪個信封來，使用者都必須能退出。
      if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
        this.dispose()
        this.bridge.shutDownPageContainer(1)
        this.callbacks.onExit?.()
        return
      }

      // 正在響鈴時，任何動作都先當作「我知道了」，不翻頁也不切換食譜。
      if (this.alarms.length) {
        if (
          textType === OsEventTypeList.SCROLL_TOP_EVENT ||
          textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
          is(OsEventTypeList.CLICK_EVENT) ||
          is(OsEventTypeList.LONG_PRESS_EVENT)
        ) {
          void this.dismissAlarm()
        }
        return
      }

      if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
        void this.go(-1)
        return
      }
      // 下滑永遠是下一頁——有計時的步驟不想計時，就用下滑跳過。
      if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        void this.go(1)
        return
      }
      // 長按：切換到另一道也在煮的食譜。跟點擊、雙擊是不同手勢，不會互相干擾。
      if (is(OsEventTypeList.LONG_PRESS_EVENT)) {
        this.callbacks.onSwitchRecipe?.()
        return
      }
      // CLICK_EVENT 是 0，protobuf 會省略零值，所以它是「沒有型別」的退路，
      // 一定要放在所有具名事件之後才判斷。
      if (is(OsEventTypeList.CLICK_EVENT)) {
        if (this.startableSeconds() !== null) this.startTimer()
        else void this.go(1)
        return
      }
      if (
        sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.dispose()
        this.callbacks.onExit?.()
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
    const view = this.view
    const stepTotal = this.recipe?.steps.length ?? 0

    await this.renderHeader()
    // 響鈴中內文歸閃爍畫面管，這裡不能蓋掉它；響完會再重畫一次。
    if (!this.alarms.length) await this.write(BODY.id, BODY.name, view?.body ?? IDLE_BODY)
    await this.renderRail(view ? currentStepOf(view, stepTotal) : -1)
    await this.renderFooter()

    // 採購清單沒有進度可保存。
    if (this.recipe && view) {
      this.callbacks.onPositionChange?.(this.recipe.id, this.index, view.kind === 'done')
    }
  }

  /**
   * 這一頁點擊是否該「開始計時」而不是下一頁：有計時、還沒開始、還沒響過，
   * 而且是這一步的最後一頁（步驟內容看完了才開始，不會讀到一半就被搶走點擊）。
   */
  private startableSeconds(): number | null {
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

  private startTimer() {
    const view = this.view
    const seconds = this.startableSeconds()
    if (!this.recipe || !view || view.kind !== 'step' || seconds === null) return
    this.timers.push({
      recipeId: this.recipe.id,
      recipeName: this.recipe.name,
      stepIndex: view.stepIndex,
      stepText: this.recipe.steps[view.stepIndex].text,
      totalSeconds: seconds,
      endsAt: Date.now() + seconds * 1000,
    })
    this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()
    void this.renderFooter()
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
      return
    }
    this.timers = running
    for (const t of expired) this.finishedTimers.add(timerKey(t.recipeId, t.stepIndex))
    this.callbacks.onTimersChange?.(this.timers)
    this.syncTicker()
    this.queueAlarms(expired)
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
        ? `步驟 ${alarm.stepIndex + 1}`
        : `${alarm.recipeName} · 步驟 ${alarm.stepIndex + 1}`
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
  }

  /** 按掉目前這個；後面還有同時到期的就接著響下一個，都響完才回到原畫面。 */
  private async dismissAlarm() {
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
    const text = headerText(this.title, stepTotal, this.view, new Date())
    if (text === this.lastHeader) return
    this.lastHeader = text
    await this.write(HEADER.id, HEADER.name, text)
  }

  /** 只寫內容或亮度真的變了的格子，避免每翻一頁就五次藍牙往返。 */
  private async renderRail(currentStep: number): Promise<void> {
    const slots = railSlots(this.recipe, currentStep)
    for (let i = 0; i < slots.length; i++) {
      const next = slots[i]
      const prev = this.lastRail[i]
      if (prev && prev.content === next.content && prev.brightness === next.brightness) continue
      this.lastRail[i] = { ...next }
      await this.write(RAIL.firstId + i, `r${i}`, next.content, next.brightness)
    }
  }

  private footer(): string {
    if (this.alarms.length) return ALARM_FOOTER
    return footerText({
      view: this.view,
      timer: this.footerTimer(),
      startable: this.startableSeconds(),
      canSwitch: this.canSwitch,
    })
  }

  /** 頁尾只放得下一個計時器：顯示最快到的那個，其他的用「+N」帶過。 */
  private footerTimer(): FooterTimer | null {
    if (!this.timers.length) return null
    const [first, ...rest] = bySoonest(this.timers)
    const view = this.view
    const currentStep = view ? currentStepOf(view, this.recipe?.steps.length ?? 0) : -1
    return {
      remaining: remainingSeconds(first, Date.now()),
      total: first.totalSeconds,
      label: timerLabel(first, this.recipe?.id ?? null, currentStep),
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
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
