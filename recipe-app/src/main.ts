import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { onBackgroundRestore, setBackgroundState } from './core/background'
import { RecipeStore } from './core/storage'
import type { RunningTimer } from './core/timer'
import type { Recipe } from './core/types'
import { GlassesRuntime } from './glasses/runtime'
import { PhoneUi } from './phone/ui'

const BG_KEY = 'recipeGlass'

interface BackgroundSnapshot {
  recipeId: string | null
  viewIndex: number
  timers?: RunningTimer[]
}

/** 背景還原時先接住狀態，等執行時期準備好再套用。 */
let restored: BackgroundSnapshot | null = null

// 兩個註冊都必須在模組初始化階段完成 —— host 可能在 bridge 就緒前就
// 呼叫 __getStateSnapshot，晚註冊會拿到空狀態，App 從背景回來就重置。
setBackgroundState(BG_KEY, () => ({
  recipeId: runtime?.loadedRecipeId ?? null,
  viewIndex: runtime?.currentIndex ?? 0,
  // 計時器也會落盤，但落盤是非同步的；快照是同步取的，兩邊都存最保險。
  timers: runtime?.timersSnapshot ?? [],
}))
onBackgroundRestore(BG_KEY, saved => {
  restored = saved as unknown as BackgroundSnapshot
})

let runtime: GlassesRuntime | null = null
/** 目前顯示在眼鏡上的食譜 id；採購清單畫面時是 null。 */
let cookingId: string | null = null
/** 還沒煮完的食譜 id（可能不只一個），用來判斷長按能不能切換、切去哪。 */
let activeIds = new Set<string>()

/** 每次 `activeIds` 或 `cookingId` 變動都呼叫，讓頁尾的長按提示跟著更新。 */
function updateSwitchable() {
  runtime?.setSwitchable([...activeIds].some(id => id !== cookingId))
}

async function boot() {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('找不到 #app 容器')

  const bridge = await waitForEvenAppBridge()
  const store = new RecipeStore(bridge)

  runtime = new GlassesRuntime(bridge, {
    onPositionChange: (recipeId, viewIndex, finished) => {
      cookingId = recipeId
      if (finished) {
        // 煮完了就不算「進行中」：下次開始烹飪從頭來，長按也不會切回這道。
        activeIds.delete(recipeId)
        void store.clearProgress(recipeId)
      } else {
        activeIds.add(recipeId)
        // 每翻一頁就落盤，中途離開 App 或切去煮另一道也能從同一步接續。
        void store.setProgress({ recipeId, stepIndex: viewIndex })
      }
      updateSwitchable()
    },
    onExit: () => {
      cookingId = null
    },
    onSwitchRecipe: () => void switchToOther(store),
    onTimersChange: timers => void store.saveTimers(timers),
  })

  const ok = await runtime.init()
  if (!ok) {
    root.innerHTML =
      '<div class="error">眼鏡畫面開不起來。請確認眼鏡已經連上手機，再重新打開 App。</div>'
    return
  }

  const ui = new PhoneUi(root, store, {
    onCook: async (recipe: Recipe) => {
      // 這道菜可能已經在煮到一半：有進度就接續，不重來。
      const existing = await store.getProgress(recipe.id)
      cookingId = recipe.id
      activeIds.add(recipe.id)
      updateSwitchable()
      await runtime!.load(recipe, existing?.stepIndex ?? 0)
    },
    onShowShopping: async (lines: string[]) => {
      // 採購清單接管眼鏡畫面，烹飪中的標記要收掉（但進度都還在，之後能接回來）。
      cookingId = null
      updateSwitchable()
      await runtime!.loadShoppingList(lines)
    },
    cookingRecipeId: () => cookingId,
    otherActiveRecipeIds: () => [...activeIds].filter(id => id !== cookingId),
    onRecipeDeleted: id => {
      activeIds.delete(id)
      runtime?.cancelTimersFor(id)
      updateSwitchable()
    },
  })
  await ui.start()

  await resume(store)
  runtime.restoreTimers(restored?.timers ?? (await store.getTimers()))
}

/**
 * 長按觸發：切到「等最久」的另一道進行中食譜，接續它的步驟。
 * 計時器本來就不綁畫面，切過去不用做任何處理。
 * 只有一道在煮（或都煮完了）就什麼都不做，不會誤觸跳走。
 */
async function switchToOther(store: RecipeStore): Promise<void> {
  const others = (await store.listProgress())
    .filter(p => p.recipeId !== cookingId)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  if (!others.length) return

  const next = others[0]
  const recipe = await store.get(next.recipeId)
  if (!recipe) {
    // 食譜被刪掉了，這筆進度也沒有意義。
    await store.clearProgress(next.recipeId)
    activeIds.delete(next.recipeId)
    updateSwitchable()
    return
  }
  cookingId = recipe.id
  updateSwitchable()
  await runtime!.load(recipe, next.stepIndex)
}

/** 續看：優先用背景快照，其次用所有進度裡最近更新的一筆。 */
async function resume(store: RecipeStore) {
  const all = await store.listProgress()
  activeIds = new Set(all.map(p => p.recipeId))

  const snapshot = restored
  const progress = snapshot?.recipeId
    ? { recipeId: snapshot.recipeId, stepIndex: snapshot.viewIndex }
    : all.length
      ? all.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
      : null
  if (!progress) {
    updateSwitchable()
    return
  }

  const recipe = await store.get(progress.recipeId)
  if (!recipe) {
    // 食譜被刪掉了，進度就沒有意義。
    await store.clearProgress(progress.recipeId)
    activeIds.delete(progress.recipeId)
    updateSwitchable()
    return
  }
  cookingId = recipe.id
  updateSwitchable()
  await runtime!.load(recipe, progress.stepIndex)
}

window.addEventListener('beforeunload', () => runtime?.dispose())

boot().catch(err => {
  console.error('啟動失敗：', err)
  const root = document.querySelector<HTMLDivElement>('#app')
  if (root) root.innerHTML = '<div class="error">App 啟動失敗，請關掉再重新打開。</div>'
})
