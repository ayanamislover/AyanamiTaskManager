/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 从 package.json 注入。 */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** 为 "1" 时打包演示数据层（只用于开发与截图，发布构建不带）。 */
  readonly VITE_ATM_DEMO?: string;
}
