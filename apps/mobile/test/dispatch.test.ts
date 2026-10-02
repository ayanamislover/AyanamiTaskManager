import { describe, expect, it } from "vitest";
import type { CommandDoc, TaskCard } from "@ayanami-task/sync-protocol";
import type { AckResult, LocalCommand } from "../src/data/commands.js";
import {
  describeCommand,
  dispatchAwaitingSnapshot,
  dispatchBlocker,
  dispatchFailureReason,
  dispatchStep,
} from "../src/ui/labels.js";

const NOT_LOGGED_IN =
  "Claude Code 未登录或登录已过期：在电脑终端运行 claude auth login 后再交给 Claude";

function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    key: "DEMO-T-0001",
    title: "从手机交给 Claude",
    status: "READY",
    priority: "NORMAL",
    type: "TASK",
    progress: 0,
    updatedAt: "2026-09-30T21:00:00.000Z",
    ...overrides,
  } as TaskCard;
}

function failed(error?: string, at = "2026-09-30T21:00:05.000Z"): TaskCard["dispatch"] {
  return { state: "failed", at, run: "run-1", ...(error === undefined ? {} : { error }) };
}

describe("dispatchFailureReason：先看回执，再看任务卡", () => {
  it("回执里有 dispatchError 时用它，哪怕任务卡也写了原因", () => {
    const result = { dispatchError: { message: "派单并发已满" } };
    expect(dispatchFailureReason(result, card({ dispatch: failed(NOT_LOGGED_IN) }))).toBe(
      "派单并发已满",
    );
  });

  it("回执没有原因时，用任务卡上 failed 派单的 error", () => {
    expect(dispatchFailureReason({}, card({ dispatch: failed(NOT_LOGGED_IN) }))).toBe(
      NOT_LOGGED_IN,
    );
    expect(dispatchFailureReason(null, card({ dispatch: failed(NOT_LOGGED_IN) }))).toBe(
      NOT_LOGGED_IN,
    );
  });

  it("任务卡的 error 只在 failed 时算数；重新派单跑起来后不再显示旧原因", () => {
    const running = { state: "running", at: "2026-09-30T21:01:00.000Z", run: "run-2" } as const;
    expect(dispatchFailureReason(null, card({ dispatch: { ...running, error: "旧原因" } }))).toBe(
      null,
    );
  });

  it("两边都没有，或只有空白，返回 null（界面不显示原因行）", () => {
    expect(dispatchFailureReason(undefined, card({ dispatch: failed() }))).toBe(null);
    expect(dispatchFailureReason({ dispatchError: { message: "  " } }, card())).toBe(null);
    expect(dispatchFailureReason(null, card({ dispatch: failed("   ") }))).toBe(null);
    expect(dispatchFailureReason(null, null)).toBe(null);
  });
});

function command(
  doc: Partial<CommandDoc> & Pick<CommandDoc, "type" | "body">,
  extra: Partial<LocalCommand> = {},
): LocalCommand {
  return {
    doc: {
      v: 1,
      id: "c-01",
      at: "2026-09-30T21:02:00.000Z",
      device: { id: "m-1", name: "OnePlus" },
      ...doc,
    } as CommandDoc,
    state: "created",
    attempts: 1,
    ...extra,
  };
}

const dispatchDoc = {
  type: "task.dispatch",
  body: { project: "DEMO", key: "DEMO-T-0001" },
} as const;
const accepted = (run: string): AckResult => ({
  project: "DEMO",
  key: "DEMO-T-0001",
  dispatch: { run, state: "queued" },
});

describe("失败后再次交给 Claude", () => {
  it("READY、无人领取、上次 failed 的任务可以再交给", () => {
    expect(dispatchBlocker(card({ dispatch: failed(NOT_LOGGED_IN) }), true)).toBe(null);
  });

  it("被领取或仍在排队 / 运行时不行", () => {
    expect(
      dispatchBlocker(card({ dispatch: failed(), claim: { agent: "claude-code" } }), true),
    ).toMatch(/已被 claude-code 领取/);
    expect(
      dispatchBlocker(
        card({ dispatch: { state: "running", at: "2026-09-30T21:01:00.000Z", run: "r" } }),
        true,
      ),
    ).toBe("已经交给 Claude 了");
  });

  it("电脑已接下新派单但快照还停在上一次 failed：视为在途，按钮不能再点", () => {
    const retry = command(dispatchDoc, {
      result: accepted("run-2"),
      ackAt: "2026-09-30T21:02:01.000Z",
    });
    expect(dispatchAwaitingSnapshot(retry, "DEMO-T-0001", card({ dispatch: failed() }))).toBe(true);
  });

  it("快照出现同一个 run，或出现比回执更晚的派单，就不再拦", () => {
    const retry = command(dispatchDoc, {
      result: accepted("run-2"),
      ackAt: "2026-09-30T21:02:01.000Z",
    });
    const caughtUp = card({
      dispatch: { state: "failed", at: "2026-09-30T21:02:00.500Z", run: "run-2", error: "x" },
    });
    expect(dispatchAwaitingSnapshot(retry, "DEMO-T-0001", caughtUp)).toBe(false);
    const newer = card({ dispatch: failed(undefined, "2026-09-30T21:05:00.000Z") });
    expect(dispatchAwaitingSnapshot(retry, "DEMO-T-0001", newer)).toBe(false);
  });

  it("回执带 dispatchError、没带 run、或不是这个任务的命令，都不拦", () => {
    const task = card({ dispatch: failed() });
    const refused = command(dispatchDoc, {
      result: { project: "DEMO", key: "DEMO-T-0001", dispatchError: { code: "X", message: "y" } },
    });
    expect(dispatchAwaitingSnapshot(refused, "DEMO-T-0001", task)).toBe(false);
    const noRun = command(dispatchDoc, { result: { project: "DEMO", key: "DEMO-T-0001" } });
    expect(dispatchAwaitingSnapshot(noRun, "DEMO-T-0001", task)).toBe(false);
    const other = command(dispatchDoc, { result: accepted("run-9") });
    expect(dispatchAwaitingSnapshot(other, "DEMO-T-0002", task)).toBe(false);
  });
});

