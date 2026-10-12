import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { onBackgroundRestore, setBackgroundState } from './core/background'
import { RecipeStore } from './core/storage'
import type { RunningTimer } from './core/timer'
import { difficultyLabel, type Recipe } from './core/types'
import { GlassesRuntime } from './glasses/runtime'
import {
  detectLang,
  onLangChange,
  phoneLanguageTag,
  resolveLang,
  setLang,
  t,
  type LangSetting,
} from './i18n'
import { buildViews, currentStepOf, type MenuItem } from './glasses/views'
import { PhoneUi, type ActiveDish } from './phone/ui'

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
/**
 * 還沒煮完的食譜（可能不只一個）與各自做到哪一步。用來判斷長按能不能切換、
 * 切去哪，也讓手機畫面寫得出「換到 薑母鴨 · 步驟 5」。
 */
let active = new Map<string, ActiveDish>()

/** 進度存的是眼鏡畫面索引；手機要顯示的是第幾步。 */
function dishAt(recipe: Recipe, viewIndex: number): ActiveDish {
  const view = buildViews(recipe)[viewIndex]
  return {
    recipeId: recipe.id,
    name: recipe.name,
    step: view ? currentStepOf(view, recipe.steps.length) : -1,
    stepTotal: recipe.steps.length,
  }
}

// 先照手機語言設好，連啟動失敗的提示都是使用者看得懂的語言；
// 讀到使用者存的設定之後再照設定改。
setLang(detectLang())

async function boot() {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('找不到 #app 容器')

  const bridge = await waitForEvenAppBridge()
  const store = new RecipeStore(bridge)

  let ui: PhoneUi | null = null
  runtime = new GlassesRuntime(bridge, {
    onPositionChange: (recipeId, viewIndex, finished) => {
      cookingId = recipeId
      if (finished) {
        // 煮完了就不算「進行中」：下次開始烹飪從頭來，長按也不會切回這道。
        active.delete(recipeId)
        void store.clearProgress(recipeId)
      } else {
        const state = runtime!.state
        active.set(recipeId, {
          recipeId,
          name: state.title,
          step: state.step,
          stepTotal: state.stepTotal,
        })
        // 每翻一頁就落盤，中途離開 App 或切去煮另一道也能從同一步接續。
        void store.setProgress({ recipeId, stepIndex: viewIndex })
      }
    },
    onExit: () => {
      cookingId = null
    },
    menuItems: () => buildMenuItems(store),
    onPickMenuItem: item => pickMenuItem(store, item),
    // 完成頁長按：這道菜已關閉（進度在走到完成頁時就清掉了），不再算「正在煮」。
    onDishClosed: id => {
      active.delete(id)
      if (cookingId === id) cookingId = null
    },
    onTimersChange: timers => void store.saveTimers(timers),
    // 眼鏡上的任何變化（翻頁、換菜、計時、響鈴）都讓手機畫面跟著更新。
    onStateChange: () => ui?.syncFromGlasses(),
    onRawEvent: event => ui?.logGlassesEvent(event),
  })

  const settings = await store.getSettings()
  setLang(resolveLang(settings.lang))
  runtime.setTimersEnabled(settings.timers !== 'off')
  const ok = await runtime.init()
  if (!ok) {
    root.innerHTML = `<div class="error">${t('e.glasses_boot')}</div>`
    return
  }

  ui = new PhoneUi(root, store, {
    onCook: async (recipe: Recipe) => {
      // 這道菜可能已經在煮到一半：有進度就接續，不重來。手機上的「換到這道」
      // 也走這裡，所以切過去一定回到那道菜上次的那一步。
      const existing = await store.getProgress(recipe.id)
      cookingId = recipe.id
      await runtime!.load(recipe, existing?.stepIndex ?? 0)
    },
    onJumpToStep: async (recipe: Recipe, stepIndex: number) => {
      if (runtime!.loadedRecipeId === recipe.id) {
        await runtime!.jumpToStep(stepIndex)
        return
      }
      // 點的是另一道菜的步驟：眼鏡直接換過去，而且就停在那一步。
      cookingId = recipe.id
      await runtime!.load(recipe, GlassesRuntime.viewIndexOfStep(recipe, stepIndex))
    },
    onStartTimer: (recipe: Recipe, stepIndex: number) =>
      runtime!.startTimerFor(recipe, stepIndex),
    onDismissAlarm: () => void runtime!.dismissAlarm(),
    onStepBy: (delta: number) => runtime!.stepBy(delta),
    timersEnabled: () => runtime!.timersOn,
    onSetTimersEnabled: async (on: boolean) => {
      runtime!.setTimersEnabled(on)
      await store.saveSettings({ ...(await store.getSettings()), timers: on ? 'ask' : 'off' })
    },
    languageSetting: async () => (await store.getSettings()).lang,
    phoneLanguage: () => phoneLanguageTag(),
    onSetLanguage: async (lang: LangSetting) => {
      await store.saveSettings({ ...(await store.getSettings()), lang })
      // setLang 會通知下面訂閱的人：手機畫面重畫、眼鏡畫面重排。
      setLang(resolveLang(lang))
    },
    onStopAll: async () => {
      // 全部不煮了：每一道的進度、所有計時（包括已煮完那道還沒響的）都清掉，
      // 眼鏡回到待命畫面；正在看採購清單的話就留著清單不動。
      const ids = new Set<string>([
        ...active.keys(),
        ...(await store.listProgress()).map(p => p.recipeId),
        ...runtime!.state.timers.map(t => t.recipeId),
      ])
      if (cookingId) ids.add(cookingId)
      for (const id of ids) {
        await store.clearProgress(id)
        runtime!.cancelTimersFor(id)
      }
      active = new Map()
      const showingRecipe = runtime!.loadedRecipeId !== null
      cookingId = null
      if (showingRecipe) await runtime!.unload()
    },
    onStopCooking: async (recipeId: string) => {
      // 不煮了：進度、計時器、還沒響的提醒全部清掉，下次開始從頭來。
      active.delete(recipeId)
      await store.clearProgress(recipeId)
      runtime!.cancelTimersFor(recipeId)
      if (runtime!.loadedRecipeId === recipeId) {
        // 眼鏡正在顯示這道：還有別道在煮就換過去，否則回到待命畫面。
        cookingId = null
        const next = (await store.listProgress()).sort((a, b) => b.updatedAt - a.updatedAt)[0]
        const recipe = next ? await store.get(next.recipeId) : null
        if (recipe && next) {
          cookingId = recipe.id
          await runtime!.load(recipe, next.stepIndex)
          return
        }
        await runtime!.unload()
      }
    },
    glassesState: () => runtime!.state,
    onShowShopping: async (lines: string[]) => {
      // 採購清單接管眼鏡畫面，烹飪中的標記要收掉（但進度都還在，之後能接回來）。
      cookingId = null
      await runtime!.loadShoppingList(lines)
    },
    cookingRecipeId: () => cookingId,
    otherActiveDishes: () => [...active.values()].filter(d => d.recipeId !== cookingId),
    onRecipeDeleted: id => {
      active.delete(id)
      runtime?.cancelTimersFor(id)
    },
  })
  await ui.start()
  // 語言切換（設定頁選的）：手機畫面與眼鏡畫面一起換。
  onLangChange(() => {
    ui?.relocalize()
    void runtime?.relocalize()
  })

  await resume(store)
  runtime.restoreTimers(restored?.timers ?? (await store.getTimers()))
}

