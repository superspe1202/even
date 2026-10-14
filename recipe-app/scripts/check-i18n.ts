/**
 * 多語言檢查。`npm run check:i18n`
 *
 * 眼鏡字型缺字時韌體是靜默略過、不報錯；字串太長一行放不下也只是悄悄被裁掉。
 * 這些在編譯期看不出來，所以每次改翻譯、加食譜都跑一次：
 *
 * 1. 字典：每種語言的參數（{name}）與 HTML 標籤跟中文一致，沒有混進別種語言的文字
 * 2. 眼鏡：頁尾、待命、完成、響鈴畫面在每種語言都放得下；用到的每個字元字型都有
 * 3. 食譜：每種語言都有每一道菜，步驟數、計時、小提醒對得上，每一頁都在行數上限內
 */
import { getAdvW, measureTextWrap } from '@evenrealities/pretext'
import { CATALOG_BASE } from '../src/data/catalog'
import { CATALOG_TEXTS } from '../src/data/text'
import { alarmFooter, buildViews, confirmCloseBody, doneBody, footerText, headerText, idleBody, alarmBody, menuBody, menuHeaderText, menuRail, railSlots, RAIL_INNER_W, BODY_INNER, FOOTER, HEADER, type MenuItem } from '../src/glasses/views'
import { LANG_CODES, dictionaryOf, setLang, t, type Lang, type MsgKey } from '../src/i18n'
import { zh } from '../src/i18n/zh'
import type { Recipe } from '../src/core/types'
import { formatClock } from '../src/core/timer'

let errors = 0
let warnings = 0
const fail = (msg: string) => {
  errors++
  console.log('  ✗ ' + msg)
}
const warn = (msg: string) => {
  warnings++
  console.log('  ! ' + msg)
}

const KEYS = Object.keys(zh) as MsgKey[]
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
const tags = (s: string) => [...s.matchAll(/<\/?\w+>/g)].map(m => m[0]).sort().join('')
const HAN = /[㐀-鿿]/
const KANA = /[ぁ-ヿ]/
const HANGUL = /[가-힣]/
const CJK_LANGS: Lang[] = ['zh', 'ja']

const MAX_LINES = Math.floor(BODY_INNER.height / 27)
const FOOTER_W = FOOTER.w - 2 * FOOTER.pad

// ---------- 1. 字典 ----------
console.log('1. 字典')
for (const lang of LANG_CODES) {
  const dict = dictionaryOf(lang)
  for (const key of KEYS) {
    const value = dict[key]
    const mayBeBlank = key === 'u.sh.sep' || key === 'list.sep'
    if (typeof value !== 'string' || (!mayBeBlank && !value.trim())) {
      fail(`${lang} 缺少 ${key}`)
      continue
    }
    if (lang === 'zh') continue
    // 單複數的兩段用 | 隔開，參數要在每一段都對得上，所以把 | 當一般字元比整串的參數集合。
    const wantParams = [...new Set(params(zh[key]).split(',').filter(Boolean))].join(',')
    const gotParams = [...new Set(params(value).split(',').filter(Boolean))].join(',')
    if (wantParams !== gotParams) fail(`${lang} ${key} 參數不一致：中文 {${wantParams}} ↔ {${gotParams}}`)
    if (tags(zh[key]) !== tags(value)) fail(`${lang} ${key} 的 HTML 標籤跟中文不一樣`)
    if (value.includes('|') && CJK_LANGS.includes(lang)) fail(`${lang} ${key} 不該用 | 複數`)
    if (!CJK_LANGS.includes(lang) && lang !== 'ko' && HAN.test(value)) fail(`${lang} ${key} 混進了漢字：${value}`)
    if (lang !== 'ja' && KANA.test(value)) fail(`${lang} ${key} 混進了假名：${value}`)
    if (lang !== 'ko' && HANGUL.test(value)) fail(`${lang} ${key} 混進了韓文：${value}`)
    if (value.includes('  ') && !key.startsWith('g.g') && key !== 'g.menuTimer' && key !== 'u.sh.sep' && !key.startsWith('g.countdown')) {
      warn(`${lang} ${key} 有連續空白`)
    }
  }
}

