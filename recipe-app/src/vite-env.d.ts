/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 食譜解析服務的基底 URL，例如 https://recipe-glass-api.你的帳號.workers.dev */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