/**
 * 眼鏡主選單的項目，順序跟手機的食譜庫一致：眼鏡上正顯示的、其他煮到一半的、
 * 加星號的、其餘；最後是採購清單。不用拿手機，單靠眼鏡就能選菜、換菜。
 */
async function buildMenuItems(store: RecipeStore): Promise<MenuItem[]> {
  const [index, favorites, list] = await Promise.all([
    store.listIndex(),
    store.getFavorites(),
    store.getShoppingList(),
  ])
  const loaded = runtime?.loadedRecipeId ?? null
  const fav = new Set(favorites)
  const rank = (id: string) => (id === loaded ? 0 : active.has(id) ? 1 : fav.has(id) ? 2 : 3)
  const items: MenuItem[] = [...index]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map(e => {
      const dish = active.get(e.id)
      const started = dish && dish.step >= 0 && dish.step < dish.stepTotal
      return {
        kind: 'dish' as const,
        id: e.id,
        name: e.name,
        meta: t('u.rowMeta', { n: e.stepCount, min: e.totalMinutes, diff: difficultyLabel(e.difficulty) }),
        // 還在食材頁（step -1）也算煮到一半：選單裡要能「繼續」而不是「重來」。
        progress: dish ? { step: started ? dish.step + 1 : 0, total: dish.stepTotal } : null,
      }
    })
  const pending = list.pending.length
  items.push({
    kind: 'shopping',
    id: 'shopping',
    name: t('g.shoppingTitle'),
    meta: t('g.menuShopping', { n: pending }),
    progress: null,
  })
  return items
}

async function pickMenuItem(store: RecipeStore, item: MenuItem): Promise<void> {
  if (item.kind === 'shopping') {
    cookingId = null
    await runtime!.loadShoppingList((await store.getShoppingList()).toGlassesLines())
    return
  }
  const recipe = await store.get(item.id)
  if (!recipe) return
  // 煮到一半的菜接續上次那一步，沒煮過的從頭開始。
  const existing = await store.getProgress(recipe.id)
  cookingId = recipe.id
  await runtime!.load(recipe, existing?.stepIndex ?? 0)
}

/** 續看：優先用背景快照，其次用所有進度裡最近更新的一筆。 */
async function resume(store: RecipeStore) {
  const all = await store.listProgress()
  active = new Map()
  for (const p of all) {
    const recipe = await store.get(p.recipeId)
    if (recipe) active.set(recipe.id, dishAt(recipe, p.stepIndex))
    else await store.clearProgress(p.recipeId)
  }

  const snapshot = restored
  const progress = snapshot?.recipeId
    ? { recipeId: snapshot.recipeId, stepIndex: snapshot.viewIndex }
    : all.length
      ? all.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
      : null
  if (!progress) {
    return
  }

  const recipe = await store.get(progress.recipeId)
  if (!recipe) {
    // 食譜被刪掉了，進度就沒有意義。
    await store.clearProgress(progress.recipeId)
    active.delete(progress.recipeId)
    return
  }
  cookingId = recipe.id
  await runtime!.load(recipe, progress.stepIndex)
}

window.addEventListener('beforeunload', () => runtime?.dispose())

boot().catch(err => {
  console.error('啟動失敗：', err)
  const root = document.querySelector<HTMLDivElement>('#app')
  if (root) root.innerHTML = `<div class="error">${t('e.app_boot')}</div>`
})
