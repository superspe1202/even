/**
 * 步驟倒數計時器。
 *
 * G2 沒有喇叭，所以「時間到」只能靠視覺提示 —— `onDone` 由呼叫端接手去做
 * 畫面閃爍。計時基準用絕對時間戳（而非累加 interval），這樣手機切到背景
 * 再回來時剩餘秒數仍然正確。
 */
export class StepTimer {
  private endsAt = 0
  private handle: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly onTick: (remainingSeconds: number) => void,
    private readonly onDone: () => void,
  ) {}

  /** `endsAtOverride` 供背景還原使用，讓倒數接續而不是重來。 */
  start(seconds: number, endsAtOverride?: number) {
    this.stop()
    this.endsAt = endsAtOverride ?? Date.now() + seconds * 1000
    this.onTick(this.remaining())
    this.handle = setInterval(() => {
      const left = this.remaining()
      this.onTick(left)
      if (left <= 0) {
        this.stop()
        this.onDone()
      }
    }, 1000)
  }

  stop() {
    if (this.handle !== null) {
      clearInterval(this.handle)
      this.handle = null
    }
    this.endsAt = 0
  }

  get running() {
    return this.handle !== null
  }

  /** 背景保存用：還原時把這個值餵回 `start` 的第二個參數。 */
  get endsAtTimestamp() {
    return this.endsAt
  }

  remaining(): number {
    if (!this.endsAt) return 0
    return Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000))
  }
}

export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
