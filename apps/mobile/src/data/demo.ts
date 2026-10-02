import type { PairingPayload } from "@ayanami-task/sync-protocol";
import { DemoBackend, type DemoScenario } from "./demo-backend.js";
import { DEMO_HOST, DEMO_SPACE_ID } from "./demo-data.js";

/**
 * 演示模式入口：只被 `import.meta.env.VITE_ATM_DEMO === "1"` 分支动态引用，发布构建里整段被摇掉
 * （build-release.ps1 的 APK 断言会检查）。
 */
const DEMO_RELAY = "https://demo.atm.invalid";

export function demoPairingPayload(): PairingPayload {
  return {
    v: 1,
    u: DEMO_RELAY,
    a: "atm",
    t: "demo-token-not-a-secret",
    s: DEMO_SPACE_ID,
    k: "ZGVtby1zcGFjZS1zZWNyZXQtbm90LWEtcmVhbC1rZXk",
    n: DEMO_HOST.name,
  };
}

export function isDemoPairing(pairing: { u: string; s: string }): boolean {
  return pairing.u === DEMO_RELAY && pairing.s === DEMO_SPACE_ID;
}

let current: DemoBackend | null = null;

export function createDemoBackend(): DemoBackend {
  current?.dispose();
  current = new DemoBackend(readScenario());
  // 截图与走查用：在 WebView 调试台里切换演示场景。
  (window as unknown as { __atmDemo?: unknown }).__atmDemo = {
    scenario(next: DemoScenario) {
      try {
        sessionStorage.setItem("atm-demo-scenario", next);
      } catch {
        // 忽略
      }
      current?.setScenario(next);
    },
  };
  return current;
}

function readScenario(): DemoScenario {
  try {
    return (sessionStorage.getItem("atm-demo-scenario") as DemoScenario | null) ?? "live";
  } catch {
    return "live";
  }
}
