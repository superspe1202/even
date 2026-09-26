#!/usr/bin/env node
/**
 * 一鍵部署：挑模型 → 部署 Worker → 設定金鑰 → 驗證 → 把網址填進 App。
 *
 * 需要的環境變數（不要寫進任何檔案）：
 *   GEMINI_API_KEY        Google AI Studio 的 API 金鑰
 *   CLOUDFLARE_API_TOKEN  可選。自己電腦上跑過 `npx wrangler login` 就不需要；
 *                         雲端環境沒有瀏覽器可以登入，才用這個權杖。
 *
 * 用法：cd worker && npm install && node deploy.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..', 'recipe-app')
const wranglerToml = join(here, 'wrangler.toml')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function wrangler(args, input) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: here,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
}

/**
 * 從帳號可用的模型裡挑一個 Flash 等級的穩定版：版本號最新、不是 lite／預覽／實驗版。
 * 整理食譜不需要旗艦模型，Flash 成本差一個數量級。
 */
export function pickModel(ids) {
  const version = id => (id.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? '0'
  const stable = ids
    .map(id => id.replace(/^models\//, ''))
    .filter(id => /^gemini-[\d.]+-flash$/.test(id))
  const pool = stable.length
    ? stable
    : ids.map(id => id.replace(/^models\//, '')).filter(id => /flash/.test(id) && !/lite|image|tts|audio|live/.test(id))
  return pool.sort((a, b) => Number(version(b)) - Number(version(a)))[0] ?? null
}

async function main() {
  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey) fail('缺少環境變數 GEMINI_API_KEY')

  console.log('1/5 查詢可用的 Gemini 模型…')
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', {
    headers: { authorization: `Bearer ${geminiKey}` },
  })
  if (!res.ok) fail(`Gemini 金鑰無法使用（HTTP ${res.status}），請確認金鑰是否正確`)
  const ids = ((await res.json()).data ?? []).map(m => m.id)
  const model = pickModel(ids)
  if (!model) fail(`找不到 Flash 等級的模型。可用清單：${ids.join(', ')}`)
  console.log(`    使用 ${model}`)
  const toml = readFileSync(wranglerToml, 'utf8')
  writeFileSync(wranglerToml, toml.replace(/^AI_MODEL = ".*"$/m, `AI_MODEL = "${model}"`))

  console.log('2/5 部署 Worker…')
  const out = wrangler(['deploy'])
  const url = (out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) ?? [])[0]
  if (!url) fail(`部署完成但找不到網址，wrangler 輸出：\n${out}`)
  console.log(`    ${url}`)

  console.log('3/5 設定 AI 金鑰（只存在 Cloudflare）…')
  wrangler(['secret', 'put', 'AI_API_KEY'], geminiKey)

  console.log('4/5 驗證…')
  // 新部署的 workers.dev 網址有時要幾秒才生效。
  let healthy = false
  for (let i = 0; i < 10 && !healthy; i++) {
    healthy = await fetch(`${url}/health`).then(r => r.ok, () => false)
    if (!healthy) await new Promise(r => setTimeout(r, 3000))
  }
  if (!healthy) fail(`${url}/health 沒有回應`)
  const gen = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '番茄炒蛋' }),
  })
  const body = await gen.json().catch(() => ({}))
  if (!gen.ok || !Array.isArray(body.options)) {
    fail(`AI 搜尋測試失敗（HTTP ${gen.status}）：${JSON.stringify(body).slice(0, 300)}`)
  }
  console.log(`    AI 搜尋正常：${body.options.map(o => o.label).join('、')}`)

  console.log('5/5 把網址填進 App…')
  // 後端網址不是機密，放在會進版控的 .env.production，之後誰打包都會帶到。
  writeFileSync(join(appDir, '.env.production'), `VITE_API_BASE=${url}\n`)
  const appJsonPath = join(appDir, 'app.json')
  const app = JSON.parse(readFileSync(appJsonPath, 'utf8'))
  const network = app.permissions.find(p => p.name === 'network')
  network.whitelist = [url]
  writeFileSync(appJsonPath, JSON.stringify(app, null, 2) + '\n')

  console.log(`\n✓ 完成。後端：${url}\n  接下來：cd ../recipe-app && npm run pack`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => fail(err.message))
}
