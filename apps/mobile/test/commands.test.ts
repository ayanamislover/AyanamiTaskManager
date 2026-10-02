import { describe, expect, it } from "vitest";
import { newCommandId, type AckDoc, type CommandDoc } from "@ayanami-task/sync-protocol";
import {
  FINISHED_RETENTION_MS,
  acksToClear,
  commandsAwaitingAck,
  commandsToSend,
  reduceCommands,
  restoreCommands,
  type LocalCommand,
} from "../src/data/commands.js";

const DEVICE = { id: "m-0123456789ab", name: "测试手机" };
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

function command(at = T0, title = "修一下登录页"): CommandDoc {
  return {
    v: 1,
    id: newCommandId(DEVICE.id, at),
    device: DEVICE,
    at: new Date(at).toISOString(),
    type: "task.create",
    body: { project: "ATM", title, priority: "NORMAL", dispatch: true },
  };
}

function okAck(doc: CommandDoc, key = "ATM-T-0561"): AckDoc {
  return {
    v: 1,
    id: doc.id,
    at: new Date(T0 + 5_000).toISOString(),
    ok: true,
    result: { project: "ATM", key, dispatch: { run: "run-1", state: "queued" } },
  };
}

function failAck(doc: CommandDoc): AckDoc {
  return {
    v: 1,
    id: doc.id,
    at: new Date(T0 + 5_000).toISOString(),
    ok: false,
    error: { code: "PROJECT_NOT_FOUND", message: "电脑上没有这个项目" },
  };
}

describe("命令队列状态机", () => {
  it("pending → sent → created，回执删除后可以清理", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    expect(list[0]?.state).toBe("pending");
    expect(commandsToSend(list)).toHaveLength(1);

    list = reduceCommands(list, { type: "send-error", id: doc.id, message: "连不上中继" });
    expect(list[0]).toMatchObject({ state: "pending", attempts: 1, lastError: "连不上中继" });

    list = reduceCommands(list, {
      type: "send-ok",
      id: doc.id,
      at: new Date(T0 + 1000).toISOString(),
    });
    expect(list[0]).toMatchObject({ state: "sent", attempts: 2 });
    expect(list[0]?.lastError).toBeUndefined();
    expect(commandsToSend(list)).toHaveLength(0);
    expect(commandsAwaitingAck(list)).toHaveLength(1);

    list = reduceCommands(list, { type: "ack", ack: okAck(doc) });
    expect(list[0]).toMatchObject({ state: "created", result: { key: "ATM-T-0561" } });
    expect(acksToClear(list)).toHaveLength(1);

    list = reduceCommands(list, { type: "ack-cleared", id: doc.id });
    expect(acksToClear(list)).toHaveLength(0);
    // 保留期内还在，过了保留期被清掉。
    expect(reduceCommands(list, { type: "prune", now: T0 + 60_000 })).toHaveLength(1);
    expect(
      reduceCommands(list, { type: "prune", now: T0 + FINISHED_RETENTION_MS + 60_000 }),
    ).toHaveLength(0);
  });

  it("失败回执进入 failed 并带上电脑给的原因", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    list = reduceCommands(list, { type: "send-ok", id: doc.id, at: new Date(T0).toISOString() });
    list = reduceCommands(list, { type: "ack", ack: failAck(doc) });
    expect(list[0]).toMatchObject({
      state: "failed",
      error: { code: "PROJECT_NOT_FOUND", message: "电脑上没有这个项目" },
    });
  });

  it("没记下 send-ok 就收到回执（发出后被杀）也能直接结束", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    expect(commandsAwaitingAck(list)).toHaveLength(1);
    list = reduceCommands(list, { type: "ack", ack: okAck(doc) });
    expect(list[0]?.state).toBe("created");
    expect(list[0]?.sentAt).toBeDefined();
  });

  it("回执只生效一次；重复入队、结束后再 send-ok 都不改变状态", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    list = reduceCommands(list, { type: "enqueue", doc });
    expect(list).toHaveLength(1);
    list = reduceCommands(list, { type: "ack", ack: okAck(doc, "ATM-T-0001") });
    const settled = list;
    list = reduceCommands(list, { type: "ack", ack: failAck(doc) });
    list = reduceCommands(list, { type: "send-ok", id: doc.id, at: new Date(T0).toISOString() });
    expect(list).toBe(settled);
    expect(list[0]?.result?.key).toBe("ATM-T-0001");
  });

  it("7 天没有回执的命令本地作废", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    list = reduceCommands(list, { type: "send-ok", id: doc.id, at: new Date(T0).toISOString() });
    expect(reduceCommands(list, { type: "expire", now: T0 + 6 * 86_400_000 })).toBe(list);
    list = reduceCommands(list, { type: "expire", now: T0 + 8 * 86_400_000 });
    expect(list[0]).toMatchObject({ state: "failed", error: { code: "COMMAND_EXPIRED" } });
  });

  it("未结束的命令不能被移除；结束的可以", () => {
    const doc = command();
    let list = reduceCommands([], { type: "enqueue", doc });
    expect(reduceCommands(list, { type: "dismiss", id: doc.id })).toBe(list);
    list = reduceCommands(list, { type: "ack", ack: okAck(doc) });
    list = reduceCommands(list, { type: "ack-cleared", id: doc.id });
    list = reduceCommands(list, { type: "dismiss", id: doc.id });
    expect(reduceCommands(list, { type: "prune", now: T0 })).toHaveLength(0);
  });

  it("重启恢复：保留状态，丢弃坏记录，结束态缺结果时退回等待回执", () => {
    const pending = command(T0, "一");
    const sent = command(T0 + 1, "二");
    const created = command(T0 + 2, "三");
    const broken = command(T0 + 3, "四");
    let list: LocalCommand[] = [];
    for (const doc of [pending, sent, created, broken])
      list = reduceCommands(list, { type: "enqueue", doc });
    list = reduceCommands(list, { type: "send-ok", id: sent.id, at: new Date(T0).toISOString() });
    list = reduceCommands(list, { type: "ack", ack: okAck(created) });
    const persisted = JSON.parse(
      JSON.stringify([
        ...list.map((entry) =>
          entry.doc.id === broken.id ? { ...entry, state: "created", result: undefined } : entry,
        ),
        { doc: { id: "garbage" }, state: "sent" },
        "not-an-object",
        list[0],
      ]),
    );
    const restored = restoreCommands(persisted);
    expect(restored.map((entry) => [entry.doc.body, entry.state])).toEqual([
      [pending.body, "pending"],
      [sent.body, "sent"],
      [created.body, "created"],
      [broken.body, "sent"],
    ]);
    expect(commandsToSend(restored).map((entry) => entry.doc.id)).toEqual([pending.id]);
    expect(commandsAwaitingAck(restored)).toHaveLength(3);
    expect(restoreCommands(null)).toEqual([]);
  });
});