// ---------- 2. 眼鏡上的字 ----------
const missingGlyphs = new Map<string, Set<string>>()
const addGlyphs = (where: string, text: string) => {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32 || ch === ' ') continue
    if (!getAdvW(cp)) {
      if (!missingGlyphs.has(where)) missingGlyphs.set(where, new Set())
      missingGlyphs.get(where)!.add(ch)
    }
  }
}

const lines = (text: string, width: number) => measureTextWrap(text, width).lineCount

console.log('2. 眼鏡畫面')
for (const lang of LANG_CODES) {
  setLang(lang)
  const dict = dictionaryOf(lang)
  console.log(`  [${lang}]`)

  for (const key of KEYS) if (key.startsWith('g.')) addGlyphs(`${lang} 介面`, dict[key])
  addGlyphs(`${lang} 介面`, t('dur.sec', { n: 45 }) + t('dur.min', { n: 5 }) + t('dur.minSec', { m: 1, s: 30 }))

  const sample = idleBody()
  if (lines(sample, BODY_INNER.width) > MAX_LINES) fail(`${lang} 待命畫面 ${lines(sample, BODY_INNER.width)} 行，超過 ${MAX_LINES}`)
  const done = doneBody('Longest Recipe Name Here')
  if (lines(done, BODY_INNER.width) > MAX_LINES) fail(`${lang} 完成畫面超過 ${MAX_LINES} 行`)
  const alarm = alarmBody(t('g.alarmWhereDish', { name: 'Longest Recipe Name Here', n: 12 }), 'x'.repeat(0) + dict['g.shoppingEmpty'])
  if (lines(alarm, BODY_INNER.width) > MAX_LINES) warn(`${lang} 響鈴畫面（最壞情況）超過 ${MAX_LINES} 行`)
  if (lines(dict['g.shoppingEmpty'], BODY_INNER.width) > MAX_LINES) fail(`${lang} 採購清單空畫面超過 ${MAX_LINES} 行`)

  // 頁尾：各種組合都要一行放得下；「雙擊關閉程式」永遠在最左；有計時時一定留得住「倒數」
  const closeApp = t('g.closeHint')
  const closeDish = t('g.closeDishHint')
  const closeList = t('g.closeListHint')
  const view = { kind: 'step', stepIndex: 1, body: '', page: 0, pageCount: 2 } as const
  const dishName = 'Longest Dish'
  const scenarios = [
    { label: '', labelShort: '', remaining: 296, total: 300, others: 0 },
    { label: t('g.timerStep', { n: 12 }), labelShort: t('g.timerStep', { n: 12 }), remaining: 5400, total: 5400, others: 2 },
    { label: `Tomato ${t('g.timerStep', { n: 12 })}`, labelShort: 'Tomato', remaining: 59, total: 90, others: 0 },
    { label: `${dishName} ${t('g.timerStep', { n: 12 })}`, labelShort: dishName, remaining: 9000, total: 9000, others: 3 },
  ]
  const checkFooter = (text: string, what: string, left: string | null) => {
    if (lines(text, FOOTER_W) > 1) fail(`${lang} 頁尾超過一行（${what}）：${text}`)
    if (left && !text.startsWith(left)) fail(`${lang} 頁尾最左不是「${left}」（${what}）：${text}`)
    addGlyphs(`${lang} 介面`, text)
  }
  for (const sc of scenarios) {
    for (const startable of [null, 90, 5400]) {
      for (const v of [view, null]) {
        const text = footerText({ view: v, timer: sc, startable, menu: false })
        checkFooter(text, `計時 ${sc.label || '本步'}`, v ? closeDish : closeApp)
        // 倒數時間（mm:ss）無論如何不能被擠掉
        if (!text.includes(formatClock(sc.remaining))) fail(`${lang} 頁尾少了倒數時間：${text}`)
      }
    }
    const menuFooter = footerText({ view: null, timer: sc, startable: null, menu: true })
    checkFooter(menuFooter, '主選單+計時', closeApp)
    if (!menuFooter.includes(t('g.hintMenuShort'))) fail(`${lang} 主選單頁尾少了「返回」提示：${menuFooter}`)
  }
  const shopView = { kind: 'shopping', body: '', page: 0, pageCount: 2 } as const
  for (const [what, v, menu, left] of [['待命', null, false, closeApp], ['步驟', view, false, closeDish], ['清單', shopView, false, closeList], ['主選單', null, true, closeApp]] as const) {
    const text = footerText({ view: v, timer: null, startable: null, menu })
    checkFooter(text, what, left)
    if (text === left) warn(`${lang} ${what}頁尾放不下任何提示：${text}`)
  }
  // 響鈴：任何手勢都只是「知道了」，頁尾不提關閉
  checkFooter(alarmFooter(), '響鈴', null)
  // 確認關閉：頁尾最左是「雙擊確認」，帶計時時倒數仍保留
  const confirmFooter = footerText({ view, timer: scenarios[3], startable: null, confirm: true })
  checkFooter(confirmFooter, '確認關閉', t('g.closeConfirmHint'))
  if (!confirmFooter.includes(formatClock(scenarios[3].remaining))) fail(`${lang} 確認畫面頁尾少了倒數：${confirmFooter}`)
  const confirm = confirmCloseBody('A very long recipe name that wraps onto two lines')
  addGlyphs(`${lang} 介面`, confirm)
  if (lines(confirm, BODY_INNER.width) > MAX_LINES) fail(`${lang} 確認關閉畫面 ${lines(confirm, BODY_INNER.width)} 行，超過 ${MAX_LINES}`)
  const startFooter = footerText({ view, timer: null, startable: 5400, menu: false })
  if (!startFooter.includes(t('g.start4').slice(0, 2))) warn(`${lang} 開始計時提示被擠掉：${startFooter}`)

  // 主選單：標頭一行、詳情不超過 7 行、右欄每格一行
  const header = menuHeaderText(11, 12, new Date(2026, 0, 1, 23, 59))
  if (lines(header, HEADER.w - 2 * HEADER.pad) > 1) fail(`${lang} 主選單標頭超過一行：${header}`)
  const worst: MenuItem = {
    kind: 'dish', id: 'x', name: 'A very long recipe name that wraps onto two lines', progress: { step: 12, total: 12 },
    meta: t('u.rowMeta', { n: 12, min: 180, diff: t('diff.hard') }),
  }
  const timers = [{ stepIndex: 11, remaining: 9000 }, { stepIndex: 9, remaining: 59 }, { stepIndex: 3, remaining: 5 }]
  for (const [what, item] of [['煮到一半', worst], ['沒開始', { ...worst, progress: null }]] as const) {
    const body = menuBody(item, timers)
    addGlyphs(`${lang} 介面`, body)
    if (lines(body, BODY_INNER.width) > MAX_LINES) fail(`${lang} 主選單詳情（${what}）${lines(body, BODY_INNER.width)} 行，超過 ${MAX_LINES}`)
  }
  const shop: MenuItem = { kind: 'shopping', id: 'shopping', name: t('g.shoppingTitle'), meta: t('g.menuShopping', { n: 12 }), progress: null }
  if (lines(menuBody(shop, []), BODY_INNER.width) > MAX_LINES) fail(`${lang} 主選單採購清單詳情超過 ${MAX_LINES} 行`)
  if (lines(menuBody(null, []), BODY_INNER.width) > MAX_LINES) fail(`${lang} 主選單空畫面超過 ${MAX_LINES} 行`)
  const menuItems = [worst, ...Array.from({ length: 6 }, (_, i) => ({ ...worst, id: `d${i}`, name: `Recipe ${i}` })), shop]
  for (const slot of menuRail(menuItems, 3, it => (it.id === 'x' ? timers[0] : null))) {
    if (slot.content && lines(slot.content, RAIL_INNER_W) > 1) fail(`${lang} 主選單右欄超過一行：${slot.content}`)
    addGlyphs(`${lang} 介面`, slot.content)
  }
}

