# recipe-glass-api

Recipe Glass 的解析後端，跑在 Cloudflare Worker 上。

## 為什麼一定要有這個後端

眼鏡 App 是跑在手機 WebView 裡的網頁，有兩件事它自己做不到：

1. **金鑰不能放前端。** 上架的 `.ehpk` 任何人都能解壓縮，AI API key 放進去等於公開。
2. **CORS 擋住第三方網站。** `app.json` 的 network 白名單是 Even 層級的權限檢查，
   **不會繞過瀏覽器 CORS**。絕大多數食譜網站不會發 `Access-Control-Allow-Origin`，
   前端直接 `fetch` 一定失敗。

所以「抓網頁 / 抓 YouTube 字幕 / 呼叫 AI」三件事都在這裡做。App 只跟這一個網域說話，
`app.json` 的白名單也因此只需要列這一個位址。

## API

### `POST /extract`

```jsonc
// 請求
{ "url": "https://example.com/recipe" }

// 回應（200）
{
  "name": "蔥油雞",
  "servings": 2,
  "totalMinutes": 40,
  "ingredients": [{ "item": "雞腿", "amount": "2 支" }],
  "steps": [{ "text": "雞腿下鍋煎至金黃", "timerSeconds": 300, "tip": "不要翻動" }]
}

// 失敗（4xx / 502）
{ "error": "這部影片沒有可用的字幕，無法解析成食譜。" }
```

前端會再做一次欄位正規化（`src/core/importer.ts`），所以模型少給欄位或型別不對不會讓 App 崩潰。

### `GET /health`

回 `{ "ok": true }`，用來確認部署成功。

## 設定

非機密設定在 `wrangler.toml` 的 `[vars]`：

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `AI_BASE_URL` | 相容 OpenAI chat-completions 的端點 | Gemini 相容端點 |
| `AI_MODEL` | 模型 ID | `gemini-3-flash` |
| `ALLOW_ORIGIN` | CORS 允許來源 | `*` |
| `AI_JSON_MODE` | 設成 `off` 可停用 `response_format` | `json_object` |

機密值**一律**用 secret，不要寫進 `wrangler.toml`（它會進版控）：

```bash
npx wrangler secret put AI_API_KEY
npx wrangler secret put APP_TOKEN   # 可選，見下方
```

## 使用 Gemini（預設）

`wrangler.toml` 預設已指向 Gemini 的 OpenAI 相容端點：

```
https://generativelanguage.googleapis.com/v1beta/openai
```

到 [Google AI Studio](https://aistudio.google.com/apikey) 取得 API key，然後：

```bash
npx wrangler secret put AI_API_KEY
```

**模型 ID 請先確認再填。** Gemini 的型號更迭很快（3.x 系列有 Pro、Flash、
Flash-Lite 多條線），`wrangler.toml` 裡的 `gemini-3-flash` 只是佔位值，
你的帳號未必有這個 ID。列出實際可用的清單：

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/openai/models" \
  -H "authorization: Bearer $GEMINI_API_KEY" | grep '"id"'
```

食譜解析是「讀一段文字、吐結構化 JSON」，不需要旗艦推理模型。
挑 **Flash 或 Flash-Lite** 等級即可，成本差一個數量級。

### 相容層的注意事項

- `AI_BASE_URL` 結尾要停在 `/openai`，程式會自己接 `/chat/completions`，多加路徑會 404。
- 認證用 `Authorization: Bearer <key>`，程式已經這樣送。
- Gemini 相容層對 `response_format` 的支援依模式而異。程式在收到 400 且錯誤訊息
  提到 `response_format` 時會**自動退回不帶該參數重試一次**，所以即使不支援也能運作
  —— system prompt 本身就要求只輸出 JSON，`parseJsonLoose` 也會剝掉 markdown 圍欄。
  確定不支援的話可以直接設 `AI_JSON_MODE = "off"` 省下一次往返。

## 換成其他服務

端點是 OpenAI 相容格式，所以 OpenAI、Groq、Together、OpenRouter
與多數自架推論服務都能直接接，只要改 `AI_BASE_URL` 與 `AI_MODEL`：

```toml
AI_BASE_URL = "https://api.openai.com/v1"
AI_MODEL = "gpt-4o-mini"
```

## 部署

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put AI_API_KEY
npx wrangler deploy
```

部署完會得到一個網址，例如 `https://recipe-glass-api.你的帳號.workers.dev`。
接著要做兩件事，**缺一個 App 就會連不上**：

1. 在 `recipe-app/.env` 寫入
   `VITE_API_BASE=https://recipe-glass-api.你的帳號.workers.dev`
2. 把同一個網址填進 `recipe-app/app.json` 的 `permissions[0].whitelist`

本機開發：

```bash
echo 'AI_API_KEY="sk-..."' > .dev.vars   # 已在 .gitignore
npx wrangler dev
```

## 關於 `APP_TOKEN` 的限制

設了 `APP_TOKEN` 之後，請求必須帶 `x-app-token` 標頭才會被處理。這能擋掉
隨手掃到這個網址的流量，但**它不是真正的機密** —— 權杖同樣會被打包進 `.ehpk`，
有心人解壓縮就拿得到。

它的價值在於可撤換：外洩了就換一個，不像 AI 金鑰外洩要重新申請並承擔已產生的費用。
如果你在意成本失控，真正有效的是在 Cloudflare 儀表板上為這個 Worker 加
**Rate Limiting**，或用 **Cloudflare Access** 做真正的驗證。

## 已知限制

- **YouTube 字幕是非官方路徑。** 沒有公開 API，只能從 watch 頁面內嵌的
  `ytInitialPlayerResponse` 撈字幕軌網址。YouTube 改版時會壞掉，程式會回
  「沒有可用的字幕」而不是丟出例外，但那時就需要修 `src/youtube.ts`。
- **沒有字幕的影片無法解析。** 純畫面的料理影片抽不出文字。
- **需要登入或由 JavaScript 動態載入的頁面抓不到內容。** Worker 只拿得到初始 HTML，
  這種情況會回「這個頁面幾乎沒有文字內容」。
- 網頁內容截到 24,000 字、下載上限 2 MB，避免 token 與記憶體失控。
