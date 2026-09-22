import { measureTextWrap } from '@evenrealities/pretext'
import type { Recipe } from '../core/types'
import { formatClock } from '../core/timer'
import { paginate, paginateLines } from './paginate'

/** 版面幾何。改這裡就好，分頁會跟著重算。 */
export const HEADER = { x: 0, y: 0, w: 576, h: 32, pad: 4, id: 1, name: 'header' } as const
/** 左欄。寬度從滿版 576 縮到 400，右邊讓給步驟進度欄。 */
export const BODY = { x: 0, y: 34, w: 400, h: 214, pad: 4, id: 2, name: 'body' } as const
export const FOOTER = { x: 0, y: 252, w: 576, h: 34, pad: 4, id: 3, name: 'footer' } as const

/**
 * 右欄：步驟進度。
 *
 * 格數固定 5 格，長食譜用視窗捲動而不是加開容器。
 *
 * 容器數量上限是 8 個文字容器（SDK 型別註解：textObject 最多 8 項；
 * 「12」是含最多 4 個圖片容器的組合上限，純文字沒有圖片時仍是 8）。
 * header/body/footer 佔 3 個，右欄最多只能開 5 格。這個上限在模擬器上
 * 實測撞到過：6 格會讓 createStartUpPageContainer 回傳 1（invalid）。
 *
 * 另外增減容器只能靠 rebuildPageContainer，那會整頁閃一下，所以格數
 * 固定不隨步驟數變動。
 */
export const RAIL = {
  x: 408,
  w: 168,
  h: 30,
  pad: 2,
  top: 34,
  /** 相鄰兩格的間距（含 1px 縫）。 */
  pitch: 31,
  slots: 5,
  /** 容器 id 4~8；header/body/footer 佔掉 1~3，總共 8 個，等於上限。 */
  firstId: 4,
} as const

/**
 * 文字亮度，對應 SDK 的 TextContainerProperty.textColor（0~4，預設 4）。
 * TextContainerUpgrade 也吃這個欄位，所以可以就地調亮調暗不必重建頁面。
 */
export const BRIGHTNESS = {
  /** 目前步驟、左欄內文 */
  bright: 4,
  /** 標頭 */
  header: 3,
  /** 還沒做到的步驟、頁尾 */
  dim: 2,
  /** 已完成的步驟 */
  done: 1,
} as const

export const BODY_INNER = {
  width: BODY.w - 2 * BODY.pad,
  height: BODY.h - 2 * BODY.pad,
}

export const RAIL_INNER_W = RAIL.w - 2 * RAIL.pad

export type View =
  | { kind: 'empty'; body: string }
  | { kind: 'ingredients'; body: string; page: number; pageCount: number }
  | { kind: 'step'; stepIndex: number; body: string; page: number; pageCount: number }
  | { kind: 'shopping'; body: string; page: number; pageCount: number }
  | { kind: 'done'; body: string }

/**
 * 把一份食譜攤平成一串可以用「點擊前進 / 上滑後退」走完的畫面。
 *
 * 攤平的好處是導覽只剩一個整數索引：進度保存、背景還原、上一頁下一頁
 * 全都變成加減一，不用同時追蹤「哪一個步驟」和「步驟內第幾頁」兩個狀態。
 */
export function buildViews(recipe: Recipe): View[] {
  const views: View[] = []

  if (recipe.ingredients.length) {
    // 標題和食材一起交給行打包器，第一頁才不會只放一行標題就換頁。
    const lines = [
      `食材（${recipe.servings} 人份）`,
      ...recipe.ingredients.map(i => (i.amount ? `· ${i.item}  ${i.amount}` : `· ${i.item}`)),
    ]
    const pages = paginateLines(lines, BODY_INNER)
    pages.forEach((body, page) =>
      views.push({ kind: 'ingredients', body, page, pageCount: pages.length }),
    )
  }

  recipe.steps.forEach((step, stepIndex) => {
    const parts = [step.text]
    if (step.tip) parts.push(`● ${step.tip}`)
    const pages = paginate(parts.join('\n\n'), BODY_INNER)
    pages.forEach((body, page) =>
      views.push({ kind: 'step', stepIndex, body, page, pageCount: pages.length }),
    )
  })

  views.push({ kind: 'done', body: `${recipe.name}\n\n完成了。\n雙擊離開。` })

  if (!views.length) views.push({ kind: 'empty', body: '這份食譜沒有內容。' })
  return views
}

