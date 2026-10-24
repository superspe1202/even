// Regression check for /generate: runs a fixed dish list one request at a time (parallel calls time out).
// Usage: node scripts/regression-dishes.mjs [baseUrl]
// Checks per dish: HTTP 200, a Traditional-Chinese-looking recipe, and for baked dishes that the steps
// contain oven temperatures. Prints one line per dish and exits 1 if any check fails.

const BASE = process.argv[2] ?? 'https://recipe-glass-api.superspe.workers.dev'

// baked: true means the steps must mention an oven temperature (°C).
const DISHES = [
  { q: '戚風蛋糕', baked: true, expectSource: 'reference' },
  { q: '可麗露', baked: true, expectSource: 'estimate' },
  { q: '法國麵包', baked: true, expectSource: 'reference' },
  { q: '奶油餅乾', baked: true, expectSource: 'reference' },
  { q: '鳳梨酥', baked: true, expectSource: 'reference' },
  { q: '蛋塔', baked: true, expectSource: 'reference' },
  { q: '布朗尼', baked: true, expectSource: 'reference' },
  { q: '起司蛋糕', baked: true, expectSource: 'reference' },
  { q: '瑪德蓮', baked: true, expectSource: 'reference' },
  { q: '費南雪', baked: true, expectSource: 'reference' },
  { q: '黑森林蛋糕', baked: true, expectSource: 'reference' },
  { q: '提拉米蘇', baked: false, expectSource: 'model' },
  { q: '番茄炒蛋', baked: false, expectSource: 'model' },
  { q: '麻婆豆腐', baked: false, expectSource: 'model' },
  { q: '紅燒肉', baked: false, expectSource: 'model' },
  { q: '炸雞排', baked: false, expectSource: 'model' },
  { q: '味噌湯', baked: false, expectSource: 'model' },
  { q: '親子丼', baked: false, expectSource: 'model' },
  { q: '泡菜鍋', baked: false, expectSource: 'model' },
  { q: '牛肉麵', baked: false, expectSource: 'model' },
]

const OVEN_TEMP = /°C|℃/
const CJK = /[一-鿿]/

async function runOne(dish) {
  const started = Date.now()
  const response = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: dish.q, lang: 'zh', detail: 'brief' }),
    signal: AbortSignal.timeout(170_000),
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !Array.isArray(body.options)) {
    return { dish: dish.q, ok: false, seconds, detail: `HTTP ${response.status} ${body.code ?? ''}` }
  }
  const recipe = body.options[0].recipe
  const steps = recipe.steps.map(s => s.text)
  const problems = []
  if (!steps.some(s => CJK.test(s))) problems.push('steps not Chinese')
  if (dish.baked && !steps.some(s => OVEN_TEMP.test(s))) problems.push('no oven temperature')
  if (!dish.baked && steps.some(s => OVEN_TEMP.test(s))) problems.push('unexpected oven step')
  if (body.ovenSource !== dish.expectSource) problems.push(`ovenSource ${body.ovenSource}, expected ${dish.expectSource}`)
  return { dish: dish.q, ok: problems.length === 0, seconds, detail: problems.join('; ') || 'pass' }
}

let failed = 0
for (const dish of DISHES) {
  const result = await runOne(dish)
  if (!result.ok) failed++
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.dish.padEnd(8)} ${String(result.seconds).padStart(3)}s  ${result.detail}`)
}
console.log(`\n${DISHES.length - failed}/${DISHES.length} passed`)
process.exit(failed ? 1 : 0)
