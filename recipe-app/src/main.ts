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

async function boot() {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('找不到 #app 容器')

  const bridge = await waitForEvenAppBridge()
  const store = new RecipeStore(bridge)

  let cookingId: string | null = null

  runtime = new GlassesRuntime(bridge, {
    onPositionChange: (recipeId, viewIndex) => {
      cookingId = recipeId
      // 每翻一頁就落盤，中途離開 App 也能從同一步接續。
      void store.setProgress({ recipeId, stepIndex: viewIndex })
    },
    onExit: () => {
      cookingId = null
    },
  })

  const ok = await runtime.init()
  if (!ok) {
    root.innerHTML =
      '<div class="error">無法建立眼鏡畫面。請確認 G2 已連線並重新開啟 App。</div>'
    return
  }

  const ui = new PhoneUi(root, store, {
    onCook: async (recipe: Recipe) => {
      cookingId = recipe.id
      await runtime!.load(recipe, 0)
    },
    onShowShopping: async (lines: string[]) => {
      // 採購清單接管眼鏡畫面，烹飪中的標記要收掉。
      cookingId = null
      await runtime!.loadShoppingList(lines)
    },
    cookingRecipeId: () => cookingId,
  })
  await ui.start()

  await resume(store)
}

/** 續看：優先用背景快照，其次用落盤的進度。 */
async function resume(store: RecipeStore) {
  const snapshot = restored
  const progress = snapshot?.recipeId
    ? { recipeId: snapshot.recipeId, stepIndex: snapshot.viewIndex }
    : await store.getProgress()
  if (!progress) return

  const recipe = await store.get(progress.recipeId)
  if (!recipe) {
    // 食譜被刪掉了，進度就沒有意義。
    await store.clearProgress()
    return
  }
  await runtime!.load(recipe, progress.stepIndex)
}

window.addEventListener('beforeunload', () => runtime?.dispose())

boot().catch(err => {
  console.error('啟動失敗：', err)
  const root = document.querySelector<HTMLDivElement>('#app')
  if (root) root.innerHTML = '<div class="error">App 啟動失敗，請重新開啟。</div>'
})
