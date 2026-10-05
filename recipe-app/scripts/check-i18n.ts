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
import { buildViews, doneBody, footerText, headerText, idleBody, alarmBody, railSlots, RAIL_INNER_W, BODY_INNER, FOOTER, HEADER } from '../src/glasses/views'
import { LANG_CODES, dictionaryOf, setLang, t, type Lang, type MsgKey } from '../src/i18n'
import { zh } from '../src/i18n/zh'
import type { Recipe } from '../src/core/types'

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
    if (value.includes('  ') && !key.startsWith('g.g') && key !== 'g.doneSwitch' && key !== 'u.sh.sep' && !key.startsWith('g.countdown')) {
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
  for (const sw of [true, false]) {
    const b = doneBody('Longest Recipe Name Here', sw)
    if (lines(b, BODY_INNER.width) > MAX_LINES) fail(`${lang} 完成畫面（可切換=${sw}）超過 ${MAX_LINES} 行`)
  }
  const alarm = alarmBody(t('g.alarmWhereDish', { name: 'Longest Recipe Name Here', n: 12 }), 'x'.repeat(0) + dict['g.shoppingEmpty'])
  if (lines(alarm, BODY_INNER.width) > MAX_LINES) warn(`${lang} 響鈴畫面（最壞情況）超過 ${MAX_LINES} 行`)
  if (lines(dict['g.shoppingEmpty'], BODY_INNER.width) > MAX_LINES) fail(`${lang} 採購清單空畫面超過 ${MAX_LINES} 行`)

  // 頁尾：各種組合都要一行放得下；有計時時一定留得住「倒數」
  const view = { kind: 'step', stepIndex: 1, body: '', page: 0, pageCount: 2 } as const
  const scenarios = [
    { label: '', remaining: 296, total: 300, others: 0 },
    { label: t('g.timerStep', { n: 12 }), remaining: 5400, total: 5400, others: 2 },
    { label: 'Tomato', remaining: 59, total: 90, others: 0 },
  ]
  for (const sc of scenarios) {
    for (const canSwitch of [false, true]) {
      for (const startable of [null, 90, 5400]) {
        const text = footerText({ view, timer: sc, startable, canSwitch })
        if (lines(text, FOOTER_W) > 1) fail(`${lang} 頁尾超過一行：${text}`)
        const needle = t('g.countdown', { t: '' }).trim().split(' ')[0]
        if (!text.includes(needle.slice(0, 2))) warn(`${lang} 頁尾可能少了倒數字樣：${text}`)
        addGlyphs(`${lang} 介面`, text)
      }
    }
  }
  // 頁尾提示至少要有一級完整放得下（沒計時時）
  const idleFooter = footerText({ view: null, timer: null, startable: null, canSwitch: true })
  if (!idleFooter.trim()) fail(`${lang} 待命頁尾是空的`)
  const nonTimerFooter = footerText({ view, timer: null, startable: null, canSwitch: true })
  if (nonTimerFooter === '1/2') warn(`${lang} 步驟頁尾放不下任何提示：${nonTimerFooter}`)
  const startFooter = footerText({ view, timer: null, startable: 5400, canSwitch: false })
  if (!startFooter.includes(t('g.start4').slice(0, 2))) warn(`${lang} 開始計時提示被擠掉：${startFooter}`)
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
