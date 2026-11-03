import { zh, type MsgKey } from './zh'
import { en } from './en'
import { de } from './de'
import { fr } from './fr'
import { es } from './es'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'

export type { MsgKey }

/**
 * 支援的語言。App 的文字、眼鏡上的字、內建食譜與 AI 產生的食譜都跟著這個走。
 * `zh` 是繁體中文（台灣用語）。
 */
export const LANG_CODES = ['zh', 'en', 'de', 'fr', 'es', 'it', 'ja', 'ko'] as const
export type Lang = (typeof LANG_CODES)[number]

/** 語言選單用各自的母語名稱，不隨介面語言變動，使用者才找得到自己的語言。 */
export const LANG_NAMES: Record<Lang, string> = {
  zh: '繁體中文',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
}

/** 給 AI 的指示用：用英文寫語言名稱，模型最不會誤解。 */
export const LANG_PROMPT_NAMES: Record<Lang, string> = {
  zh: 'Traditional Chinese (Taiwan usage)',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
}

const DICTS: Record<Lang, Record<MsgKey, string>> = { zh, en, de, fr, es, it, ja, ko }

/** `<html lang>`：讓瀏覽器挑對字形（同一個漢字日文與中文的寫法不同）。 */
const HTML_LANG: Record<Lang, string> = {
  zh: 'zh-Hant',
  en: 'en',
  de: 'de',
  fr: 'fr',
  es: 'es',
  it: 'it',
  ja: 'ja',
  ko: 'ko',
}

/** 使用者在設定頁的選擇：跟著手機，或指定一種。 */
export type LangSetting = 'auto' | Lang

let current: Lang = 'en'
const listeners = new Set<(lang: Lang) => void>()

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  // index.html 預設寫 zh-Hant，而字典的預設語言是 en：就算語言沒變也要把屬性對上，
  // 否則英文使用者的 <html lang> 會停在 zh-Hant（影響朗讀與 WebView 選字型）。
  if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[lang]
  if (lang === current) return
  current = lang
  for (const fn of listeners) fn(lang)
}

/** 語言變動時通知（手機畫面重畫、眼鏡畫面重排）。回傳取消訂閱的函式。 */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 把語言標籤（`ja-JP`、`zh-Hant-TW`、`pt_BR`）對到支援的語言；沒有就回 null。
 * 所有 `zh-*` 都對到繁體中文——目前只有這一種中文。
 */
export function matchLang(tag: string): Lang | null {
  const base = tag.toLowerCase().replace('_', '-').split('-')[0]
  return (LANG_CODES as readonly string[]).includes(base) ? (base as Lang) : null
}

/**
 * 跟著手機的語言：依手機偏好順序，取第一個支援的；一個都沒有就用英文。
 * 例如手機是 ['pt-BR', 'de'] 會用德文，只有 ['pt-BR'] 就用英文。
 */
export function detectLang(
  tags: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language],
): Lang {
  for (const tag of tags) {
    const hit = matchLang(tag)
    if (hit) return hit
  }
  return 'en'
}

/** 手機目前回報的語言標籤，設定頁顯示給使用者看（也方便回報問題）。 */
export function phoneLanguageTag(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.languages?.[0] ?? navigator.language ?? ''
}

export function resolveLang(setting: LangSetting): Lang {
  return setting === 'auto' ? detectLang() : setting
}

/** 英、德、法、西、義的複數：一個、其他。法文 0 也算單數。 */
function pluralIndex(lang: Lang, n: number): 0 | 1 {
  if (lang === 'fr') return n === 0 || n === 1 ? 0 : 1
  return n === 1 ? 0 : 1
}

export function hasKey(key: string): key is MsgKey {
  return key in zh
}

/**
 * 取字串。缺少時依序退到英文、再退到鍵本身（開發時一眼看得出漏翻）。
 *
 * 字串含 `|` 且參數有數字 `n` 時，依該語言的複數規則挑一段。
 */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let text = DICTS[current][key] ?? DICTS.en[key] ?? key
  if (params && typeof params.n === 'number' && text.includes('|')) {
    const parts = text.split('|')
    text = parts[Math.min(pluralIndex(current, params.n), parts.length - 1)]
  }
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

/** 測試與檢查腳本用：直接拿某種語言的字典。 */
export function dictionaryOf(lang: Lang): Record<MsgKey, string> {
  return DICTS[lang]
}
