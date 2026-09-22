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
  FOOTER,
  HEADER,
  buildShoppingViews,
  buildViews,
  footerText,
  headerText,
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

export interface RuntimeCallbacks {
  /** 位置變動時通知外層做進度保存與手機端鏡像。 */
  onPositionChange?: (recipeId: string, viewIndex: number) => void
  onExit?: () => void
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
  /** 序列化 bridge 寫入，使用者連點時避免兩次更新互相覆蓋。 */
  private writing: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private timer: StepTimer

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
      c: typeof HEADER | typeof BODY | typeof FOOTER,
      content: string,
      capture: 0 | 1,
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
      })

    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [
          mk(HEADER, 'Recipe Glass', 0),
          // 三個容器裡必須剛好有一個設 isEventCapture: 1。
          mk(BODY, '在手機上選一份食譜開始。', 1),
          mk(FOOTER, '雙擊離開', 0),
        ],
      }),
    )
    if (result !== 0) {
      console.error('createStartUpPageContainer 失敗：', result)
      return false
    }
    this.listen()
    return true
  }

  /** 載入食譜並跳到指定畫面（例如還原上次進度）。 */
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

      // 正在響鈴時，任何前進動作都先當作「我知道了」，不翻頁。
      if (this.alarmHandle !== null) {
        if (
          textType === OsEventTypeList.SCROLL_TOP_EVENT ||
          textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
          sysType === OsEventTypeList.CLICK_EVENT ||
          textType === OsEventTypeList.CLICK_EVENT
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
    await this.write(HEADER.id, HEADER.name, headerText(this.title, stepTotal, view))
    await this.write(BODY.id, BODY.name, view.body)
    await this.renderFooter()

    // 採購清單沒有進度可保存。
    if (this.recipe) this.callbacks.onPositionChange?.(this.recipe.id, this.index)
  }

  /**
   * 進入某個步驟的第一頁才起算倒數；同一步驟內翻頁不重置，
   * 離開步驟則停止 —— 使用者不必為了計時多做任何操作。
   */
  private syncTimerFor(view: View) {
    if (view.kind !== 'step') {
      this.timer.stop()
      return
    }
    const seconds = this.recipe?.steps[view.stepIndex]?.timerSeconds
    if (!seconds) {
      this.timer.stop()
      return
    }
    if (view.page === 0) this.timer.start(seconds)
  }

  private async renderFooter(): Promise<void> {
    const view = this.view
    if (!view) return
    await this.write(
      FOOTER.id,
      FOOTER.name,
      footerText({ remaining: this.timer.running ? this.timer.remaining() : null, view }),
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

  private write(containerID: number, containerName: string, content: string): Promise<unknown> {
    this.writing = this.writing
      .then(() =>
        this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID, containerName, content }),
        ),
      )
      .catch(err => console.error('textContainerUpgrade 失敗：', err))
    return this.writing
  }

  dispose() {
    this.stopAlarm()
    this.timer.stop()
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
