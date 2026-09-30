import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, DispatchStatus, SyncStatus } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { DispatchPanel } from "../src/features/dispatch-panel.js";
import { MobileSyncPanel } from "../src/features/mobile-sync-panel.js";
import { TaskDispatchBadge, TaskDispatchButton } from "../src/features/task-dispatch.js";

const featureRoot = join(process.cwd(), "packages", "ui", "src", "features");
const source = (file: string) => readFileSync(join(featureRoot, file), "utf8");

const client = {
  getSyncStatus: vi.fn(),
  getDispatchStatus: vi.fn(),
} as unknown as AyanamiClient;

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: false,
    configured: false,
    relayUrl: null,
    appId: "atm",
    deviceName: "书房电脑",
    state: "disabled",
    lastError: null,
    lastSyncAt: null,
    longPoll: null,
    secretStore: "safeStorage",
    paired: [],
    pendingCommands: 0,
    ...overrides,
  };
}

function dispatchStatus(overrides: Partial<DispatchStatus> = {}): DispatchStatus {
  return {
    enabled: true,
    permissionMode: "auto",
    maxConcurrent: 1,
    model: null,
    effort: null,
    claude: {
      found: true,
      path: "C:/Users/me/.local/bin/claude.exe",
      version: "2.1.0",
      loggedIn: true,
      authMethod: "claude.ai",
    },
    runs: [],
    ...overrides,
  };
}

function render(element: ReactElement, data: Array<[readonly unknown[], unknown]>) {
  const queryClient = new QueryClient();
  for (const [key, value] of data) queryClient.setQueryData(key, value);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, element));
}

const syncPanel = (status: SyncStatus) =>
  render(createElement(MobileSyncPanel, { client, notify: vi.fn() }), [[["sync-status"], status]]);

describe("手机同步面板", () => {
  it("未配置：说明自带服务器、四个字段、token 是密码框、测试连接与保存并启用", () => {
    const markup = syncPanel(syncStatus());
    expect(markup).toContain('class="atm-panel atm-settings-sync"');
    expect(markup).toContain("像 RustDesk 一样用你自己的中继服务器；ATM 不内置任何服务器");
    for (const label of ["中继地址", "应用 ID", "中继 token", "本机名称"]) {
      expect(markup).toContain(`>${label}</label>`);
    }
    expect(markup).toMatch(/id="sync-token" type="password"/u);
    expect(markup).toMatch(/id="sync-app-id"[^>]*value="atm"/u);
    expect(markup).toContain("测试连接");
    expect(markup).toContain("保存并启用");
    expect(markup).toMatch(/data-state="off"[^>]*>未启用</u);
    expect(markup).not.toContain("开发模式");
    expect(markup).not.toMatch(/<select(?:\s|>)/u);
  });

  it("token 已保存时不回显，只提示可以重新填写", () => {
    const markup = syncPanel(
      syncStatus({ configured: true, relayUrl: "https://relay.example.com" }),
    );
    expect(markup).toContain('placeholder="已保存 · 重新填写可替换"');
    expect(markup).toMatch(/id="sync-token"[^>]*value=""/u);
  });

  it("已启用：状态灯、四个事实、设备列表和四个操作；明文存储给出开发模式提醒", () => {
    const markup = syncPanel(
      syncStatus({
        enabled: true,
        configured: true,
        relayUrl: "https://relay.example.com/base",
        state: "error",
        lastError: "中继拒绝了 token",
        lastSyncAt: new Date().toISOString(),
        longPoll: true,
        secretStore: "plaintext",
        pendingCommands: 2,
        paired: [
          {
            id: "dev1",
            name: "我的 Pixel",
            kind: "android",
            role: "client",
            app: "atm",
            at: new Date().toISOString(),
            state: "online",
          },
        ],
      }),
    );
    expect(markup).toMatch(/data-state="error" title="中继拒绝了 token"[^>]*>出错</u);
    expect(markup).toContain("同步出错：中继拒绝了 token");
    expect(markup).toContain("relay.example.com");
    expect(markup).toContain("<dt>待处理命令</dt><dd>2</dd>");
    expect(markup).toContain("我的 Pixel");
    expect(markup).toContain("Android 手机 · 最后在线 刚刚");
    expect(markup).toContain(">在线<");
    expect(markup).toContain("开发模式");
    for (const action of ["连接设置", "停用同步", "重置配对", "添加手机"]) {
      expect(markup).toContain(`>${action}</button>`);
    }
    expect(markup).not.toContain("保存并启用");
  });

  it("配对码只活在对话框自己的 state 里：不进 react-query，也不写日志", () => {
    const pairing = source("mobile-sync-pairing.tsx");
    expect(pairing).toContain("client.createSyncPairing()");
    expect(pairing).not.toMatch(/useQuery|useMutation|queryClient|console\./u);
    expect(pairing).toContain("PAIRING_VISIBLE_MS");
    expect(pairing).toContain("配对码包含中继 token 和加密密钥，只给自己的手机看。");
    for (const file of ["mobile-sync-panel.tsx", "mobile-sync-form.tsx"]) {
      expect(source(file)).not.toContain("createSyncPairing");
    }
  });
});

