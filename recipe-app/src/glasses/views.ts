import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { t } from '../i18n'
import type { Recipe } from '../core/types'
import { formatClock, formatDuration } from '../core/timer'
import { paginate, paginateLines } from './paginate'

/** 版面幾何。改這裡就好，分頁會跟著重算。 */
/*
 * 每個只放一行字的容器，內高都要至少 36px（高度 − 上下 padding）。
 * 實機字型的行高比模擬器高：內高 24～26px 時一行字放不下，韌體會在容器右緣
 * 畫出捲軸，看起來就是一條一條的。右欄改成 40px 高之後條紋消失，標頭和頁尾
 * 也比照辦理（實機回報：條紋只剩時間右邊與「雙擊離開」右邊）。
 */
export const HEADER = { x: 0, y: 0, w: 576, h: 40, pad: 2, id: 1, name: 'header' } as const
/** 左欄。寬度從滿版 576 縮到 400，右邊讓給步驟進度欄。 */
export const BODY = { x: 0, y: 40, w: 400, h: 208, pad: 4, id: 2, name: 'body' } as const
export const FOOTER = { x: 0, y: 248, w: 576, h: 40, pad: 2, id: 3, name: 'footer' } as const

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
  /**
   * 每格 38px 高、padding 1px，內高 36px。原本 30px 在模擬器上剛好放得下一行，
   * 但實機字型的行高比較高，一行字放不下時韌體會在右緣畫捲軸，看起來一條一條的。
   */
  h: 38,
  pad: 1,
  top: 40,
  /** 相鄰兩格的間距（含 4px 縫）。40 + 4×42 + 38 = 246，頁尾從 248 開始。 */
  pitch: 42,
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
      t('g.ingredientsHeading', { n: recipe.servings }),
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

  views.push({ kind: 'done', body: doneBody(recipe.name) })

  if (!views.length) views.push({ kind: 'empty', body: t('g.emptyRecipe') })
  return views
}

function headerLeftText(title: string, stepTotal: number, view: View | null): string {
  if (!view) return title
  switch (view.kind) {
    case 'ingredients':
      return t('g.hdrIngredients', { title })
    case 'step':
      return t('g.hdrStep', { title, n: view.stepIndex + 1, total: stepTotal })
    case 'shopping':
      return view.pageCount > 1 ? `${title} ${view.page + 1}/${view.pageCount}` : title
    case 'done':
      return t('g.hdrDone', { title })
    default:
      return title
  }
}