// ---------- 3. 內建食譜 ----------
console.log('3. 內建食譜')
const slugs = CATALOG_BASE.map(b => b.slug)
if (new Set(slugs).size !== slugs.length) fail('slug 重複')
const zhTexts = CATALOG_TEXTS.zh
for (const lang of LANG_CODES) {
  setLang(lang)
  const texts = CATALOG_TEXTS[lang]
  let maxLines = 0
  let maxWhere = ''
  let multiPage = 0
  let missing = 0
  let clockDropped = 0
  console.log(`  [${lang}] ${Object.keys(texts).length}/${slugs.length}`)
  for (const base of CATALOG_BASE) {
    const text = texts[base.slug]
    if (!text) {
      missing++
      continue
    }
    const where = `${lang}/${base.slug}`
    if (!text.name?.trim() || !text.summary?.trim()) fail(`${where} 缺名稱或簡介`)
    if (text.steps.length !== base.timers.length) fail(`${where} 步驟數 ${text.steps.length} ≠ 計時表 ${base.timers.length}`)
    if (!text.ing.length) fail(`${where} 沒有食材`)
    const wantTips = Object.keys(zhTexts[base.slug]?.tips ?? {}).sort().join(',')
    const gotTips = Object.keys(text.tips ?? {}).sort().join(',')
    if (lang !== 'zh' && zhTexts[base.slug] && wantTips !== gotTips) fail(`${where} 小提醒位置與中文不同：${wantTips} ↔ ${gotTips}`)
    if (!CJK_LANGS.includes(lang) && lang !== 'ko') {
      const all = [text.name, text.summary, ...text.ing.flat(), ...text.steps, ...Object.values(text.tips ?? {})].join(' ')
      if (HAN.test(all)) fail(`${where} 混進了漢字`)
    }
    for (const s of text.steps) if (/\{|\}|\n/.test(s)) fail(`${where} 步驟有不該出現的字元`)

    addGlyphs(`${lang} 食譜`, [text.name, text.summary, ...text.ing.flat(), ...text.steps, ...Object.values(text.tips ?? {})].join(''))

    const recipe: Recipe = {
      id: 'x',
      name: text.name,
      servings: base.servings,
      totalMinutes: base.totalMinutes,
      difficulty: base.difficulty,
      source: 'catalog',
      ingredients: text.ing.map(([item, amount], i) => ({ id: String(i), item, amount })),
      steps: text.steps.map((s, i) => ({ id: String(i), text: s, ...(text.tips?.[i] ? { tip: text.tips[i] } : {}) })),
      createdAt: 0,
      updatedAt: 0,
    }
    const views = buildViews(recipe)
    const perStep = new Map<number, number>()
    for (const v of views) {
      const n = lines(v.body, BODY_INNER.width)
      if (n > maxLines) {
        maxLines = n
        maxWhere = where
      }
      if (n > MAX_LINES) fail(`${where} 有一頁 ${n} 行超過 ${MAX_LINES}`)
      if (v.kind === 'step') perStep.set(v.stepIndex, (perStep.get(v.stepIndex) ?? 0) + 1)
    }
    for (const [step, pages] of perStep) if (pages > 1) {
      multiPage++
      if (pages > 2) warn(`${where} 第 ${step + 1} 步要翻 ${pages} 頁`)
    }
    for (let s = -1; s <= recipe.steps.length; s++) {
      for (const slot of railSlots(recipe, s)) if (slot.content && lines(slot.content, RAIL_INNER_W) > 1) fail(`${where} 右欄標籤超過一行：${slot.content}`)
    }
    // 標頭：名稱太長會把時鐘擠掉，算有多少道
    const stepView = views.find(v => v.kind === 'step')
    if (stepView) {
      const h = headerText(text.name, recipe.steps.length, stepView, new Date(2026, 0, 1, 23, 59), HEADER.w - 2 * HEADER.pad)
      if (lines(h, HEADER.w - 2 * HEADER.pad) > 1) fail(`${where} 標頭超過一行`)
      if (!h.includes('23:59')) clockDropped++
    }
  }
  if (missing) fail(`${lang} 缺 ${missing} 道菜的文字`)
  if (lang !== 'zh') console.log(`     內文最多 ${maxLines} 行（${maxWhere}）；${multiPage} 個步驟要翻兩頁以上；${clockDropped} 道菜標頭放不下時鐘`)
  if (clockDropped > 4) warn(`${lang} 有 ${clockDropped} 道菜的標頭被擠掉時鐘，菜名可以再短一點`)
}

console.log('4. 字型缺字')
if (!missingGlyphs.size) console.log('  全部字元眼鏡字型都有')
for (const [where, chars] of missingGlyphs) fail(`${where} 用到眼鏡字型沒有的字：${[...chars].join('')}`)

console.log(`\n${errors ? '✗' : '✓'} ${errors} 個錯誤、${warnings} 個警告`)
process.exit(errors ? 1 : 0)
