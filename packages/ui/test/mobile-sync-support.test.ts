import { describe, expect, it } from "vitest";
import type { DispatchRunView } from "@ayanami-task/client";
import {
  claudeReadiness,
  DEVICE_ONLINE_WINDOW_MS,
  describeRelayTest,
  deviceKindLabel,
  deviceOnline,
  DISPATCH_ACTIVE_REFRESH_MS,
  dispatchFailureReason,
  dispatchLedgerNotice,
  dispatchRefetchInterval,
  featureUnavailable,
  formatCountdown,
  formatLatency,
  latestRunFor,
  modelInput,
  PERMISSION_MODES,
  pollingLabel,
  problemText,
  relativeTime,
  relayUrlProblem,
  runWindow,
  shortSessionId,
  syncConfigPatch,
  syncDraftProblem,
  syncLamp,
  taskAcceptsDispatch,
} from "../src/features/mobile-sync-support.js";
import { ATM_QUERY_REFRESH_INTERVAL_MS } from "../src/query-policy.js";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(overrides: Partial<DispatchRunView>): DispatchRunView {
  return {
    run: "r1",
    project: "ATM",
    key: "ATM-T-1",
    title: "任务",
    origin: "desktop",
    state: "succeeded",
    sessionId: "0f5e7c1a-1111-2222-3333-444455556666",
    createdAt: ago(60_000),
    ...overrides,
  };
}

describe("同步状态灯", () => {
  it("未启用、连接中、正常、出错各有中文说法，出错带原因", () => {
    expect(syncLamp({ enabled: false, state: "online", lastError: null })).toMatchObject({
      state: "off",
      label: "未启用",
    });
    expect(syncLamp({ enabled: true, state: "connecting", lastError: null }).label).toBe("连接中");
    expect(syncLamp({ enabled: true, state: "online", lastError: null })).toMatchObject({
      state: "ok",
      label: "正常",
      reason: null,
    });
    expect(
      syncLamp({ enabled: true, state: "error", lastError: "中继拒绝了 token" }),
    ).toMatchObject({ state: "error", label: "出错", reason: "中继拒绝了 token" });
    expect(syncLamp({ enabled: true, state: "error", lastError: null }).reason).toBe("原因未知");
  });

  it("宿主没有这项功能（404）和读失败分开处理", () => {
    expect(featureUnavailable({ status: 404, message: "当前 ATM 宿主没有启用 Claude 派单" })).toBe(
      true,
    );
    expect(featureUnavailable({ status: 500 })).toBe(false);
    expect(featureUnavailable(new Error("断网"))).toBe(false);
    expect(featureUnavailable(null)).toBe(false);
  });

  it("错误可能是一句话，也可能是 {code, message}", () => {
    expect(problemText("断网")).toBe("断网");
    expect(problemText({ code: "UNAUTHORIZED", message: "token 无效" })).toBe("token 无效");
    expect(problemText(null)).toBeNull();
    expect(problemText("")).toBeNull();
  });
});

describe("测试连接与状态文案", () => {
  it("延迟、长轮询与服务身份拼成一行", () => {
    expect(formatLatency(42.4)).toBe("42 ms");
    expect(formatLatency(1530)).toBe("1.5 s");
    expect(formatLatency(null)).toBe("未知");
    expect(
      describeRelayTest({
        ok: true,
        latencyMs: 42,
        longPoll: true,
        server: { name: "atm-relay", version: "1.0.0" },
      }),
    ).toBe("连接正常 · 延迟 42 ms · 支持长轮询 · atm-relay 1.0.0");
    expect(describeRelayTest({ ok: true, latencyMs: 80, longPoll: false })).toBe(
      "连接正常 · 延迟 80 ms · 不支持长轮询，将每 4 秒轮询一次",
    );
    expect(
      describeRelayTest({
        ok: false,
        latencyMs: null,
        longPoll: false,
        error: { code: "UNAUTHORIZED", message: "中继拒绝了 token" },
      }),
    ).toBe("连接失败：中继拒绝了 token");
  });

  it("轮询方式、相对时间与设备类型", () => {
    expect(pollingLabel(null)).toBe("尚未连上");
    expect(pollingLabel(true)).toContain("长轮询");
    expect(pollingLabel(false)).toContain("每 4 秒");
    expect(relativeTime(null, NOW)).toBe("从未");
    expect(relativeTime(ago(10_000), NOW)).toBe("刚刚");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 分钟前");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3 小时前");
    expect(deviceKindLabel("android")).toBe("Android 手机");
    expect(deviceKindLabel("toaster")).toBe("其他设备");
  });

  it("设备在线：状态为 online 且 7 分钟内写过", () => {
    expect(deviceOnline({ state: "online", at: ago(60_000) }, NOW)).toBe(true);
    expect(deviceOnline({ state: "online", at: ago(DEVICE_ONLINE_WINDOW_MS + 1) }, NOW)).toBe(
      false,
    );
    expect(deviceOnline({ state: "offline", at: ago(1000) }, NOW)).toBe(false);
  });
});

