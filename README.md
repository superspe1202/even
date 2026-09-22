# Even 數位眼鏡

Even（Even Realities）數位眼鏡（智慧眼鏡）相關資料與筆記。

## 用途

存放數位眼鏡的裝置資料、開發筆記與實地應用紀錄，例如：

- 裝置規格、韌體版本與 SDK 筆記
- 配戴操作流程與教學
- 應用構想、整合測試紀錄（如田野調查、資料回報等場景）
- 相關照片、影片與示意圖

## 目錄結構

| 資料夾 | 說明 |
| --- | --- |
| `recipe-app/` | Recipe Glass —— G2 免手操作食譜 App |
| `worker/` | 食譜解析後端（Cloudflare Worker） |
| `docs/` | 規格、SDK、操作手冊等文件 |
| `assets/` | 圖片、影片、示意圖等素材 |
| `notes/` | 測試紀錄、會議筆記、待辦想法 |

## 文件

| 文件 | 說明 |
| --- | --- |
| [docs/even-g2-官方資源.md](docs/even-g2-官方資源.md) | Even Realities G2 官方 GitHub、SDK、硬體規格、開發流程與上架規則彙整 |
| [docs/食譜App-企劃.md](docs/食譜App-企劃.md) | Recipe Glass 的產品企劃、系統架構、畫面設計與上架準備 |
| [recipe-app/README.md](recipe-app/README.md) | App 的開發、打包與架構說明 |
| [worker/README.md](worker/README.md) | 解析後端的設定、部署與已知限制 |

## 備註

G2 App 開發走 Even Hub（Vite + TypeScript + Web SDK）路線，非 G1 的原生藍牙架構，
詳見官方資源文件。
