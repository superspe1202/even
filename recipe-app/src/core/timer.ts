/**
 * 步驟計時器。
 *
 * 計時器不綁在「目前顯示的畫面」上：開始之後就一直跑，翻到下一步、切去煮
 * 另一道菜、手機切背景都不會停，到時間才響。實際下廚時「燉一小時」那步
 * 開始後，本來就會先往下看、先備下一步的料，甚至去顧另一道菜。
 *
 * 每個計時器只存絕對結束時間，所以剩餘秒數永遠是現算的，存檔、還原、
 * 切換都不需要額外的「暫停／續接」邏輯。
 */
export interface RunningTimer {
  recipeId: string
  /** 響的時候可能正在看別道菜，要能說出是哪一道。 */
  recipeName: string
  stepIndex: number
  stepText: string
  totalSeconds: number
  endsAt: number
}

export function timerKey(recipeId: string, stepIndex: number): string {
  return `${recipeId}#${stepIndex}`
}

export function remainingSeconds(timer: Pick<RunningTimer, 'endsAt'>, now: number): number {
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

/** 最快到的排前面。 */
export function bySoonest(timers: RunningTimer[]): RunningTimer[] {
  return [...timers].sort((a, b) => a.endsAt - b.endsAt)
}

export function splitExpired(
  timers: RunningTimer[],
  now: number,
): { expired: RunningTimer[]; running: RunningTimer[] } {
  return {
    expired: timers.filter(t => t.endsAt <= now),
    running: timers.filter(t => t.endsAt > now),
  }
}

export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 給人讀的長度：「45 秒」「5 分鐘」「1 分 30 秒」。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分鐘`
}
