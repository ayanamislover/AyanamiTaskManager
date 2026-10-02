import type { CapacitorConfig } from "@capacitor/cli";
import { version } from "./package.json";

// WebView 远程调试只给 build-debug.ps1 打开；发布构建由 build-release.ps1 清掉这个变量并在 APK 里断言为 false。
const webViewDebug = process.env.ATM_MOBILE_WEBVIEW_DEBUG === "1";

const config: CapacitorConfig = {
  appId: "moe.ayanami.atm",
  appName: "ATM 任务",
  webDir: "dist",
  loggingBehavior: webViewDebug ? "debug" : "none",
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: webViewDebug,
    appendUserAgent: `ATM/${version} (Android)`,
    backgroundColor: "#fbf7ff",
  },
  plugins: {
    // 系统栏留边由 MainActivity 自己做（见 docs/mobile-sync.md §9），不让 SystemBars 再垫一层。
    SystemBars: { insetsHandling: "disable" },
    // 只在同步层显式调用 CapacitorHttp.request，不全局替换 fetch / XHR。
    CapacitorHttp: { enabled: false },
  },
};

export default config;
