import type { Recipe } from '../core/types'
import { formatClock } from '../core/timer'
import { paginate, paginateLines } from './paginate'

/** 版面幾何。改這裡就好，分頁會跟著重算。 */
export const HEADER = { x: 0, y: 0, w: 576, h: 32, pad: 4, id: 1, name: 'header' } as const
export const BODY = { x: 0, y: 34, w: 576, h: 214, pad: 4, id: 2, name: 'body' } as const
export const FOOTER = { x: 0, y: 252, w: 576, h: 34, pad: 4, id: 3, name: 'footer' } as const

export const BODY_INNER = {
  width: BODY.w - 2 * BODY.pad,
  height: BODY.h - 2 * BODY.pad,
}

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
  view: View
}

export function footerText({ remaining, view }: FooterState): string {
  const left: string[] = []
  if (remaining !== null) left.push(`⏱ ${formatClock(remaining)}`)
  // 'done' 和 'empty' 沒有頁碼欄位。
  if (
    (view.kind === 'ingredients' || view.kind === 'step' || view.kind === 'shopping') &&
    view.pageCount > 1
  ) {
    left.push(`${view.page + 1}/${view.pageCount}`)
  }
  const hint = view.kind === 'done' ? '雙擊離開' : '點擊下一頁 · 上滑回上頁 · 雙擊離開'
  return left.length ? `${left.join('  ')}  ·  ${hint}` : hint
}

/** 計時結束的閃爍畫面。G2 沒有喇叭，只能靠視覺。 */
export function alarmBody(step: string): string {
  return `⏱  時 間 到\n\n${step}`
}
