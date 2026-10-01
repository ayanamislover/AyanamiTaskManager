import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentDispatcherOptions,
  DispatchError,
  dispatchPaths,
  type KillResult,
} from "../src/index.js";
import { cleanupAll, fakeProcesses, fixture, waitFor } from "./support.js";

afterEach(cleanupAll);

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

/** 并发上限 1：DEMO-T-0001 在跑（替身进程），DEMO-T-0002 排队。 */
async function twoTasks(
  overrides: (
    fake: ReturnType<typeof fakeProcesses>,
  ) => Partial<AgentDispatcherOptions> = () => ({}),
) {
  const f = fixture();
  f.addTask("DEMO-T-0001");
  f.addTask("DEMO-T-0002");
  const fake = fakeProcesses();
  const dispatcher = f.dispatcher({ ...fake.options, ...overrides(fake) });
  await dispatcher.updateConfig({ enabled: true, maxConcurrent: 1 });
  const running = await dispatcher.enqueue({
    project: "DEMO",
    key: "DEMO-T-0001",
    origin: "desktop",
  });
  const queued = await dispatcher.enqueue({
    project: "DEMO",
    key: "DEMO-T-0002",
    origin: "desktop",
  });
  await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "running");
  return { f, fake, dispatcher, running, queued };
}

describe("取消：确认进程结束后才算取消", () => {
  it("spawn 后立刻记下 OS 给的创建时间；查不到就不记（身份未知）", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    const fake = fakeProcesses();
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.updateConfig({ enabled: true, maxConcurrent: 2 });
    const known = await dispatcher.enqueue({
      project: "DEMO",
      key: "DEMO-T-0001",
      origin: "desktop",
    });
    const saved = () =>
      JSON.parse(readFileSync(dispatchPaths(f.dataDir).runs, "utf8")).runs as Array<{
        run: string;
        pid?: number;
        processCreatedAt?: string;
      }>;
    await waitFor(() => saved().find((run) => run.run === known.run)?.processCreatedAt);
    const record = saved().find((run) => run.run === known.run)!;
    expect(record.processCreatedAt).toBe(fake.created.get(record.pid!)!.toISOString());
    // 对外视图不带只供本机核验身份用的字段。
    expect(dispatcher.listRuns()[0]).not.toHaveProperty("processCreatedAt");
    dispatcher.close();

    const blind = f.dispatcher({ ...fake.options, processStartTime: async () => null });
    await blind.start();
    const unknown = await blind.enqueue({
      project: "DEMO",
      key: "DEMO-T-0002",
      origin: "desktop",
    });
    await waitFor(() => blind.runForTask("DEMO", "DEMO-T-0002")?.state === "running");
    await waitFor(() => f.warnings.some((warning) => warning.includes("查不到会话进程的创建时间")));
    expect(saved().find((run) => run.run === unknown.run)?.processCreatedAt).toBeUndefined();
  });

  it("结束成功：记为取消、释放名额，排队的下一个才启动", async () => {
    const { fake, dispatcher, running, queued } = await twoTasks();
    expect(fake.children).toHaveLength(1);
    const cancelled = await dispatcher.cancel(running.run);
    expect(cancelled).toMatchObject({ state: "cancelled", error: "用户取消" });
    expect(fake.kills).toEqual([fake.children[0]!.pid]);
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0002")?.state === "running");
    expect(fake.children).toHaveLength(2);
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0002")?.run).toBe(queued.run);
    // 进程随后的 exit 只补记退出码，不改结局。
    await waitFor(
      () => dispatcher.listRuns().find((run) => run.run === running.run)?.exitCode === 1,
    );
    expect(dispatcher.listRuns().find((run) => run.run === running.run)?.state).toBe("cancelled");
  });

  it("结束失败：抛 DISPATCH_CANCEL_FAILED（500、可重试），派单仍在运行、名额不释放；重试成功后才取消", async () => {
    const { fake, dispatcher, running } = await twoTasks();
    fake.control.killResult = { kind: "failed", reason: "taskkill 退出码 1：拒绝访问" };
    const failure = await rejection(dispatcher.cancel(running.run));
    expect(failure.code).toBe("DISPATCH_CANCEL_FAILED");
    expect(failure.httpStatus).toBe(500);
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("拒绝访问");
    expect(failure.message).toContain("派单仍在进行");
    expect(failure.details).toMatchObject({ run: running.run, pid: fake.children[0]!.pid });
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state).toBe("running");
    await new Promise((done) => setTimeout(done, 50));
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0002")?.state).toBe("queued");
    expect(fake.children).toHaveLength(1);

    fake.control.killResult = null;
    expect(await dispatcher.cancel(running.run)).toMatchObject({ state: "cancelled" });
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0002")?.state === "running");
  });

  it("结束命令报错但进程其实已经没了：照样算取消", async () => {
    const { fake, dispatcher, running } = await twoTasks();
    fake.control.killResult = { kind: "failed", reason: "taskkill 退出码 255" };
    fake.alive.clear();
    expect(await dispatcher.cancel(running.run)).toMatchObject({ state: "cancelled" });
  });

  it("进程已不存在（taskkill 找不到，退出码 128）：算取消", async () => {
    const { fake, dispatcher, running } = await twoTasks();
    fake.control.killResult = { kind: "gone" };
    expect(await dispatcher.cancel(running.run)).toMatchObject({ state: "cancelled" });
  });

  it("取消进行中再点取消：等同一次的结果，只结束一次", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const { fake, dispatcher, running } = await twoTasks((fake) => ({
      killProcessTree: async (pid: number): Promise<KillResult> => {
        await gate;
        return fake.options.killProcessTree(pid);
      },
    }));
    const first = dispatcher.cancel(running.run);
    const second = dispatcher.cancel(running.run);
    await new Promise((done) => setTimeout(done, 20));
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state).toBe("running");
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.state).toBe("cancelled");
    expect(fake.kills).toHaveLength(1);
  });

  it("结束途中进程自己退出：exit 不抢结局，仍记为取消", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const { fake, dispatcher, running } = await twoTasks((fake) => ({
      killProcessTree: async (pid: number): Promise<KillResult> => {
        await gate;
        return fake.options.killProcessTree(pid);
      },
    }));
    const pending = dispatcher.cancel(running.run);
    await new Promise((done) => setTimeout(done, 20));
    fake.children[0]!.finish(0);
    release();
    expect(await pending).toMatchObject({ state: "cancelled", exitCode: 0 });
  });
});