export function headerText(title: string, stepTotal: number, view: View): string {
  switch (view.kind) {
    case 'ingredients':
      return `${title} · 食材`
    case 'step':
      return `${title} · 步驟 ${view.stepIndex + 1}/${stepTotal}`
    case 'shopping':
      return view.pageCount > 1 ? `${title} ${view.page + 1}/${view.pageCount}` : title
    case 'done':
      return `${title} · 完成`
    default:
      return title
  }
}

/**
 * 採購清單的畫面。沒有步驟、沒有計時，就是一份可以翻頁的清單 ——
 * 逛超市時抬頭看得到要買什麼，雙手還能推推車。
 */
export function buildShoppingViews(lines: string[]): View[] {
  if (!lines.length) {
    return [{ kind: 'empty', body: '採購清單是空的。\n\n在手機上把食譜的食材加進來。' }]
  }
  const pages = paginateLines(lines, BODY_INNER)
  return pages.map((body, page) => ({
    kind: 'shopping' as const,
    body,
    page,
    pageCount: pages.length,
  }))
}

export interface FooterState {
  /** 剩餘秒數；null 代表這一步沒有計時。 */
  remaining: number | null
  /** 這一步設定的總秒數，用來畫進度條。 */
  total: number | null
  view: View
}

/**
 * 用框線字元畫倒數進度條。
 *
 * 刻意不用 ⏱ —— 那是 emoji，韌體字型很可能沒有，而 G2 缺字是靜默略過，
 * 不報錯直接消失。━ 與 ─ 是官方設計文件明列可用的字元，而且比單純顯示
 * 剩餘秒數多給一個「還要等多久」的體感。
 */
