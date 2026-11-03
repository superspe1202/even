# Even Realities G2 官方開發資源彙整

> 蒐集日期：2026-09-22（台灣時間）
> 來源：GitHub `even-realities` 官方組織、官方開發者文件與 npm 套件

---

## 一、官方 GitHub 組織

官方組織位置：<https://github.com/even-realities>（共 5 個公開 repo）

| Repo | 語言 | 授權 | 說明 | 最後更新 |
| --- | --- | --- | --- | --- |
| [everything-evenhub](https://github.com/even-realities/everything-evenhub) | — | MIT | **官方 AI 開發技能包**，13 個 skill 涵蓋 G2 開發全流程，支援 Claude Code / Codex CLI | 2026-08-20 |
| [evenhub-templates](https://github.com/even-realities/evenhub-templates) | TypeScript | MIT | **官方四種起始範本**（minimal / asr / image / text-heavy） | 2026-08-07 |
| [lvgl-sys-v9](https://github.com/even-realities/lvgl-sys-v9) | Rust | — | 韌體端 LVGL v9 綁定 | 2026-08-31 |
| [EvenDemoApp](https://github.com/even-realities/EvenDemoApp) | C | BSD-2 | **舊版 G1** 的 iOS/Android 藍牙示範 App（476 stars） | 2026-06-09 |
| [EH-InNovel](https://github.com/even-realities/EH-InNovel) | Kotlin | — | Even Hub 的小說閱讀器示範 | 2026-03-25 |

> ⚠️ **注意**：`EvenDemoApp` 是 **G1** 世代的原生藍牙協定示範，跟 G2 的 Even Hub 網頁式 App 架構完全不同。做 G2 App 請走 `evenhub-templates` 這條路，不要參考 EvenDemoApp。

### 官方文件與套件

- 開發者文件：<https://hub.evenrealities.com/docs/getting-started/overview>
- SDK（npm）：[`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- CLI（npm）：[`@evenrealities/evenhub-cli`](https://www.npmjs.com/package/@evenrealities/evenhub-cli)
- 模擬器（npm）：[`@evenrealities/evenhub-simulator`](https://www.npmjs.com/package/@evenrealities/evenhub-simulator)
- 文字量測（npm）：[`@evenrealities/pretext`](https://www.npmjs.com/package/@evenrealities/pretext)
- 設計規範（Figma）：[Even Realities Software Design Guidelines (Public)](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=2922-80782)
- 社群 Discord：<https://discord.gg/Y4jHMCU4sv>

### 社群資源（非官方但實用）

- [nickustinov/even-g2-notes](https://github.com/nickustinov/even-g2-notes) — 架構解析、**完整可用字型表**、SDK 眉角、錯誤碼、參考實作
- [fabioglimb/even-toolkit](https://github.com/fabioglimb/even-toolkit) — 55+ React 元件、191 個像素圖示、設計 token、分頁工具
- [awesome-even-realities-g2](https://github.com/JintaoHe/awesome-even-realities-g2) — 資源彙整清單

---

## 二、硬體規格（開發必記）

| 項目 | 規格 |
| --- | --- |
| 顯示 | **576 × 288 px**（每眼），4-bit 灰階 = 16 階綠色 |
| 顯示特性 | 白像素 = 亮綠；黑像素 = 關閉（透明）。**無背景色、無填滿色** |
| 麥克風 | 眼鏡端四麥陣列；PCM s16le / 16 kHz / 單聲道 |
| 相機 | **無** |
| 喇叭 | **無** |
| 輸入 | 鏡腳觸控板（單擊／雙擊／上下滑），可選配 R1 戒指 |

### UI 限制

- **沒有 CSS、沒有 flexbox、沒有 DOM**，UI 是絕對定位的像素容器
- 每頁最多 **12 個容器**（8 個文字/列表 + 4 個圖片）
- **必須且只能有一個** 容器設 `isEventCapture: 1`
- `containerID` 每頁唯一（整數）；`containerName` 每頁唯一（字串，**最長 16 字元**）
- 字型是韌體內建單一 LVGL 字型：**非等寬**，不能選字型／字級／粗體／斜體
- **字型沒有的字會被靜默略過**（中文請務必先在模擬器驗證）
- 無文字對齊功能，置中要自己補空白
- 行高固定 **27px**；全螢幕文字容器約可容納 **400–500 字元**
- 圖片容器：寬 20–288 px、高 20–144 px，且**不可並發傳送**

### 文字長度硬限制

| API | 上限 |
| --- | --- |
| `textContainerUpgrade` | 2000 字元 |
| `rebuildPageContainer` | 1000 字元／容器 |

---

## 三、技術架構

G2 App（官方稱 plugin）本質是**跑在手機 Even Hub App WebView 裡的網頁**，透過 SDK bridge 把畫面推到眼鏡上。

```
你的 Vite + TypeScript 網頁
        ↓ @evenrealities/even_hub_sdk (bridge)
手機 Even Hub App（Android=Chromium / iOS=WKWebView）
        ↓ 藍牙
G2 眼鏡（LVGL 韌體渲染）
```

### 核心 SDK API

| 分類 | API |
| --- | --- |
| 建立畫面 | `createStartUpPageContainer`、`rebuildPageContainer` |
| 更新文字 | `textContainerUpgrade`（**不閃爍，優先用這個**） |
| 圖片 | `updateImageRawData` |
| 事件 | `onEvenHubEvent`、`onDeviceStatusChanged`、`onLaunchSource` |
| 結束 | `shutDownPageContainer(1)` |
| 音訊 | `audioControl(true/false, AudioInputSource.Glasses \| .Phone)` |
| 動作感測 | `imuControl(true, ImuReportPace.P500)` |
| 定位 | `getAppLocation`、`startAppLocationUpdates`、`onAppLocationChanged` |
| 相片 | `pickImageFromAlbum`、`captureImageFromCamera`（走手機，非眼鏡） |
| 儲存 | `setLocalStorage` / `getLocalStorage` |
| 裝置資訊 | `getDeviceInfo`、`getUserInfo` |
| 背景狀態 | `setBackgroundState` / `onBackgroundRestore` |

### 三個最容易踩的坑

**1. 單擊事件沒有 `eventType` 欄位**

`CLICK_EVENT` 的值是 `0`，protobuf 會省略零值欄位，所以單擊送上來的封包**完全沒有 `eventType`**：

```jsonc
{ "sysEvent": { "eventSource": 1 } }               // 單擊：沒有 eventType
{ "sysEvent": { "eventType": 3, "eventSource": 1 } } // 雙擊：有值
```

正確寫法是**在信封檢查內部**解析預設值：

```ts
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
```

❌ 絕對不要寫成 `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` —— 這會讓每一個滾動、生命週期事件、音訊封包都觸發單擊處理器。

另外：**先比對有明確值的事件**（`DOUBLE_CLICK_EVENT`=3、`SCROLL_TOP_EVENT`=1、`SCROLL_BOTTOM_EVENT`=2），`CLICK_EVENT` 一定要**最後**才判斷。事件分流也要分開接：點擊／生命週期走 `sysEvent`，滑動走 `textEvent`，PCM 走 `audioEvent`。

**2. 瀏覽器 localStorage 不可靠**

Flutter WebView 環境下，瀏覽器的 `localStorage` 與 IndexedDB **在 App 重啟後可能遺失**。所有使用者狀態一律用 `bridge.setLocalStorage` / `getLocalStorage`。大量內容請切塊（建議每塊 50,000 字元）存多個 key。

**3. CORS 照常生效**

`app.json` 的 network 白名單是 **Even 層級的權限檢查，不會繞過 CORS**。你需要兩者兼備：白名單 + 對方 API 有正確的 CORS 標頭。公開 CORS proxy（corsproxy.io 等）不穩定，建議自架 Cloudflare Worker。

---

## 四、開發流程

### 建專案

```bash
npx degit even-realities/evenhub-templates/text-heavy my-app
cd my-app && npm install && npm run dev
```

### 測試

```bash
# 桌面模擬器
npx evenhub-simulator http://localhost:5173

# 真機（用手機 Even Hub App 掃 QR）
npx evenhub qr --url http://<你的IP>:5173
```

### 官方 AI 技能包（建議安裝）

本 repo 已在 `.claude/settings.json` 登記市集並啟用外掛，**在此專案開啟的新工作階段會自動載入**：

```json
{
  "extraKnownMarketplaces": {
    "everything-evenhub": {
      "source": { "source": "github", "repo": "even-realities/everything-evenhub" }
    }
  },
  "enabledPlugins": {
    "everything-evenhub@everything-evenhub": true
  }
}
```

若要在其他專案手動安裝，在 Claude Code 中執行：

```
/plugin marketplace add even-realities/everything-evenhub
/plugin install everything-evenhub@everything-evenhub
```

更新市集：`/plugin marketplace update everything-evenhub`

安裝後可用的 13 個技能：

| 層級 | 技能 | 用途 |
| --- | --- | --- |
| Tier 1 | `quickstart` | 從零建立空白 G2 App |
| Tier 1 | `template` | 從官方範本建立專案 |
| Tier 1 | `build-and-deploy` | 打包並發布到 Even Hub |
| Tier 2 | `glasses-ui` | 建構眼鏡端 UI |
| Tier 2 | `handle-input` | 處理觸控／戒指／生命週期事件 |
| Tier 2 | `device-features` | 音訊、IMU、定位、儲存 |
| Tier 2 | `test-with-simulator` | 模擬器除錯 |
| Tier 2 | `simulator-automation` | 模擬器 HTTP API 自動化測試 |
| Tier 2 | `font-measurement` | 像素級文字量測 |
| Tier 2 | `background-state` | 背景狀態保存 |
| Tier 3 | `sdk-reference` / `cli-reference` / `design-guidelines` | 查詢參考 |

---

## 五、上架流程（Even Hub）

Even Hub 應用商店於 **2026-04-03 正式上線**，首波約 50 個 App。目前**自助註冊開發者、但上架需經 Even 官方人工審核**。

### 步驟

```bash
# 1. 先檢查 package_id 是否已被佔用
npx evenhub pack app.json dist -c

# 2. 建置
npm run build

# 3. 打包成 .ehpk
npx evenhub pack app.json dist -o my-app.ehpk

# 4. 上傳 .ehpk 到 Even Hub 開發者後台送審
```

### `app.json` 欄位規則（全部必填）

| 欄位 | 型別 | 驗證規則 |
| --- | --- | --- |
| `package_id` | string | 反向網域格式，**只能小寫字母與數字**，不可有連字號／底線／大寫；至少 2 段；每段須以小寫字母開頭 |
| `edition` | string | 必須正好是 `"202601"` |
| `name` | string | **最多 20 字元** |
| `version` | string | semver `x.y.z` 三段數字，不可有 `v` 前綴或預發布標籤 |
| `min_app_version` | string | 例如 `"2.0.0"` |
| `min_sdk_version` | string | 對應你建置用的 SDK 版本（範本為 `0.0.10`，官方文件目前建議 `0.0.12`） |
| `entrypoint` | string | 相對於建置輸出資料夾的入口檔，**建置後必須真實存在** |
| `permissions` | array | **必須是物件陣列**，可為空 `[]`；不可用 key-value map |
| `supported_languages` | array | 僅限 `en`, `de`, `fr`, `es`, `it`, `zh`, `ja`, `ko` |

### 權限清單

| 權限名稱 | 說明 |
| --- | --- |
| `network` | 對外網路（**必須附 `whitelist` 陣列**） |
| `location` | GPS 定位 |
| `g2-microphone` | 眼鏡端麥克風 |
| `phone-microphone` | 手機麥克風 |
| `album` | 相簿存取 |
| `camera` | 相機 |

權限格式範例：

```json
"permissions": [
  {
    "name": "network",
    "desc": "抓取食譜資料。",
    "whitelist": ["https://api.example.com"]
  }
]
```

### 常見打包錯誤

| 錯誤 | 解法 |
| --- | --- |
| `Invalid package id` | 改成全小寫反向網域，去掉連字號／底線 |
| `name: must be 20 characters or fewer` | 縮短 `name` |
| `version: must be in x.y.z format` | 用三段數字，例如 `1.0.0` |
| `permissions: each permission must be an object...` | 改成物件陣列格式 |
| `Entrypoint file not found` | 先 `npm run build`，確認入口檔在輸出資料夾內 |