describe("中继表单校验", () => {
  const draft = {
    relayUrl: "https://relay.example.com",
    appId: "atm",
    token: "secret",
    deviceName: "书房电脑",
  };

  it("中继地址必须 https，只有本机回环可以用 http", () => {
    expect(relayUrlProblem("https://relay.example.com")).toBeNull();
    expect(relayUrlProblem("http://127.0.0.1:8790")).toBeNull();
    expect(relayUrlProblem("http://localhost:8790")).toBeNull();
    expect(relayUrlProblem("http://192.168.1.5:8790")).toContain("https://");
    expect(relayUrlProblem("relay.example.com")).toBe("中继地址不是有效的网址");
    expect(relayUrlProblem(" ")).toBe("请填写中继地址");
  });

  it("token 已保存时可留空；测试连接不要求本机名称", () => {
    expect(syncDraftProblem(draft, false)).toBeNull();
    expect(syncDraftProblem({ ...draft, token: "" }, false)).toBe("请填写中继 token");
    expect(syncDraftProblem({ ...draft, token: "" }, true)).toBeNull();
    expect(syncDraftProblem({ ...draft, appId: "ATM!" }, true)).toContain("应用 ID");
    expect(syncDraftProblem({ ...draft, deviceName: " " }, true)).toBe("请填写本机名称");
    expect(syncDraftProblem({ ...draft, deviceName: " " }, true, true)).toBeNull();
  });

  it("留空的 token 不发出去（空串会被服务端当成清除）", () => {
    expect(syncConfigPatch({ ...draft, token: "  " }, true)).toEqual({
      relayUrl: "https://relay.example.com",
      appId: "atm",
      deviceName: "书房电脑",
      enabled: true,
    });
    expect(syncConfigPatch({ ...draft, token: " new " })).toMatchObject({ token: "new" });
    expect(syncConfigPatch(draft)).not.toHaveProperty("enabled");
  });
});

