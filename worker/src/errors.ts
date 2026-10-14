/**
 * 可以顯示給 App 使用者看的錯誤，帶一個固定的代碼。
 *
 * Worker 不知道使用者看得懂什麼語言，也不該把句子寫死在這裡：
 * App 依 `code` 對到使用者語言的句子（見 App 的 `e.<code>` 字串）。
 * `error` 欄位另外附上一句白話——繁中給沒帶 `lang` 的舊版 App，其餘語言給英文——
 * 只當後備，新版 App 不使用。
 *
 * 其他錯誤（AI 服務掛了、金鑰沒設、逾時、JSON 壞掉）一律只記在 log，
 * 回給 App 的是通用的 `generic`，不把狀態碼或內部訊息丟給使用者。
 */
export type ErrorCode =
  | 'video_unsupported'
  | 'invalid_url'
  | 'invalid_scheme'
  | 'page_unreachable'
  | 'not_html'
  | 'page_empty'
  | 'not_recipe'
  | 'not_food'
  | 'query_empty'
  | 'query_too_long'
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'generic'

export class UserFacingError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
  }
}

const MESSAGES: Record<ErrorCode, { zh: string; en: string }> = {
  video_unsupported: { zh: '目前不接受影片分析，請貼上食譜的網頁。', en: 'Video links are not supported yet. Please paste a recipe web page.' },
  invalid_url: { zh: '網址看起來不完整，請確認有整段複製。', en: 'The link looks incomplete. Please copy the whole address.' },
  invalid_scheme: { zh: '請貼上網頁連結（http 或 https 開頭）。', en: 'Please paste a web link (starting with http or https).' },
  page_unreachable: { zh: '這個網頁打不開，可能要登入才看得到，或已經失效。', en: 'This page cannot be opened. It may need a login, or it may be gone.' },
  not_html: { zh: '這個連結不是網頁，沒辦法讀取。', en: 'This link is not a web page, so it cannot be read.' },
  page_empty: { zh: '這個網頁幾乎沒有文字，可能要登入才看得到。', en: 'This page has almost no text. It may need a login.' },
  not_recipe: { zh: '這不是食譜內容。', en: 'This does not look like a recipe.' },
  not_food: { zh: '這看起來不是料理名稱。', en: 'This does not look like the name of a dish.' },
  query_empty: { zh: '請先輸入菜名。', en: 'Please enter a dish name first.' },
  query_too_long: { zh: '菜名太長了，簡短一點就好。', en: 'The name is too long. Please shorten it.' },
  bad_request: { zh: '請求格式不對。', en: 'The request is not in the right format.' },
  unauthorized: { zh: '未授權。', en: 'Unauthorized.' },
  not_found: { zh: '不支援的路徑或方法。', en: 'Unsupported path or method.' },
  generic: { zh: '整理食譜時出了點問題，請稍後再試。', en: 'Something went wrong while preparing the recipe. Please try again later.' },
}

export function messageFor(code: ErrorCode, lang: Lang): string {
  return MESSAGES[code][lang === 'zh' ? 'zh' : 'en']
}

export type Lang = 'zh' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'ja' | 'ko'

export const LANGS: readonly Lang[] = ['zh', 'en', 'de', 'fr', 'es', 'it', 'ja', 'ko']

/** 給 AI 的目標語言名稱（寫進 prompt，用英文最穩）。 */
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

/**
 * 沒帶 `lang` 的是 0.2 以前的 App，它們一律期待繁體中文，所以預設 zh；
 * 帶了但不認得的語言（日後 App 多支援語言但 Worker 還沒更新）退回英文。
 */
export function parseLang(value: unknown): Lang {
  if (value === undefined || value === null || value === '') return 'zh'
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value) ? (value as Lang) : 'en'
}

/** 字數限制依文字種類調整：中日韓一個字寬，拉丁字母約是它的一半寬。 */
export function isCjk(lang: Lang): boolean {
  return lang === 'zh' || lang === 'ja' || lang === 'ko'
}
