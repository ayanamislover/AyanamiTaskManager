import { useSyncExternalStore } from "react";
import {
  PairingPayloadSchema,
  newDeviceId,
  type PairingPayload,
} from "@ayanami-task/sync-protocol";
import type { SyncBackend } from "./data/backend.js";
import { cacheClear } from "./data/cache.js";
import { interpretDeepLink, type DeepLinkIntent } from "./data/deep-link.js";
import { SyncEngine, type Pairing } from "./data/engine.js";
import { RelayBackend } from "./data/relay-backend.js";
import { snapshotScope } from "./data/snapshot.js";
import { createRelayFetch } from "./native/http.js";
import { AtmNative } from "./native/platform.js";
import { resetTo } from "./ui/nav.js";

/**
 * App 级状态：有没有配对、当前的同步引擎、待确认的深链配对、一次性的提示条。
 * 配对信息（含 token 与空间密钥）只进原生安全存储和引擎，这里对外只暴露引擎。
 */
export type AppState =
  | { kind: "booting" }
  | { kind: "unpaired"; pendingLink: PendingLink | null; notice: string | null }
  | { kind: "paired"; engine: SyncEngine; pendingLink: PendingLink | null; notice: string | null };

export type PendingLink = Extract<DeepLinkIntent, { kind: "pair" | "invalid" }>;

const PAIRING_KEY = "pairing.v1";
export const APP_VERSION = __APP_VERSION__;

let state: AppState = { kind: "booting" };
const listeners = new Set<() => void>();

function set(next: AppState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getAppState(): AppState {
  return state;
}

export function useAppState(): AppState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

function restorePairing(raw: string | null): Pairing | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const payload = PairingPayloadSchema.safeParse(value);
    if (!payload.success) return null;
    if (typeof value.deviceId !== "string" || typeof value.deviceName !== "string") return null;
    return {
      ...payload.data,
      deviceId: value.deviceId,
      deviceName: value.deviceName,
      pairedAt: typeof value.pairedAt === "string" ? value.pairedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function createBackend(pairing: Pairing): Promise<SyncBackend> {
  if (import.meta.env.VITE_ATM_DEMO === "1") {
    const demo = await import("./data/demo.js");
    if (demo.isDemoPairing(pairing)) return demo.createDemoBackend();
  }
  return RelayBackend.create(pairing, createRelayFetch());
}

async function startEngine(
  pairing: Pairing,
  carry: Pick<Extract<AppState, { kind: "paired" }>, "pendingLink" | "notice">,
) {
  const engine = new SyncEngine({
    backend: await createBackend(pairing),
    pairing,
    appVersion: APP_VERSION,
  });
  await engine.load();
  set({ kind: "paired", engine, ...carry });
  engine.start();
}

export async function boot(): Promise<void> {
  let pairing: Pairing | null = null;
  try {
    pairing = restorePairing((await AtmNative.secureGet({ key: PAIRING_KEY })).value);
  } catch {
    pairing = null;
  }
  const pendingLink = linkFor(bootUrl, pairing);
  bootUrl = null;
  if (!pairing) {
    set({ kind: "unpaired", pendingLink, notice: null });
    return;
  }
  try {
    await startEngine(pairing, { pendingLink, notice: null });
  } catch {
    // 密钥派生失败等：配对信息不可用，回到配对页。
    set({ kind: "unpaired", pendingLink: null, notice: "配对信息已失效，请重新扫码配对" });
  }
}

// 冷启动时深链可能比安全存储先到：先记下原文，等知道当前有没有配对再解释，
// 否则「已配对时替换」的警告会因为还没读到当前配对而漏掉。
let bootUrl: string | null = null;

function linkFor(url: string | null, pairing: Pairing | null): PendingLink | null {
  const intent: DeepLinkIntent = interpretDeepLink(url, pairing);
  return intent.kind === "ignore" ? null : intent;
}

export function offerLink(url: string | null | undefined): void {
  if (!url) return;
  if (state.kind === "booting") {
    bootUrl = url;
    return;
  }
  const link = linkFor(url, state.kind === "paired" ? state.engine.pairing : null);
  if (link) set({ ...state, pendingLink: link });
}

export function dismissLink(): void {
  if (state.kind === "booting") return;
  set({ ...state, pendingLink: null });
}

export function showNotice(notice: string | null): void {
  if (state.kind === "booting") return;
  set({ ...state, notice });
}

async function defaultDeviceName(): Promise<string> {
  try {
    const info = await AtmNative.deviceInfo();
    const name = [info.manufacturer, info.model].filter(Boolean).join(" ").trim();
    return (name || "Android 手机").slice(0, 64);
  } catch {
    return "Android 手机";
  }
}

/** 确认配对：生成（或沿用）设备身份，写安全存储，换一台引擎。 */
export async function pair(payload: PairingPayload): Promise<void> {
  const previous = state.kind === "paired" ? state.engine : null;
  // 中继地址、应用、空间任何一项变了都算换了一份数据：清掉游标与快照缓存（不同中继的游标互不通用）。
  const sameScope = previous !== null && snapshotScope(previous.pairing) === snapshotScope(payload);
  const pairing: Pairing = {
    ...payload,
    deviceId: previous?.pairing.deviceId ?? newDeviceId("m"),
    deviceName: previous?.pairing.deviceName ?? (await defaultDeviceName()),
    pairedAt: new Date().toISOString(),
  };
  await AtmNative.secureSet({ key: PAIRING_KEY, value: JSON.stringify(pairing) });
  if (previous) await previous.stop();
  if (!sameScope) await cacheClear();
  resetTo({ name: "overview" });
  await startEngine(pairing, { pendingLink: null, notice: `已与 ${payload.n || "电脑"} 配对` });
}

export async function unpair(): Promise<void> {
  if (state.kind === "paired") await state.engine.stop();
  await AtmNative.secureRemove({ key: PAIRING_KEY });
  await cacheClear();
  resetTo({ name: "overview" });
  set({ kind: "unpaired", pendingLink: null, notice: "已解除配对，本机的缓存也已清除" });
}

export async function renameDevice(name: string): Promise<void> {
  if (state.kind !== "paired") return;
  const trimmed = name.trim().slice(0, 64);
  if (!trimmed || trimmed === state.engine.pairing.deviceName) return;
  const pairing: Pairing = { ...state.engine.pairing, deviceName: trimmed };
  await AtmNative.secureSet({ key: PAIRING_KEY, value: JSON.stringify(pairing) });
  const carry = { pendingLink: state.pendingLink, notice: "设备名已更新" };
  await state.engine.stop();
  await startEngine(pairing, carry);
}