describe("派单", () => {
  it("请求账本提示：读不出来、丢过数据各一句；正常或旧版宿主没给字段时不提示", () => {
    expect(dispatchLedgerNotice(undefined)).toBeNull();
    expect(
      dispatchLedgerNotice({ lostBefore: null, lostUntil: null, unavailable: false }),
    ).toBeNull();
    const unreadable = dispatchLedgerNotice({
      lostBefore: null,
      lostUntil: null,
      unavailable: true,
    });
    expect(unreadable).toContain("暂时读不出来");
    expect(unreadable).toContain("在电脑上直接派单不受影响");
    const lost = dispatchLedgerNotice({
      lostBefore: ago(0),
      lostUntil: ago(-9 * 86_400_000),
      unavailable: false,
    })!;
    expect(lost).toContain("派单记录损坏过");
    expect(lost).toContain("及之前从手机发出");
    expect(lost).toContain("在手机上重新「交给 Claude」即可");
    expect(lost).toContain("自动消失");
    // 时间按界面统一格式显示，不把 ISO 原文甩给用户。
    expect(lost).not.toContain("T12:00:00.000Z");
  });

  it("只有 READY / BACKLOG 且没有有效领取的任务能交给 Claude", () => {
    expect(taskAcceptsDispatch({ status: "READY" }, NOW)).toBe(true);
    expect(taskAcceptsDispatch({ status: "BACKLOG", claimedBySessionId: null }, NOW)).toBe(true);
    expect(taskAcceptsDispatch({ status: "IN_PROGRESS" }, NOW)).toBe(false);
    expect(
      taskAcceptsDispatch(
        { status: "READY", claimedBySessionId: "s1", claimLeaseUntil: ago(-60_000) },
        NOW,
      ),
    ).toBe(false);
    // 租约已过期的领取不算有效领取。
    expect(
      taskAcceptsDispatch(
        { status: "READY", claimedBySessionId: "s1", claimLeaseUntil: ago(60_000) },
        NOW,
      ),
    ).toBe(true);
    expect(taskAcceptsDispatch({ status: "READY", claimedBySessionId: "s1" }, NOW)).toBe(false);
  });

  it("同一任务取最近一次派单；运行中才加快刷新", () => {
    const runs = [
      run({ run: "old", createdAt: ago(3_600_000), state: "failed" }),
      run({ run: "new", createdAt: ago(60_000), state: "running" }),
      run({ run: "other", key: "ATM-T-2", createdAt: ago(1000) }),
    ];
    expect(latestRunFor(runs, "ATM", "ATM-T-1")?.run).toBe("new");
    expect(latestRunFor(runs, "ATM", "ATM-T-9")).toBeNull();
    expect(dispatchRefetchInterval({ runs })).toBe(DISPATCH_ACTIVE_REFRESH_MS);
    expect(dispatchRefetchInterval({ runs: [run({ state: "succeeded" })] })).toBe(
      ATM_QUERY_REFRESH_INTERVAL_MS,
    );
    expect(dispatchRefetchInterval(undefined)).toBe(ATM_QUERY_REFRESH_INTERVAL_MS);
  });

  it("Claude Code 一行：没找到、未登录、查不出、已登录四种说法", () => {
    // 路径用正斜杠写，compactPath 统一换成反斜杠并只留最后两段。
    const base = { found: true, path: "C:/Users/me/.local/bin/claude.exe", version: "2.1.93" };
    const shortPath = String.raw`…\bin\claude.exe`;
    expect(claudeReadiness({ found: false, path: null, loggedIn: null })).toMatchObject({
      tone: "warning",
      label: "未找到",
      needsLogin: false,
    });
    expect(claudeReadiness({ ...base, loggedIn: false })).toEqual({
      tone: "warning",
      label: "未登录",
      detail: `${shortPath} · 2.1.93`,
      needsLogin: true,
    });
    // null 与旧版 daemon 缺字段一样：不下结论。
    for (const claude of [{ ...base, loggedIn: null }, base]) {
      expect(claudeReadiness(claude)).toEqual({
        tone: "success",
        label: "已找到 · 2.1.93",
        detail: shortPath,
        needsLogin: false,
      });
    }
    expect(claudeReadiness({ ...base, loggedIn: true, authMethod: "claude.ai" }).detail).toBe(
      `${shortPath} · 已登录（claude.ai）`,
    );
  });

  it("只有失败的派单带原因，空白原因不算", () => {
    expect(dispatchFailureReason({ state: "failed", error: " 登录过期 " })).toBe("登录过期");
    expect(dispatchFailureReason({ state: "failed", error: "  " })).toBeNull();
    expect(dispatchFailureReason({ state: "failed" })).toBeNull();
    expect(dispatchFailureReason({ state: "cancelled", error: "用户结束" })).toBeNull();
  });

  it("模型名留空跟随默认，非法字符拒绝；权限模式里只有 bypass 标成有风险", () => {
    expect(modelInput("  ")).toEqual({ model: null, problem: null });
    expect(modelInput(" claude-opus-5-5 ")).toEqual({ model: "claude-opus-5-5", problem: null });
    expect(modelInput("opus; rm -rf").problem).toContain("模型名");
    expect(PERMISSION_MODES.map((mode) => mode.value)).toEqual([
      "auto",
      "acceptEdits",
      "bypassPermissions",
      "plan",
    ]);
    expect(PERMISSION_MODES.filter((mode) => mode.risky).map((mode) => mode.value)).toEqual([
      "bypassPermissions",
    ]);
    expect(PERMISSION_MODES[0]!.label).toContain("推荐");
  });

  it("会话 ID、倒计时与起止时间", () => {
    expect(shortSessionId("0f5e7c1a-1111-2222")).toBe("0f5e7c1a…");
    expect(shortSessionId("abc")).toBe("abc");
    expect(formatCountdown(120_000)).toBe("2:00");
    expect(formatCountdown(61_001)).toBe("1:02");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(runWindow({ createdAt: ago(0) })).toMatch(/^提交 /u);
    expect(runWindow({ createdAt: ago(0), startedAt: ago(0), endedAt: ago(0) })).toMatch(
      /^开始 .+ · 结束 /u,
    );
  });
});
