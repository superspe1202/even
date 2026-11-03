/**
 * 短亂數 id。不需要密碼學強度 —— 只是食譜與食材的本機主鍵，
 * 但 `crypto.randomUUID` 在部分 WebView 不可用，所以自己湊一個。
 */
export function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}${rand}`
}
