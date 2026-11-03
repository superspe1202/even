/**
 * 背景狀態保存。
 *
 * Even Hub 的 host 在手機切到背景時會把 WebView 換成 headless 版本：
 * 先呼叫 `window.__getStateSnapshot()` 取快照，在新的 WebView 載入同一個
 * 頁面後再呼叫 `window.__restoreState(snapshot)` 把狀態放回去。沒有註冊
 * 匯出器的外掛，快照會是 '{}'，於是每次從背景回來都從頭開始。
 *
 * 官方技能文件描述的 `setBackgroundState` / `onBackgroundRestore` 兩個
 * helper 在已發布的 SDK 0.0.15 還沒有匯出（實測 dist/index.d.ts 裡查無此
 * 符號），所以這裡直接接 host 協定本身。等 SDK 補上之後可以換掉這個檔案，
 * 對外的介面刻意設計成一樣。
 */

type Exporter = () => Record<string, unknown>
type Restorer = (saved: Record<string, unknown>) => void

const exporters = new Map<string, Exporter>()
const restorers = new Map<string, Restorer>()

declare global {
  interface Window {
    __getStateSnapshot?: () => string
    __restoreState?: (snapshot: string) => void
  }
}

function install() {
  if (typeof window === 'undefined') return

  window.__getStateSnapshot = () => {
    const out: Record<string, unknown> = {}
    for (const [key, read] of exporters) {
      try {
        out[key] = read()
      } catch (err) {
        // 單一匯出器壞掉不該讓整份快照變成空的。
        console.error(`背景狀態匯出失敗（${key}）：`, err)
      }
    }
    return JSON.stringify(out)
  }

  window.__restoreState = (snapshot: string) => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(snapshot || '{}') as Record<string, unknown>
    } catch {
      console.warn('背景狀態快照無法解析，略過還原')
      return
    }
    for (const [key, write] of restorers) {
      const value = parsed[key]
      if (value && typeof value === 'object') {
        try {
          write(value as Record<string, unknown>)
        } catch (err) {
          console.error(`背景狀態還原失敗（${key}）：`, err)
        }
      }
    }
  }
}

install()

/**
 * 註冊狀態匯出器。回傳值必須是可 JSON 序列化的純物件 ——
 * class 實體、函式、Map、Set 都會在序列化時消失。
 */
export function setBackgroundState(key: string, read: Exporter): void {
  exporters.set(key, read)
}

/** 註冊還原器。key 必須和 `setBackgroundState` 用同一個字串。 */
export function onBackgroundRestore(key: string, write: Restorer): void {
  restorers.set(key, write)
}