export function formatClockTime(now: Date): string {
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

const SPACE_WIDTH_PX = getTextWidth(' ')

/**
 * 把時間推到最右邊，中間用空白撐開。
 *
 * 容器沒有文字對齊欄位，只能靠空白數量把時間視覺上推到右側。`getTextWidth`
 * 反推出來的空白數只是起點——量測文件說得很清楚，LVGL 換行是逐字元把
 * 寬度取整再累加，重複幾十個空白時，累積誤差會跟 `getTextWidth` 的單次
 * 加總不一樣。所以起點算完之後，用 `measureTextWrap` 量真正組出來的那
 * 一行，量到會換行就少一個空白重量，直到真的放得下一行為止——保證看
 * 到的結果一定沒被裁掉，不是賭一個算出來的數字。
 *
 * 放不下時間就整個捨棄，不硬擠：烹飪資訊（標題、步驟數）永遠優先。
 */
function alignRight(left: string, right: string, innerWidth: number): string {
  const minimal = `${left} ${right}`
  if (measureTextWrap(minimal, innerWidth).lineCount > 1) return left

  const gapPx = innerWidth - getTextWidth(left) - getTextWidth(right)
  let spaces = Math.max(1, Math.floor(gapPx / SPACE_WIDTH_PX))
  let text = `${left}${' '.repeat(spaces)}${right}`
  while (spaces > 1 && measureTextWrap(text, innerWidth).lineCount > 1) {
    spaces -= 1
    text = `${left}${' '.repeat(spaces)}${right}`
  }
  return measureTextWrap(text, innerWidth).lineCount <= 1 ? text : minimal
}

export function headerText(
  title: string,
  stepTotal: number,
  view: View | null,
  now: Date,
  innerWidth = HEADER.w - 2 * HEADER.pad,
): string {
  const left = headerLeftText(title, stepTotal, view)
  return alignRight(left, formatClockTime(now), innerWidth)
}

/**
 * 採購清單的畫面。沒有步驟、沒有計時，就是一份可以翻頁的清單 ——
 * 逛超市時抬頭看得到要買什麼，雙手還能推推車。
 */
export function buildShoppingViews(lines: string[]): View[] {
  if (!lines.length) {
    return [{ kind: 'empty', body: t('g.shoppingEmpty') }]
  }
  const pages = paginateLines(lines, BODY_INNER)
  return pages.map((body, page) => ({
    kind: 'shopping' as const,
    body,
    page,
    pageCount: pages.length,
  }))
}

/** 頁尾要顯示的那一個計時器（多個同時在跑時是最快到的那個）。 */
export interface FooterTimer {
  remaining: number
  total: number
  /**
   * 空字串代表就是眼前這一步的計時；否則是「步驟2」，或別道菜的「菜名 步驟2」——
   * 同時煮好幾道時，要一眼看出是哪一道、哪一步的計時。
   */
  label: string
  /** `label` 放不下時的短版：別道菜只留菜名，其餘與 `label` 相同。 */
  labelShort: string
  /** 除了這個之外還有幾個在跑。 */
  others: number
}

export interface FooterState {
  /** null 代表還沒載入任何食譜（待命畫面）。 */
  view: View | null
  timer: FooterTimer | null
  /** 這一步有計時但還沒開始：它的秒數。有值時頁尾改教使用者怎麼開始計時。 */
  startable: number | null
  /** 正在主選單：頁尾改教選單的手勢。 */
  menu?: boolean
  /** 雙擊會關閉什麼：整個程式（主畫面）、這道菜、這份清單。省略時依畫面推斷。 */
  close?: 'app' | 'dish' | 'list'
  /** 正在問「要關閉這道菜嗎」：頁尾改成確認／取消的提示。 */
  confirm?: boolean
}

/** 雙擊的意義：只有在主畫面（主選單、待命）才是關閉程式；在菜或清單裡只關閉那一個。 */
export function closeKindOf(view: View | null, menu: boolean): 'app' | 'dish' | 'list' {
  if (menu || !view) return 'app'
  return view.kind === 'shopping' ? 'list' : 'dish'
}

/**
 * 計時器不是眼前這一步的，就標出是哪一步或哪一道菜的哪一步——
 * 否則同時煮兩道菜時，看到「03:10」不會知道是誰的、做到哪。
 */
export function timerLabel(
  timer: { recipeId: string; recipeName: string; stepIndex: number },
  recipeId: string | null,
  currentStep: number,
): { label: string; short: string } {
  const step = t('g.timerStep', { n: timer.stepIndex + 1 })
  if (timer.recipeId === recipeId) {
    const label = timer.stepIndex === currentStep ? '' : step
    return { label, short: label }
  }
  const name = clipToWidth(timer.recipeName, DISH_LABEL_PX)
  return { label: `${name} ${step}`, short: name }
}

/** 別道菜的名字放進頁尾最多佔這麼寬（約五個中文字、十來個英文字母）。 */
const DISH_LABEL_PX = 110

/**
 * 頁尾裡的菜名簡稱：先拿掉括號裡的補充（「薑母鴨（しょうが鴨鍋）」→「薑母鴨」），
 * 西文在字與字之間截（「Ginger Duck Hot Pot」→「Ginger Duck」，不會是「Ginger Du」），
 * 中日韓才逐字截。不加省略號——頁尾寸土寸金，名字只是用來認得是哪道菜。
 */
function clipToWidth(text: string, maxPx: number): string {
  const base = text.split(/[（(［[]/)[0].trim() || text.trim()
  if (getTextWidth(base) <= maxPx) return base
  // 西文在字與字、連字號之間斷（「Ginger Duck Hot Pot」「Ingwer-Enten-Topf」）。
  const words = base.split(/(?<=[\s-])/)
  if (words.length > 1) {
    let out = ''
    for (const word of words) {
      if (getTextWidth((out + word).trimEnd()) > maxPx) break
      out += word
    }
    // 截在介系詞上很怪（「Marmite de」），再退一個字。
    out = out.replace(/[\s-]+$/, '').replace(/\s+(de|du|des|di|del|dei|da|la|le|el|al|und|and|of|&)$/i, '')
    if (out) return out
  }
  let out = ''
  for (const ch of Array.from(base)) {
    if (getTextWidth(out + ch) > maxPx) break
    out += ch
  }
  return out.trim()
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

/** 計時響起時的頁尾。任何手勢都先當「知道了」，不會順手翻頁。 */
export function alarmFooter(): string {
  // 響鈴時任何手勢（包括雙擊）都只是「知道了」，不會關菜或關程式。
  return t('g.alarmFooter')
}

/**
 * 依畫面種類決定提示的降級順序。「雙擊關閉程式」不在這裡——它固定放在頁尾最左，
 * 任何畫面、任何降級都不會被擠掉，使用者隨時知道怎麼離開。
 *
 * 最後一級固定是「長按主選單」：換菜、回主選單都從這裡走，放不下才整個捨棄。
 */
function hintLadder(view: View | null, menu: boolean, confirm = false): string[] {
  if (confirm) return [t('g.hintConfirm')]
  if (menu) return [t('g.hintMenu'), t('g.hintMenuShort')]
  const minimal = t('g.hintMin')
  if (!view || view.kind === 'done') return [minimal]
  return [t('g.hintFull'), t('g.hintShort'), minimal]
}

/**
 * 有計時但還沒開始的步驟：頁尾直接教怎麼開始、怎麼跳過。
 * 這是使用者最需要知道的一件事，所以寧可先犧牲「長按主選單」。
 */
function startLadder(seconds: number): string[] {
  const d = formatDuration(seconds)
  return [t('g.start1', { d }), t('g.start2', { d }), t('g.start3', { d }), t('g.start4')]
}

/**
 * 頁尾容器只有一行高（34px），LVGL 不會自動把溢出的文字截斷成省略號，
 * 就是整段直接被裁掉、悄悄消失 —— 跟中文缺字一樣的「靜默失敗」。
 *
 * 時間、進度條、頁碼、操作提示疊在一起，某些組合（尤其是「150:00」這種
 * 三位數分鐘加滿版進度條加完整提示）量出來會超過一行寬度。所以照「使用者
 * 最需要看到什麼」列出所有候選組合，實際量測、選第一個放得下的：每一級
 * 提示都先讓進度條縮短（8→5→不畫），整條都放不下才把提示換成更短的一級，
 * 最後才整個捨棄提示——時間本身永遠保留。
 */
export function footerText(
  { view, timer, startable, menu, close: closeKind, confirm }: FooterState,
  innerWidth = FOOTER.w - 2 * FOOTER.pad,
): string {
  const pageSuffix =
    view &&
    (view.kind === 'ingredients' || view.kind === 'step' || view.kind === 'shopping') &&
    view.pageCount > 1
      ? `${view.page + 1}/${view.pageCount}`
      : ''
  const hints = confirm
    ? hintLadder(view, false, true)
    : menu
      ? hintLadder(null, true)
      : startable !== null
        ? startLadder(startable)
        : hintLadder(view, false)
  const kind = closeKind ?? closeKindOf(view, !!menu)
  const close = t(
    confirm ? 'g.closeConfirmHint' : kind === 'app' ? 'g.closeHint' : kind === 'dish' ? 'g.closeDishHint' : 'g.closeListHint',
  )

  // 寫明「倒數」：標頭右上角已經有現在時間，頁尾只放「04:56」會被當成另一個時鐘。
  const clock = (label: string) =>
    timer
      ? label
        ? t('g.countdownFor', { label, t: formatClock(timer.remaining) })
        : t('g.countdown', { t: formatClock(timer.remaining) })
      : ''
  const more = timer?.others ? ` +${timer.others}` : ''
  // 「雙擊…」永遠排在最左邊（依畫面是關閉程式、這道菜或這份清單）；計時與提示依空間降級。
  const compose = (barWidth: number, hint: string | null, label: string, page: boolean, others: boolean) => {
    const bar = timer ? progressBar(timer.remaining, timer.total, barWidth) : ''
    const timerText = `${clock(label)}${bar ? ` ${bar}` : ''}${others ? more : ''}`
    const mid = [timerText, page ? pageSuffix : ''].filter(Boolean).join('  ')
    return [close, mid, hint].filter(Boolean).join('  ·  ')
  }

  // 降級順序（由重要到次要，越後面越先被犧牲）：
  // 倒數時間 > 是哪道菜哪一步 > 進度條、頁碼與「+N」> 提示。
  // 同時煮好幾道時，「菜名 步驟 剩餘時間」比提示更要緊：寧可先把提示整條換短、甚至拿掉，
  // 也要保住完整的菜名與步驟；實在放不下才把菜名換成短版，最後只剩「雙擊關閉程式 + 倒數」。
  const bars = timer ? [8, 5, 0] : [0]
  const labels = timer ? [...new Set([timer.label, timer.labelShort, ''])] : ['']
  const tails: [boolean, boolean][] = [[true, true], [false, true], [false, false]]
  const candidates: string[] = []
  for (const label of labels) {
    // 主選單一定要留著「長按返回」，否則使用者不知道怎麼離開；其他畫面提示最後才捨棄。
    for (const hint of menu ? hints : [...hints, null]) {
      for (const [page, others] of tails) {
        for (const bar of bars) candidates.push(compose(bar, hint, label, page, others))
      }
    }
  }
  // 主選單的右欄與詳情本來就列出每道菜的剩餘時間，頁尾實在擠不下倒數時，
  // 寧可只留「關閉程式 + 返回」，也不能讓使用者找不到離開選單的方法。
  if (menu) for (const hint of hints) candidates.push([close, hint].join('  ·  '))
  candidates.push(close)
  return candidates.find(text => measureTextWrap(text, innerWidth).lineCount <= 1) ?? close
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
  // 中日文標點、換行，以及西文後面接空白的標點（「1.5」「3,000」裡的小數點不切）。
  const first = text.split(/[，。：；、]|\n|[,.:;!?](?=\s)/)[0].trim()
  return (first || text.trim()).replace(/[.!?:;,]+$/, '')
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
    let cut = label.slice(0, len)
    // 西文盡量切在字與字之間，「3 Cut tomato in...」不如「3 Cut tomato...」。
    // 開頭「編號 + 空白」那個空白不算（index 1~2）。
    const space = cut.lastIndexOf(' ')
    if (space > 3 && label[len] !== ' ' && /[\p{L}\p{N}]/u.test(label[len] ?? '') && /[A-Za-zÀ-ÿ]/.test(cut[len - 1])) {
      cut = cut.slice(0, space)
    }
    const candidate = `${cut.trimEnd()}${ELLIPSIS}`
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
 *
 * `where` 一定要寫：響的可能是另一道菜、或早就翻過去的那一步。
 */
export function alarmBody(where: string, step: string): string {
  return `${t('g.alarmTitle')}\n\n${where}\n${step}`
}

/**
 * 待命畫面，也是第一次打開時看到的畫面：先說可以在手機選、或長按用眼鏡自己選，
 * 再教四個手勢。雙擊關閉程式固定寫在頁尾最左，這裡不重複。
 * 計時怎麼開始不在這裡細說——等真的走到有計時的那一步，頁尾會當場提示。
 */
export function idleBody(): string {
  return [t('g.idleHello'), '', t('g.gDown'), t('g.gUp'), t('g.gTap'), t('g.gHold')].join('\n')
}

/**
 * 完成頁。長按就是關掉這道菜、回主選單選下一道——這道的進度與計時器都會清掉，
 * 不會留在「進行中」。
 */
export function doneBody(name: string): string {
  return [name, '', t('g.doneTitle'), '', t('g.doneMenu')].join('\n')
}

/**
 * 關閉一道還沒煮完的菜之前的確認畫面。進度與計時一關就清掉、無法復原，
 * 所以先問一次：再雙擊才關，其他手勢都取消。
 */
export function confirmCloseBody(name: string): string {
  // 取消的說法也寫進內文：頁尾在某些語言放不下，使用者不能不知道怎麼取消。
  return [t('g.confirmTitle', { name }), '', t('g.confirmInfo'), t('g.closeConfirmHint'), t('g.hintConfirm')].join('\n')
}

// ---------------------------------------------------------------------------
// 主選單：長按進入，直接用眼鏡選一道菜（或採購清單），不必拿手機。
// 右欄五格是清單（目前這項最亮），左欄是選中那項的詳情。
// ---------------------------------------------------------------------------

export interface MenuItem {
  kind: 'dish' | 'shopping'
  /** 食譜 id；採購清單固定是 'shopping'。 */
  id: string
  name: string
  /** 一行說明：「6 步驟 · 15 分 · 簡單」或「3 項待買」。 */
  meta: string
  /** 煮到一半的菜：目前第幾步（1 起算）與總步數；沒開始煮是 null。 */
  progress: { step: number; total: number } | null
}

/** 某道菜還在跑的計時器，給選單顯示「哪一步、剩多少」。 */
export interface MenuTimer {
  stepIndex: number
  remaining: number
}

export function menuHeaderText(
  selected: number,
  total: number,
  now: Date,
  innerWidth = HEADER.w - 2 * HEADER.pad,
): string {
  const left = total > 0 ? `${t('g.menuTitle')} ${selected + 1}/${total}` : t('g.menuTitle')
  return alignRight(left, formatClockTime(now), innerWidth)
}

/** 選中那項的詳情。計時器最多列兩個（最快到的），內文總共不超過 7 行。 */
export function menuBody(item: MenuItem | null, timers: MenuTimer[]): string {
  if (!item) return t('g.menuEmpty')
  const lines = [item.name]
  if (item.kind === 'shopping') {
    lines.push(item.meta, '', t('g.menuOpenList'))
    return lines.join('\n')
  }
  // 還停在食材頁（step 0）時沒有「煮到第幾步」可說，顯示一般說明，按鈕仍是「繼續」。
  lines.push(
    item.progress && item.progress.step > 0
      ? t('g.menuCooking', { n: item.progress.step, total: item.progress.total })
      : item.meta,
  )
  for (const tm of timers.slice(0, 2)) {
    lines.push(t('g.menuTimer', { n: tm.stepIndex + 1, t: formatClock(tm.remaining) }))
  }
  lines.push('', item.progress ? t('g.menuResume') : t('g.menuOpen'))
  return lines.join('\n')
}

/**
 * 右欄的清單：視窗跟著選中項捲動。煮到一半的菜前面加「●」；有計時的菜名字後面
 * 直接寫最快到的剩餘時間，同時煮兩道菜時不用進去就看得出哪道快到了。
 */
export function menuRail(
  items: MenuItem[],
  selected: number,
  nextTimer: (item: MenuItem) => MenuTimer | null,
): RailSlot[] {
  const start =
    items.length <= RAIL.slots ? 0 : Math.min(Math.max(selected - 2, 0), items.length - RAIL.slots)
  return Array.from({ length: RAIL.slots }, (_, i) => {
    const at = start + i
    const item = items[at]
    if (!item) return { content: '', brightness: BRIGHTNESS.dim }
    const prefix = item.progress ? '● ' : ''
    const timer = nextTimer(item)
    const suffix = timer ? ` ${formatClock(timer.remaining)}` : ''
    const room = RAIL_INNER_W - getTextWidth(prefix + suffix)
    const content = `${prefix}${fitLabel(item.name, room)}${suffix}`
    return { content, brightness: at === selected ? BRIGHTNESS.bright : BRIGHTNESS.dim }
  })
}