function progressBar(remaining: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return ''
  const elapsed = Math.max(0, Math.min(1, (total - remaining) / total))
  const filled = Math.round(elapsed * width)
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

const HINT_FULL = '點擊下一頁 · 上滑回上頁 · 雙擊離開'
const HINT_SHORT = '點擊繼續 · 雙擊離開'
const HINT_MINIMAL = '雙擊離開'

/**
 * 頁尾容器只有一行高（34px），LVGL 不會自動把溢出的文字截斷成省略號，
 * 就是整段直接被裁掉、悄悄消失 —— 跟中文缺字一樣的「靜默失敗」。
 *
 * 時間、進度條、頁碼、操作提示四樣疊在一起，某些組合（尤其是長時間格式
 * 「150:00」加滿版進度條加完整提示）量出來會超過一行寬度。與其賭一個
 * 固定的進度條寬度，不如照「使用者最需要看到什麼」的順序，實際量測
 * 每個候選組合，選第一個放得下的 —— 進度條先讓步，再來是把導覽提示
 * 縮短，時間本身永遠保留。
 */
function fitFooter(left: string, hint: string, innerWidth: number): string {
  const candidates = [
    hint,
    hint === HINT_FULL ? HINT_SHORT : null,
    HINT_MINIMAL,
  ].filter((h): h is string => h !== null)

  for (const h of candidates) {
    const text = left ? `${left}  ·  ${h}` : h
    if (measureTextWrap(text, innerWidth).lineCount <= 1) return text
  }
  // 連最短的提示都放不下時，至少保住左半部資訊，提示整個捨棄。
  return left || HINT_MINIMAL
}

export function footerText(
  { remaining, total, view }: FooterState,
  innerWidth = FOOTER.w - 2 * FOOTER.pad,
): string {
  const pageSuffix =
    (view.kind === 'ingredients' || view.kind === 'step' || view.kind === 'shopping') &&
    view.pageCount > 1
      ? `  ${view.page + 1}/${view.pageCount}`
      : ''
  const hint = view.kind === 'done' ? HINT_MINIMAL : HINT_FULL

  if (remaining === null) {
    return fitFooter(pageSuffix.trim(), hint, innerWidth)
  }

  const clock = formatClock(remaining)
  // 進度條寬度依序讓步：8 格放不下就試 5 格，再放不下就乾脆不畫條，只留時間。
  for (const barWidth of total ? [8, 5, 0] : [0]) {
    const bar = progressBar(remaining, total ?? 0, barWidth)
    const left = `${clock}${bar ? ` ${bar}` : ''}${pageSuffix}`
    const fitted = fitFooter(left, hint, innerWidth)
    if (measureTextWrap(fitted, innerWidth).lineCount <= 1) return fitted
  }
  // 極端情況：退到只顯示時間本身。
  return clock
}

export interface RailSlot {
  content: string
  brightness: number
}

/**
 * 取出這一步在做什麼：切到第一個標點為止。
 *
 * 韌體只有一種字型也不能改字級，右欄放不下整句，只能截。切在標點處
 * 通常剛好就是動作本身（「炒蛋至七分熟。油要多一點」→「炒蛋至七分熟」）。
 */
export function stepLabel(text: string): string {
  return text.split(/[，。：；、\n]/)[0].trim() || text.trim()
}

/**
 * 韌體字型的省略號用 ASCII 三個句點，不用「…」（U+2026）。
 *
 * 這是模擬器上實測到的：「…」在這個字型裡不是真的省略號字形，量測寬度
 * 正確但畫出來是一條細直線 —— 跟中文缺字一樣的「量得到、畫不出來」。
 * 三個句點是安全字元，任何字型都有。
 */
const ELLIPSIS = '...'

/**
 * 逐字退到真的放得下為止。
 *
 * 不用數字元的方式判斷，因為字寬不等：兩位數的步驟編號就比一位數寬，
 * 「10 慢燉兩個半小時」會溢出而「9 慢燉兩個半小時」不會。改用 LVGL 的
 * 真實字寬量測，換字型或改欄寬都不必重新調常數。
 */
function fitLabel(label: string, width: number): string {
  if (measureTextWrap(label, width).lineCount <= 1) return label
  for (let len = label.length - 1; len > 0; len--) {
    const candidate = `${label.slice(0, len)}${ELLIPSIS}`
    if (measureTextWrap(candidate, width).lineCount <= 1) return candidate
  }
  return ELLIPSIS
}

/**
 * 算出右欄六格該顯示什麼、各自多亮。
 *
 * `currentStep` 用一個整數涵蓋三種狀態：-1 還沒開始（食材頁），
 * 0~n-1 正在某一步，n 全部完成。這樣就不必為了「沒有目前步驟」
 * 另外開一個可空欄位。
 */
export function railSlots(recipe: Recipe | null, currentStep: number): RailSlot[] {
  const blank = (): RailSlot => ({ content: '', brightness: BRIGHTNESS.dim })
  const steps = recipe?.steps ?? []
  if (!steps.length) return Array.from({ length: RAIL.slots }, blank)

  // 視窗捲動：目前步驟前面留兩格，看得到剛做完什麼，也看得到接下來三步。
  const start =
    steps.length <= RAIL.slots
      ? 0
      : Math.min(Math.max(currentStep - 2, 0), steps.length - RAIL.slots)

  return Array.from({ length: RAIL.slots }, (_, i) => {
    const at = start + i
    if (at >= steps.length) return blank()
    const brightness =
      at === currentStep
        ? BRIGHTNESS.bright
        : at < currentStep
          ? BRIGHTNESS.done
          : BRIGHTNESS.dim
    // 編號與標題一起量，因為兩位數的編號會吃掉一個字的寬度。
    const content = fitLabel(`${at + 1} ${stepLabel(steps[at].text)}`, RAIL_INNER_W)
    return { content, brightness }
  })
}

/** 從畫面推出目前走到第幾步，給 railSlots 用。 */
export function currentStepOf(view: View, stepTotal: number): number {
  switch (view.kind) {
    case 'step':
      return view.stepIndex
    case 'done':
      return stepTotal
    default:
      return -1
  }
}

/**
 * 計時結束的閃爍畫面。G2 沒有喇叭，只能靠視覺。
 *
 * 不用 ⏱ —— 跟頁尾進度條同一個理由：那是 emoji，韌體字型很可能沒有，
 * 缺字是靜默略過，不報錯直接消失。
 */
export function alarmBody(step: string): string {
  return `時 間 到\n\n${step}`
}