describe("Claude 自动开工面板", () => {
  const panel = (status: DispatchStatus) =>
    render(createElement(DispatchPanel, { client, notify: vi.fn() }), [
      [["dispatch-status"], status],
    ]);

  it("开关、Claude 位置、四个字段用自绘下拉，说明不自己挑任务", () => {
    const markup = panel(dispatchStatus({ enabled: false }));
    expect(markup).toContain('class="atm-panel atm-settings-dispatch"');
    expect(markup).toContain("只处理你明确交给 Claude 的任务，不会自己挑任务");
    expect(markup).toMatch(/aria-pressed="false"[^>]*>已关闭</u);
    expect(markup).toContain("已找到 · 2.1.0");
    expect(markup.match(/role="combobox"/gu)).toHaveLength(3);
    expect(markup).toContain("自动（推荐）");
    expect(markup).toContain('placeholder="跟随 Claude Code 默认"');
    expect(markup).toContain("还没有派单");
    expect(markup).not.toMatch(/<select(?:\s|>)/u);
  });

  it("bypassPermissions 的说明标成危险色；claude 没找到时给出原因", () => {
    const markup = panel(
      dispatchStatus({
        permissionMode: "bypassPermissions",
        claude: { found: false, path: null, loggedIn: null },
      }),
    );
    expect(markup).toMatch(/data-tone="danger">跳过全部确认：有风险/u);
    expect(markup).toContain("没有找到 claude 命令行");
    expect(markup).toContain(">未找到<");
  });

  it("claude 登录过期：Claude Code 一行是「未登录」，下面给出可复制的 claude auth login", () => {
    const markup = panel(
      dispatchStatus({
        claude: { found: true, path: "C:/bin/claude.exe", version: "2.1.93", loggedIn: false },
      }),
    );
    expect(markup).toContain('class="atm-badge warning">未登录<');
    expect(markup).not.toContain("已找到");
    expect(markup).toContain(
      "Claude Code 未登录或登录已过期：在这台电脑的终端运行 <code>claude auth login</code>，派单才能开工",
    );
    expect(markup).toContain(">复制命令</button>");
  });

  it("登录状态查不出来（null）或已登录时不提示", () => {
    for (const loggedIn of [null, true] as const) {
      const markup = panel(
        dispatchStatus({
          claude: { found: true, path: "C:/bin/claude.exe", version: "2.1.93", loggedIn },
        }),
      );
      expect(markup).toContain('class="atm-badge success">已找到 · 2.1.93<');
      expect(markup).not.toContain("claude auth login");
      expect(markup).not.toContain("未登录");
    }
    expect(panel(dispatchStatus())).toContain("已登录（claude.ai）");
  });

  it("派单列表：任务键、来源、状态徽标、摘要；运行中的才能结束", () => {
    const markup = panel(
      dispatchStatus({
        runs: [
          {
            run: "r1",
            project: "ATM",
            key: "ATM-T-0546",
            title: "桌面面板",
            origin: "mobile",
            state: "running",
            sessionId: "0f5e7c1a-1111-2222-3333-444455556666",
            createdAt: "2026-09-30T10:00:00.000Z",
            startedAt: "2026-09-30T10:00:02.000Z",
          },
          {
            run: "r0",
            project: "ATM",
            key: "ATM-T-0500",
            title: "旧任务",
            origin: "desktop",
            state: "succeeded",
            sessionId: "aaaaaaaa-bbbb",
            createdAt: "2026-09-29T10:00:00.000Z",
            endedAt: "2026-09-29T10:30:00.000Z",
            summary: { numTurns: 12, durationMs: 1000, totalCostUsd: 0.3, result: "已完成并交接" },
          },
        ],
      }),
    );
    expect(markup.indexOf("ATM-T-0546")).toBeLessThan(markup.indexOf("ATM-T-0500"));
    expect(markup).toContain("来自手机");
    expect(markup).toContain("来自桌面");
    expect(markup).toContain('class="atm-badge primary">进行中<');
    expect(markup).toContain('class="atm-badge success">已完成<');
    expect(markup).toContain("已完成并交接");
    expect(markup).toContain("0f5e7c1a…");
    expect(markup.match(/>结束<\/button>/gu)).toHaveLength(1);
    expect(markup.match(/>复制会话 ID<\/button>/gu)).toHaveLength(2);
  });
});

