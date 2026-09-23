import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { onBackgroundRestore, setBackgroundState } from './core/background'
import { RecipeStore } from './core/storage'
import type { Recipe } from './core/types'
import { GlassesRuntime } from './glasses/runtime'
import { PhoneUi } from './phone/ui'

const BG_KEY = 'recipeGlass'

interface BackgroundSnapshot {
  recipeId: string | null
  viewIndex: number
  timerEndsAt: number
}

/** 背景還原時先接住狀態，等執行時期準備好再套用。 */
let restored: BackgroundSnapshot | null = null

// 兩個註冊都必須在模組初始化階段完成 —— host 可能在 bridge 就緒前就
// 呼叫 __getStateSnapshot，晚註冊會拿到空狀態，App 從背景回來就重置。
setBackgroundState(BG_KEY, () => ({
  recipeId: runtime?.loadedRecipeId ?? null,
  viewIndex: runtime?.currentIndex ?? 0,
  timerEndsAt: runtime?.timerEndsAt ?? 0,
}))
onBackgroundRestore(BG_KEY, saved => {
  restored = saved as unknown as BackgroundSnapshot
})

let runtime: GlassesRuntime | null = null
/** 目前顯示在眼鏡上的食譜 id；採購清單畫面時是 null。 */
let cookingId: string | null = null
/** 所有有進度的食譜 id（可能不只一個），用來判斷長按能不能切換、切去哪。 */
let activeIds = new Set<string>()

async function boot() {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('找不到 #app 容器')

  const bridge = await waitForEvenAppBridge()
  const store = new RecipeStore(bridge)

  runtime = new GlassesRuntime(bridge, {
    onPositionChange: (recipeId, viewIndex) => {
      cookingId = recipeId
      activeIds.add(recipeId)
      // 每翻一頁就落盤，中途離開 App 或切去煮另一道也能從同一步接續。
      void store.setProgress({
        recipeId,
        stepIndex: viewIndex,
        timerEndsAt: runtime?.timerEndsAt ?? 0,
      })
    },
    onExit: () => {
      cookingId = null
    },
    onSwitchRecipe: () => void switchToOther(store),
  })

  const ok = await runtime.init()
  if (!ok) {
    root.innerHTML =
      '<div class="error">無法建立眼鏡畫面。請確認 G2 已連線並重新開啟 App。</div>'
    return
  }

  const ui = new PhoneUi(root, store, {
    onCook: async (recipe: Recipe) => {
      // 這道菜可能已經在煮到一半：有進度就接續，不重來。
      const existing = await store.getProgress(recipe.id)
      cookingId = recipe.id
      activeIds.add(recipe.id)
      await runtime!.load(recipe, existing?.stepIndex ?? 0, existing?.timerEndsAt)
    },
    onShowShopping: async (lines: string[]) => {
      // 採購清單接管眼鏡畫面，烹飪中的標記要收掉（但進度都還在，之後能接回來）。
      cookingId = null
      await runtime!.loadShoppingList(lines)
    },
    cookingRecipeId: () => cookingId,
    otherActiveRecipeIds: () => [...activeIds].filter(id => id !== cookingId),
    onRecipeDeleted: id => activeIds.delete(id),
  })
  await ui.start()

  await resume(store)
}

/**
 * 長按觸發：切到「等最久」的另一道進行中食譜，接續它的步驟與計時。
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
    return
  }
  cookingId = recipe.id
  await runtime!.load(recipe, next.stepIndex, next.timerEndsAt)
}

/** 續看：優先用背景快照，其次用所有進度裡最近更新的一筆。 */
async function resume(store: RecipeStore) {
  const all = await store.listProgress()
  activeIds = new Set(all.map(p => p.recipeId))

  const snapshot = restored
  const progress = snapshot?.recipeId
    ? { recipeId: snapshot.recipeId, stepIndex: snapshot.viewIndex, timerEndsAt: snapshot.timerEndsAt }
    : all.length
      ? all.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
      : null
  if (!progress) return

  const recipe = await store.get(progress.recipeId)
  if (!recipe) {
    // 食譜被刪掉了，進度就沒有意義。
    await store.clearProgress(progress.recipeId)
    activeIds.delete(progress.recipeId)
    return
  }
  cookingId = recipe.id
  await runtime!.load(recipe, progress.stepIndex, progress.timerEndsAt)
}

window.addEventListener('beforeunload', () => runtime?.dispose())

boot().catch(err => {
  console.error('啟動失敗：', err)
  const root = document.querySelector<HTMLDivElement>('#app')
  if (root) root.innerHTML = '<div class="error">App 啟動失敗，請重新開啟。</div>'
})