describe("发出的任务卡片上的派单失败", () => {
  it("失败时把原因接在「Claude 运行失败」后面", () => {
    const created = command(
      {
        type: "task.create",
        body: { project: "DEMO", title: "从手机交给 Claude", dispatch: true },
      } as CommandDoc,
      { result: accepted("run-1") },
    );
    const view = describeCommand(created, card({ dispatch: failed(NOT_LOGGED_IN) }));
    expect(view.detail).toBe(`Claude 运行失败：${NOT_LOGGED_IN}`);
    expect(describeCommand(created, card({ dispatch: failed() })).detail).toBe("Claude 失败");
  });

  it("快照里找不到任务时，不把回执那一刻的「排队中」当成现在的状态", () => {
    const created = command(
      {
        type: "task.create",
        body: { project: "DEMO", title: "从手机交给 Claude", dispatch: true },
      } as CommandDoc,
      { result: accepted("run-1") },
    );
    const view = describeCommand(created, null);
    expect(view.title).toBe("已创建 DEMO-T-0001");
    expect(view.detail).toBe("已交给 Claude，进度等电脑同步");
  });
});

describe("发送卡片上「Claude 开工」那一步", () => {
  const created = (extra: Partial<LocalCommand> = { result: accepted("run-1") }) =>
    command(
      {
        type: "task.create",
        body: { project: "DEMO", title: "从手机交给 Claude", dispatch: true },
      } as CommandDoc,
      extra,
    );
  const succeeded = { state: "succeeded", at: "2026-09-30T21:03:00.000Z", run: "run-1" } as const;

  it("任务做完、卡上没有派单时按任务状态说，不再停在回执里的「排队中」", () => {
    // 真机复现：旧版电脑不给已结束的任务带派单，发送卡片一直转「Claude 排队中」。
    expect(dispatchStep(created(), card({ status: "DONE", progress: 100 }))).toEqual({
      state: "done",
      label: "任务已完成",
    });
    expect(dispatchStep(created(), card({ status: "CANCELLED" }))).toEqual({
      state: "todo",
      label: "任务已取消",
    });
  });

  it("卡上有派单时以卡为准：任务已完成也显示「Claude 已完成」", () => {
    expect(dispatchStep(created(), card({ status: "DONE", dispatch: succeeded }))).toEqual({
      state: "done",
      label: "Claude 已完成",
    });
    const running = { state: "running", at: "2026-09-30T21:02:30.000Z", run: "run-1" } as const;
    expect(dispatchStep(created(), card({ dispatch: running }))?.label).toBe("Claude 已开工");
  });

  it("快照还没跟上（没有任务，或任务开着但卡上暂无派单）时用回执的状态", () => {
    expect(dispatchStep(created(), null)).toEqual({ state: "active", label: "Claude 排队中" });
    expect(dispatchStep(created(), card())).toEqual({ state: "active", label: "Claude 排队中" });
    expect(dispatchStep(created({ state: "sent" }), null)).toEqual({
      state: "todo",
      label: "Claude 开工",
    });
  });

  it("派单没开始或跑失败时带原因；没勾交给 Claude 的命令没有这一步", () => {
    const refused = created({
      result: {
        project: "DEMO",
        key: "DEMO-T-0001",
        dispatchError: { code: "X", message: "未开启" },
      },
    });
    expect(dispatchStep(refused, card({ status: "DONE" }))).toEqual({
      state: "failed",
      label: "派单没有开始",
      detail: "未开启",
    });
    expect(dispatchStep(created(), card({ dispatch: failed(NOT_LOGGED_IN) }))).toEqual({
      state: "failed",
      label: "Claude 运行失败",
      detail: NOT_LOGGED_IN,
    });
    const plain = command({
      type: "task.create",
      body: { project: "DEMO", title: "只建任务" },
    } as CommandDoc);
    expect(dispatchStep(plain, card({ status: "DONE" }))).toBe(null);
    expect(dispatchStep(command(dispatchDoc, { result: accepted("run-1") }), card())).toBe(null);
  });
});
