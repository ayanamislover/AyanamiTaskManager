import { useEffect, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import {
  boot,
  dismissLink,
  getAppState,
  offerLink,
  pair,
  showNotice,
  useAppState,
  type PendingLink,
} from "./app-state.js";
import { relayLabel } from "./data/pairing-input.js";
import { isNative } from "./native/platform.js";
import { NewTaskScreen } from "./screens/new-task.js";
import { OverviewScreen } from "./screens/overview.js";
import { PairingScreen } from "./screens/pairing.js";
import { ProjectScreen } from "./screens/project.js";
import { SettingsScreen } from "./screens/settings.js";
import { TaskScreen } from "./screens/task-detail.js";
import { ConfirmSheet } from "./ui/controls.js";
import { EngineContext } from "./ui/hooks.js";
import { handleBack, useNav, type Route } from "./ui/nav.js";
import { Presence } from "./ui/presence.js";

/** 系统层面的接线：返回键、前后台、深链。只装一次。 */
function useSystemEvents(): void {
  useEffect(() => {
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = [];
    handles.push(
      CapacitorApp.addListener("backButton", () => {
        if (!handleBack()) void CapacitorApp.exitApp();
      }),
    );
    handles.push(
      CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        const state = getAppState();
        if (state.kind !== "paired") return;
        if (isActive) state.engine.start();
        else state.engine.pause();
      }),
    );
    handles.push(
      CapacitorApp.addListener("appUrlOpen", ({ url }) => {
        offerLink(url);
      }),
    );
    let removeVisibility: (() => void) | null = null;
    if (isNative) {
      void CapacitorApp.getLaunchUrl().then((launch) => {
        if (!launch?.url) return;
        // 同一次启动只处理一次（Activity 不重建，但网页可能重载）。
        try {
          if (sessionStorage.getItem("atm-launch-url") === launch.url) return;
          sessionStorage.setItem("atm-launch-url", launch.url);
        } catch {
          // 忽略
        }
        offerLink(launch.url);
      });
    } else {
      // 浏览器开发：用页面可见性模拟前后台。
      const onVisibility = () => {
        const state = getAppState();
        if (state.kind !== "paired") return;
        if (document.visibilityState === "visible") state.engine.start();
        else state.engine.pause();
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
    }
    void boot();
    return () => {
      removeVisibility?.();
      for (const handle of handles) void handle.then((listener) => listener.remove());
    };
  }, []);
}

export function App() {
  useSystemEvents();
  const app = useAppState();

  if (app.kind === "booting") return <div className="boot" aria-busy="true" />;
  return (
    <>
      {app.kind === "unpaired" ? (
        <PairingScreen />
      ) : (
        <EngineContext.Provider value={app.engine}>
          <Stack key={app.engine.pairing.deviceId + app.engine.pairing.s} />
          <ReplaceSheet link={app.pendingLink} />
        </EngineContext.Provider>
      )}
      {app.kind === "paired" ? <Toast message={app.notice} /> : null}
    </>
  );
}

function routeKey(route: Route, index: number): string {
  switch (route.name) {
    case "project":
      return `${index}:project:${route.code}`;
    case "task":
      return `${index}:task:${route.code}:${route.key}`;
    case "new":
      return `${index}:new:${route.code ?? ""}`;
    default:
      return `${index}:${route.name}`;
  }
}

function renderRoute(route: Route) {
  switch (route.name) {
    case "overview":
      return <OverviewScreen />;
    case "project":
      return <ProjectScreen code={route.code} />;
    case "task":
      return <TaskScreen code={route.code} taskKey={route.key} />;
    case "new":
      return <NewTaskScreen {...(route.code ? { initialProject: route.code } : {})} />;
    case "settings":
      return <SettingsScreen />;
  }
}

/**
 * 页面栈整栈挂着：返回时下面那一页的滚动位置、展开状态都还在。
 * 不在栈顶的页面 content-visibility: hidden（保留布局与滚动位置、不参与绘制）并 inert。
 */
function Stack() {
  const { stack, direction } = useNav();
  return (
    <div className="stack">
      {stack.map((route, index) => {
        const top = index === stack.length - 1;
        return (
          <div
            key={routeKey(route, index)}
            className="stack-page"
            data-active={top ? "true" : "false"}
            data-enter={top ? direction : "none"}
            inert={top ? undefined : true}
            aria-hidden={top ? undefined : true}
          >
            {renderRoute(route)}
          </div>
        );
      })}
    </div>
  );
}

/** 已配对时收到新的 atm1: 深链：说明会替换当前配对，确认后才换。 */
function ReplaceSheet({ link }: { link: PendingLink | null }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (link?.kind === "invalid") {
      showNotice(`收到的配对码无法使用：${link.error.message}`);
      dismissLink();
    }
  }, [link]);
  const pairLink = link?.kind === "pair" ? link : null;
  const same = pairLink?.replaces?.sameSpace ?? false;
  return (
    <ConfirmSheet
      open={pairLink !== null}
      title={same ? "重新连接这台电脑？" : "替换当前配对？"}
      confirmLabel={same ? "重新连接" : "替换配对"}
      tone={same ? "primary" : "danger"}
      busy={busy}
      onCancel={dismissLink}
      onConfirm={() => {
        if (!pairLink) return;
        setBusy(true);
        void pair(pairLink.payload)
          .catch(() => showNotice("没能保存配对信息，请重试"))
          .finally(() => setBusy(false));
      }}
    >
      {pairLink ? (
        <>
          <p>
            将与「{pairLink.payload.n || "电脑"}」配对，中继{" "}
            <span className="mono">{relayLabel(pairLink.payload.u)}</span>。
          </p>
          {pairLink.replaces && !same ? (
            <p className="sheet-warning">
              当前已与「{pairLink.replaces.hostName}」（{relayLabel(pairLink.replaces.relay)}
              ）配对。继续会断开它， 并清掉这台手机上缓存的任务。不认识这个配对码就点取消。
            </p>
          ) : null}
        </>
      ) : null}
    </ConfirmSheet>
  );
}

function Toast({ message }: { message: string | null }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!message) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => showNotice(null), 3200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message]);
  return (
    <Presence present={Boolean(message)} fallbackMs={300}>
      {message ? (
        <div className="toast" role="status">
          {message}
        </div>
      ) : null}
    </Presence>
  );
}