describe("任务抽屉「交给 Claude」", () => {
  // 抽屉里状态徽标进状态行、按钮进操作行；两者读同一份派单状态。
  const control = (status: DispatchStatus | undefined, taskStatus = "READY") => {
    const props = { client, project: "ATM", taskKey: "ATM-T-1" };
    const data: Array<[readonly unknown[], unknown]> = status
      ? [[["dispatch-status"], status]]
      : [];
    return {
      badge: render(createElement(TaskDispatchBadge, props), data),
      button: render(
        createElement(TaskDispatchButton, {
          ...props,
          task: { status: taskStatus, claimedBySessionId: null, claimLeaseUntil: null },
          notify: vi.fn(),
        }),
        data,
      ),
    };
  };

  it("派单开启且任务可派时才有按钮；读不到派单状态时什么都不画", () => {
    expect(control(dispatchStatus())).toEqual({
      badge: "",
      button: '<button class="atm-button" type="button">交给 Claude</button>',
    });
    expect(control(dispatchStatus({ enabled: false })).button).toBe("");
    expect(control(dispatchStatus(), "IN_PROGRESS").button).toBe("");
    expect(control(undefined)).toEqual({ badge: "", button: "" });
  });

  it("已有派单在状态行显示最近一次；排队或运行中不再给按钮", () => {
    const base = {
      run: "r1",
      project: "ATM",
      key: "ATM-T-1",
      title: "任务",
      origin: "desktop" as const,
      sessionId: "s",
      createdAt: "2026-09-30T10:00:00.000Z",
    };
    const queued = control(dispatchStatus({ runs: [{ ...base, state: "queued" }] }));
    expect(queued.badge).toContain("Claude 排队中");
    expect(queued.button).toBe("");
    const failed = control(dispatchStatus({ runs: [{ ...base, state: "failed" }] }));
    expect(failed.badge).toBe(
      '<span class="atm-badge danger" data-testid="task-dispatch-state">Claude 失败</span>',
    );
    // 失败原因紧跟在徽标后面，是次要文字。
    const reason = "Claude Code 未登录或登录已过期：在这台电脑的终端运行 claude auth login";
    const failedWithReason = control(
      dispatchStatus({ runs: [{ ...base, state: "failed", error: reason }] }),
    );
    expect(failedWithReason.badge).toContain(
      `Claude 失败</span><span class="atm-row-sub atm-task-dispatch-reason" title="${reason}">${reason}</span>`,
    );
    // 只有失败才带原因。
    const cancelled = control(
      dispatchStatus({ runs: [{ ...base, state: "cancelled", error: "用户结束" }] }),
    );
    expect(cancelled.badge).not.toContain("用户结束");
    expect(failed.button).toContain(">交给 Claude</button>");
    // 别的任务的派单不算这个任务的。
    const other = control(
      dispatchStatus({ runs: [{ ...base, key: "ATM-T-2", state: "running" }] }),
    );
    expect(other.badge).toBe("");
    expect(other.button).toContain(">交给 Claude</button>");
  });

  it("徽标在状态行、按钮在操作行", () => {
    const drawer = readFileSync(join(featureRoot, "task-drawer.tsx"), "utf8");
    const block = (marker: string) => {
      const from = drawer.indexOf(marker);
      return drawer.slice(from, drawer.indexOf("</div>", from));
    };
    expect(block('className="atm-drawer-status"')).toContain("<TaskDispatchBadge");
    expect(block('"atm-actions atm-drawer-actions"')).toContain("<TaskDispatchButton");
  });
});
