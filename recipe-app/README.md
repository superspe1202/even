# Recipe Glass

Even Realities G2 智慧眼鏡的免手操作食譜 App。

手機負責「選與編」，眼鏡負責「做」：在手機上貼一個網頁或 YouTube 連結、
自動轉成步驟化食譜，下廚時抬頭就能看到現在這一步，不必用髒手碰手機。

## 功能

- **URL 匯入** — 貼上食譜網頁或 YouTube 連結，後端抓內容交給 AI 整理成食材與步驟
- **完整編輯** — 新增／刪除食譜，逐項增刪食材，步驟可改寫、排序、刪除
- **步驟計時** — 每步可設定分鐘數，進入該步驟自動倒數，離開自動停止
- **進度續看** — 中途離開 App 或手機切到背景，回來還在同一步
- **眼鏡端操作** — 點擊下一頁、上滑回上頁、雙擊離開

## 開發

```bash
npm install
npm run dev          # http://localhost:5173
npm run simulate     # 桌面模擬器
npm run qr           # 產生 QR code，用手機 Even Hub App 掃描上真機
```

要讓匯入功能可用，必須先部署 `../worker`（見該目錄的 README），
然後在專案根目錄建立 `.env`：

```
VITE_API_BASE=https://recipe-glass-api.你的帳號.workers.dev
```

同一個網址也要填進 `app.json` 的 `permissions[0].whitelist`，否則 Even 會擋下請求。

## 打包上架

```bash
npm run check-id     # 確認 package_id 未被佔用
npm run pack         # 產生 recipe-glass.ehpk
```

把 `.ehpk` 上傳到 Even Hub 開發者後台送審。

## 架構

```
手機 Even Hub App（WebView）
├── src/phone/ui.ts        食譜庫、URL 匯入、編輯器
├── src/core/              型別、儲存、計時、匯入、背景狀態
└── src/glasses/           ↓ 透過 SDK bridge 藍牙推送
    ├── views.ts           版面幾何與畫面攤平
    ├── paginate.ts        像素級分頁（支援中文）
    └── runtime.ts         容器、導覽、計時、事件路由
```

### 幾個關鍵決定

**容器只建立一次。** 啟動時建三個文字容器（標頭／內文／頁尾），之後一律用
`textContainerUpgrade` 就地更新。`rebuildPageContainer` 每次都整頁閃一下，翻步驟時很難看。

**畫面攤平成一維陣列。** 食材頁、每個步驟、完成頁全部攤成一串 `View`，導覽只剩
一個整數索引。進度保存、背景還原、上下頁都變成加減一，不用同時追蹤
「第幾步」和「步驟內第幾頁」兩個狀態。

**計時自動起訖。** 進入步驟第一頁自動起算，離開步驟自動停止，同一步翻頁不重置。
使用者雙手髒的時候不需要為了計時多做任何操作。

**G2 沒有喇叭**，所以計時結束只能用畫面閃爍提示（整片亮／暗交替約 10 秒）。
這點必須寫進上架說明，否則使用者會以為是故障。

**資料一律存 bridge storage。** Even App 是 Flutter WebView，瀏覽器 `localStorage`
與 IndexedDB 在 App 重啟後可能整個消失。長食譜切成 40,000 字一塊分開存。

**AI 輸出一定要正規化。** `src/core/importer.ts` 會把後端回來的東西重新收斂成
合法的 `Recipe`：欄位可能缺、型別可能錯、步驟可能是字串陣列而不是物件陣列。
與其讓眼鏡端渲染時炸開，不如在入口就處理掉。

## 已知限制

- **背景狀態接的是 host 底層協定。** 官方技能文件提到的 `setBackgroundState` /
  `onBackgroundRestore` 在已發布的 SDK 0.0.15 裡查無此符號，所以
  `src/core/background.ts` 直接實作 `window.__getStateSnapshot` /
  `window.__restoreState`。SDK 補上之後可以換掉這個檔案，對外介面刻意設計成一樣。
- **繁體中文字型未在真機驗證。** 分頁邏輯已用 `@evenrealities/pretext` 依 LVGL
  真實字寬測過（長中文不超行、不掉字），但韌體字型若缺字會**靜默略過**，
  這只有在模擬器或真機上才看得出來。上架前務必實測。
- 匯入功能依賴 `../worker`，沒部署就只能手動新增食譜。
