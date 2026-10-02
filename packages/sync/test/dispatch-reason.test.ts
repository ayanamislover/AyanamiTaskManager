import { afterEach, describe, expect, it } from "vitest";
import type { TaskCard } from "@ayanami-task/sync-protocol";
import { dispatchPortFrom, type DispatcherLike } from "../src/index.js";
import { ackError } from "../src/errors.js";
import {
  cleanupFixtures,
  connect,
  fakeDispatch,
  openFixture,
  phoneFor,
  seedProject,
  seedTask,
  waitFor,
} from "./support/fixture.js";

afterEach(cleanupFixtures);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const NOT_LOGGED_IN =
  "Claude Code 未登录或登录已过期：请在电脑终端运行 claude 并完成登录后再交给 Claude";

/** 与 agent-dispatch 的 DispatchError 同形：Error + code + httpStatus。 */
class FakeDispatchError extends Error {
  readonly httpStatus = 409;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

describe("派单失败原因", () => {
  it("失败的派单把原因带到任务卡片上：截到 200、不劈开代理对；其它状态不带", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA"))!;
      const task = await seedTask(fixture.service, "ALPHA", objective, { title: "交给 Claude" });
      const dispatch = fakeDispatch();
      const connector = fixture.connector({ dispatch: dispatch.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const card = async (): Promise<TaskCard | undefined> => {
        const head = await phone.store.readHead();
        const doc = head ? await phone.store.readProject(head.projects[0]!.h) : null;
        return doc?.tasks.find((entry) => entry.key === task.key);
      };

      // 第 199 个 UTF-16 单元正好落在表情的高位代理上。
      const long = `${NOT_LOGGED_IN}${"好".repeat(198 - NOT_LOGGED_IN.length)}😀${"尾".repeat(80)}`;
      dispatch.settle("ALPHA", task.key, {
        run: "run-failed",
        state: "failed",
        at: new Date().toISOString(),
        error: `  ${long}\n`,
      });
      await waitFor(async () => (await card())?.dispatch?.state === "failed", "失败状态上卡片");
      const failed = (await card())!.dispatch!;
      expect(failed.run).toBe("run-failed");
      expect(failed.error?.startsWith("Claude Code 未登录或登录已过期")).toBe(true);
      expect(failed.error?.endsWith("…")).toBe(true);
      expect(failed.error!.length).toBeLessThanOrEqual(200);
      expect([...failed.error!].length).toBeLessThanOrEqual(200);
      expect(LONE_SURROGATE.test(failed.error!)).toBe(false);
      // 劈开的代理对经 UTF-8 加密后会变成 U+FFFD，同样不许出现。
      expect(failed.error).not.toContain("�");

      // 短原因原样带上。
      dispatch.settle("ALPHA", task.key, {
        run: "run-short",
        state: "failed",
        at: new Date().toISOString(),
        error: NOT_LOGGED_IN,
      });
      await waitFor(async () => (await card())?.dispatch?.run === "run-short", "短原因上卡片");
      expect((await card())!.dispatch!.error).toBe(NOT_LOGGED_IN);

      // 非失败状态即使带着 error 也不发。
      dispatch.settle("ALPHA", task.key, {
        run: "run-running",
        state: "running",
        at: new Date().toISOString(),
        error: "不该出现",
      });
      await waitFor(async () => (await card())?.dispatch?.state === "running", "运行中上卡片");
      expect((await card())!.dispatch).not.toHaveProperty("error");
    } finally {
      await fixture.close();
    }
  });

  it("dispatchPortFrom 把 AgentDispatcher 记下的 error 交给快照", async () => {
    const at = "2026-09-30T20:00:00.000Z";
    const runs = [
      {
        run: "r1",
        project: "ALPHA",
        state: "failed" as const,
        createdAt: at,
        endedAt: at,
        error: NOT_LOGGED_IN,
      },
      { run: "r2", project: "ALPHA", state: "succeeded" as const, createdAt: at, endedAt: at },
    ];
    const dispatcher: DispatcherLike = {
      config: { enabled: true, permissionMode: "auto" },
      listRuns: () => runs,
      runForTask: (_project, key) => (key === "ALPHA-T-0001" ? runs[0]! : runs[1]!),
      enqueue: async () => runs[0]!,
      onChange: () => () => undefined,
    };
    const port = dispatchPortFrom(dispatcher);
    expect(port.runForTask("ALPHA", "ALPHA-T-0001")).toEqual({
      run: "r1",
      state: "failed",
      at,
      error: NOT_LOGGED_IN,
    });
    expect(port.runForTask("ALPHA", "ALPHA-T-0002")).toEqual({ run: "r2", state: "succeeded", at });
  });

  it("DISPATCH_CLAUDE_NOT_LOGGED_IN 原样透传到回执：建任务时带 dispatchError，单独派单时整条失败", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA"))!;
      const existing = await seedTask(fixture.service, "ALPHA", objective, { title: "已有任务" });
      const dispatch = fakeDispatch();
      dispatch.port.enqueue = async () => {
        throw new FakeDispatchError("DISPATCH_CLAUDE_NOT_LOGGED_IN", NOT_LOGGED_IN);
      };
      const connector = fixture.connector({ dispatch: dispatch.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const created = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "想交给 Claude", dispatch: true },
      });
      expect(await phone.awaitAck(created.id)).toMatchObject({
        ok: true,
        result: {
          dispatchError: { code: "DISPATCH_CLAUDE_NOT_LOGGED_IN", message: NOT_LOGGED_IN },
        },
      });
      const handOff = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key: existing.key },
      });
      expect(await phone.awaitAck(handOff.id)).toMatchObject({
        ok: false,
        error: { code: "DISPATCH_CLAUDE_NOT_LOGGED_IN", message: NOT_LOGGED_IN },
      });
    } finally {
      await fixture.close();
    }
  });

  it("回执里的派单错误码照抄、说明截到 500", () => {
    const failure = ackError(
      new FakeDispatchError("DISPATCH_CLAUDE_NOT_LOGGED_IN", "长".repeat(800)),
    );
    expect(failure.code).toBe("DISPATCH_CLAUDE_NOT_LOGGED_IN");
    expect(failure.message.length).toBeLessThanOrEqual(500);
    expect(ackError(new Error("没有码")).code).toBe("COMMAND_FAILED");
  });
});
