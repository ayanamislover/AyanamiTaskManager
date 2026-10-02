import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * 本应用自己的原生插件（android/app/src/main/java/moe/ayanami/atm/AtmNativePlugin.java）。
 *
 * - secure*：Android Keystore 里的 AES-256-GCM 密钥加密后存 SharedPreferences，
 *   用来放中继 token 和空间密钥。密钥不可导出，应用数据不参与云备份与设备迁移。
 * - setSystemBars：状态栏 / 导航栏图标深浅与窗口底色跟随界面主题（包括用户手动选的主题）。
 * - deviceInfo：给默认设备名用。
 */
export interface AtmNativePlugin {
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
  setSystemBars(options: { dark: boolean; background: string }): Promise<void>;
  deviceInfo(): Promise<{ manufacturer: string; model: string; sdk: number; webView: string }>;
}

const DEV_PREFIX = "atm-dev-secure:";

/**
 * 浏览器开发用的替身：只在桌面浏览器里跑 `vite dev` 时生效，APK 里永远走原生实现。
 * localStorage 不是安全存储，所以这里只该出现演示数据或本机调试中继的 token。
 */
const webFallback: AtmNativePlugin = {
  async secureGet({ key }) {
    try {
      return { value: localStorage.getItem(DEV_PREFIX + key) };
    } catch {
      return { value: null };
    }
  },
  async secureSet({ key, value }) {
    try {
      localStorage.setItem(DEV_PREFIX + key, value);
    } catch {
      // 隐私模式下写不进去：本次会话内仍可用，只是下次要重新配对。
    }
  },
  async secureRemove({ key }) {
    try {
      localStorage.removeItem(DEV_PREFIX + key);
    } catch {
      // 同上
    }
  },
  async setSystemBars() {},
  async deviceInfo() {
    return { manufacturer: "Browser", model: "开发预览", sdk: 0, webView: navigator.userAgent };
  },
};

export const AtmNative = registerPlugin<AtmNativePlugin>("AtmNative", {
  web: () => webFallback,
});

export const isNative = Capacitor.isNativePlatform();

export type NativeInsets = { top: number; right: number; bottom: number; left: number };

/**
 * MainActivity 注入的同步接口：启动第一帧之前就要知道系统深浅色和系统栏高度，
 * 等异步插件回来再改会闪一下。只读、只返回数字和布尔值。
 */
type NativeSync = { isDark(): boolean; insets(): string };

function nativeSync(): NativeSync | null {
  const candidate = (window as unknown as { AtmNativeSync?: NativeSync }).AtmNativeSync;
  return candidate && typeof candidate.isDark === "function" ? candidate : null;
}

export function nativeIsDark(): boolean | null {
  try {
    return nativeSync()?.isDark() ?? null;
  } catch {
    return null;
  }
}

export function nativeInsets(): NativeInsets | null {
  try {
    const raw = nativeSync()?.insets();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NativeInsets>;
    return {
      top: Number(parsed.top) || 0,
      right: Number(parsed.right) || 0,
      bottom: Number(parsed.bottom) || 0,
      left: Number(parsed.left) || 0,
    };
  } catch {
    return null;
  }
}

/** 原生在系统主题或系统栏尺寸变化时派发的事件名。 */
export const NATIVE_EVENT = "atm:native";
export type NativeEventDetail = { dark?: boolean; insets?: NativeInsets };
