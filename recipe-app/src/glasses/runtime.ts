import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { StepTimer } from '../core/timer'
import type { Recipe } from '../core/types'
import {
  alarmBody,
  BODY,
  BRIGHTNESS,
  FOOTER,
  HEADER,
  RAIL,
  buildShoppingViews,
  buildViews,
  currentStepOf,
  footerText,
  headerText,
  railSlots,
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

export interface RuntimeCallbacks {
  /** 位置變動時通知外層做進度保存與手機端鏡像。 */
  onPositionChange?: (recipeId: string, viewIndex: number) => void
  onExit?: () => void
  /** 長按：使用者想切換到另一道也在煮的食譜，不影響目前這份的進度。 */
  onSwitchRecipe?: () => void
}

/**
 * 眼鏡端的執行時期：持有三個容器，負責導覽、計時與事件路由。
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
  private timer: StepTimer
  /** 標頭右側時間，即使使用者不操作也要每隔一段時間自己刷新。 */
  private clockHandle: ReturnType<typeof setInterval> | null = null
  private lastHeader = ''
  /**
   * `load()` 傳入的計時器續接時間，只在緊接著的那次 `render()` 用一次。
   * 一般翻頁（`go()`）不會設定它，所以正常進入新步驟時計時器照常重新起算，
   * 只有切換食譜或背景還原這種「回到同一步」的情境才會接續而不是重來。
   */
  private pendingTimerEndsAt: number | null = null
  /** 有沒有另一道也在煮的食譜可以長按切過去，決定頁尾提示要不要提「長按切換」。 */
  private canSwitch = false

  constructor(
    private readonly bridge: GlassesBridge,
    private readonly callbacks: RuntimeCallbacks = {},
  ) {
    this.timer = new StepTimer(
      () => void this.renderFooter(),
      () => this.startAlarm(),
    )
  }

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
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3 + RAIL.slots,
        textObject: [
          mk(HEADER, this.lastHeader, 0, BRIGHTNESS.header),
          // 所有容器裡必須剛好有一個設 isEventCapture: 1。
          mk(BODY, '在手機上選一份食譜開始。', 1, BRIGHTNESS.bright),
          mk(FOOTER, '雙擊離開', 0, BRIGHTNESS.dim),
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

  /**
   * 載入食譜並跳到指定畫面（例如還原上次進度、或切換到另一道食譜）。
   *
   * `timerEndsAt` 有值且還沒過期時，落在的那個步驟若有計時器會從這個絕對
   * 時間續接倒數，而不是從整段秒數重新起算——不然切換食譜或背景還原時，
   * 正在燉的東西看起來會被「重設」成剛開始煮。
   */
  async load(recipe: Recipe, viewIndex = 0, timerEndsAt?: number): Promise<void> {
    this.recipe = recipe
    this.title = recipe.name
    this.views = buildViews(recipe)
    this.index = Math.min(Math.max(0, viewIndex), this.views.length - 1)
    this.pendingTimerEndsAt = timerEndsAt && timerEndsAt > Date.now() ? timerEndsAt : null
    await this.render()
  }

  /**
   * 改為顯示採購清單。
   *
   * 把 recipe 清成 null，計時與進度保存就自動失效 —— 採購清單沒有步驟
   * 也不需要倒數，不必為它多開一套狀態。
   */
  async loadShoppingList(lines: string[]): Promise<void> {
    this.recipe = null
    this.title = '採購清單'
    this.timer.stop()
    this.views = buildShoppingViews(lines)
    this.index = 0
    await this.render()
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

  /** 背景還原用：倒數的絕對結束時間。 */
  get timerEndsAt() {
    return this.timer.endsAtTimestamp
  }

  private get view(): View | null {
    return this.views[this.index] ?? null
  }

  private listen() {
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const sysType = typeOf(event.sysEvent)
      const textType = typeOf(event.textEvent)

      // 雙擊離開放在最前面：不論事件從哪個信封來，使用者都必須能退出。
      if (
        sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType === OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        this.dispose()
        this.bridge.shutDownPageContainer(1)
        this.callbacks.onExit?.()
        return
      }

      // 正在響鈴時，任何前進動作都先當作「我知道了」，不翻頁也不切換食譜。
      if (this.alarmHandle !== null) {
        if (
          textType === OsEventTypeList.SCROLL_TOP_EVENT ||
          textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
          sysType === OsEventTypeList.CLICK_EVENT ||
          textType === OsEventTypeList.CLICK_EVENT ||
          sysType === OsEventTypeList.LONG_PRESS_EVENT ||
          textType === OsEventTypeList.LONG_PRESS_EVENT
        ) {
          this.stopAlarm()
          void this.render()
        }
        return
      }

      if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
        void this.go(-1)
        return
      }
      if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        void this.go(1)
        return
      }
      // 長按：切換到另一道也在煮的食譜。跟點擊、雙擊是不同手勢，不會互相干擾。
      if (
        sysType === OsEventTypeList.LONG_PRESS_EVENT ||
        textType === OsEventTypeList.LONG_PRESS_EVENT
      ) {
        this.callbacks.onSwitchRecipe?.()
        return
      }
      // CLICK_EVENT 是 0，protobuf 會省略零值，所以它是「沒有型別」的退路，
      // 一定要放在所有具名事件之後才判斷。
      if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
        void this.go(1)
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
    if (!view) return

    this.stopAlarm()
    this.syncTimerFor(view)

    const stepTotal = this.recipe?.steps.length ?? 0
    await this.renderHeader()
    await this.write(BODY.id, BODY.name, view.body)
    await this.renderRail(currentStepOf(view, stepTotal))
    await this.renderFooter()

    // 採購清單沒有進度可保存。
    if (this.recipe) this.callbacks.onPositionChange?.(this.recipe.id, this.index)
  }

  /**
   * 進入某個步驟的第一頁才起算倒數；同一步驟內翻頁不重置，
   * 離開步驟則停止 —— 使用者不必為了計時多做任何操作。
   */
  private syncTimerFor(view: View) {
    const resumeAt = this.pendingTimerEndsAt
    this.pendingTimerEndsAt = null

    if (view.kind !== 'step') {
      this.timer.stop()
      return
    }
    const seconds = this.recipe?.steps[view.stepIndex]?.timerSeconds
    if (!seconds) {
      this.timer.stop()
      return
    }
    if (view.page === 0) this.timer.start(seconds, resumeAt ?? undefined)
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

  /** 只寫內容或亮度真的變了的格子，避免每翻一頁就六次藍牙往返。 */
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

  private async renderFooter(): Promise<void> {
    const view = this.view
    if (!view) return
    const running = this.timer.running
    const total =
      running && view.kind === 'step'
        ? (this.recipe?.steps[view.stepIndex]?.timerSeconds ?? null)
        : null
    await this.write(
      FOOTER.id,
      FOOTER.name,
      footerText({
        remaining: running ? this.timer.remaining() : null,
        total,
        view,
        canSwitch: this.canSwitch,
      }),
    )
  }

  private startAlarm() {
    const view = this.view
    if (!view || view.kind !== 'step') return
    const stepText = this.recipe?.steps[view.stepIndex]?.text ?? ''

    this.alarmUntil = Date.now() + ALARM_DURATION_MS
    this.alarmPhase = false
    this.alarmHandle = setInterval(() => {
      if (Date.now() >= this.alarmUntil) {
        this.stopAlarm()
        void this.render()
        return
      }
      this.alarmPhase = !this.alarmPhase
      // 整片亮 / 整片暗的交替，是沒有喇叭時唯一能引起注意的手段。
      void this.write(BODY.id, BODY.name, this.alarmPhase ? alarmBody(stepText) : '')
    }, ALARM_BLINK_MS)
    void this.write(FOOTER.id, FOOTER.name, '時間到 · 點擊繼續')
  }

  private stopAlarm() {
    if (this.alarmHandle !== null) {
      clearInterval(this.alarmHandle)
      this.alarmHandle = null
    }
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
    this.stopAlarm()
    this.timer.stop()
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
