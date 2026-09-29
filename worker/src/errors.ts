/**
 * 可以原封不動顯示給 App 使用者看的錯誤。
 *
 * 其他錯誤（AI 服務掛了、金鑰沒設、逾時、JSON 壞掉）一律只記在 log，
 * 回給 App 的是一句通用的白話，不把狀態碼或內部訊息丟給使用者。
 */
export class UserFacingError extends Error {}

export const GENERIC_FAILURE = '整理食譜時出了點問題，請稍後再試。'
