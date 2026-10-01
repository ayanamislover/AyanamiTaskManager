import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPATCH_HISTORY_LIMIT,
  DISPATCH_REQUEST_LIMIT,
  DISPATCH_REQUEST_RETENTION_MS,
  DispatchError,
  dispatchPaths,
} from "../src/index.js";
import { cleanupAll, fakeProcesses, type Fixture, fixture, waitFor } from "./support.js";

afterEach(cleanupAll);

/** 与手机命令 ID 同形（packages/sync-protocol 的 COMMAND_ID_PATTERN）。 */
const COMMAND = "m-0123456789ab.mg7x3k2a0000012345678";
const OTHER = "m-0123456789ab.mg7x3k2a0001abcdef0123";

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

function ledgerFile(f: Fixture): { requests: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(dispatchPaths(f.dataDir).requests, "utf8"));
}

const mobile = (requestId: string, key = "DEMO-T-0001") => ({
  project: "DEMO",
  key,
  origin: "mobile" as const,
  requestedBy: "测试手机",
  requestId,
});

describe("派单请求账本：同一个 requestId 只起一次会话", () => {
  it("同一请求两次（含并发）只 spawn 一次，都拿到同一次派单；不带 requestId 的桌面派单不受影响", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.updateConfig({ enabled: true });
    const [first, concurrent] = await Promise.all([
      dispatcher.enqueue(mobile(COMMAND)),
      dispatcher.enqueue(mobile(COMMAND)),
    ]);
    expect(concurrent.run).toBe(first.run);
    await waitFor(() => fake.children.length === 1);
    const again = await dispatcher.enqueue(mobile(COMMAND));
    expect(again).toMatchObject({ run: first.run, state: "running" });
    expect(fake.children).toHaveLength(1);
    expect(ledgerFile(f).requests).toHaveLength(1);
  });

  it("派单结束（失败）、任务仍可派：同一请求再来返回那次的失败，不再起会话；新请求照常派", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const dispatcher = f.dispatcher(fake.options);
    await dispatcher.updateConfig({ enabled: true });
    const first = await dispatcher.enqueue(mobile(COMMAND));
    await waitFor(() => fake.children.length === 1);
    fake.children[0]!.finish(1);
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "failed");

    const replay = await dispatcher.enqueue(mobile(COMMAND));
    expect(replay).toMatchObject({ run: first.run, state: "failed" });
    await new Promise((done) => setTimeout(done, 50));
    expect(fake.children).toHaveLength(1);

    const fresh = await dispatcher.enqueue(mobile(OTHER));
    expect(fresh.run).not.toBe(first.run);
    await waitFor(() => fake.children.length === 2);
  });

  it("宿主重启后（新实例读同一数据目录）仍幂等；派单被历史裁剪后用账本快照回答", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const before = f.dispatcher(fake.options);
    await before.updateConfig({ enabled: true });
    const first = await before.enqueue(mobile(COMMAND));
    await waitFor(() => fake.children.length === 1);
    fake.children[0]!.finish(3);
    await waitFor(() => before.runForTask("DEMO", "DEMO-T-0001")?.state === "failed");
    before.close();

    const restarted = f.dispatcher(fake.options);
    await restarted.start();
    expect(await restarted.enqueue(mobile(COMMAND))).toMatchObject({
      run: first.run,
      state: "failed",
      exitCode: 3,
    });

    // 再塞进一批更新的已结束派单，把这次挤出历史。
    const paths = dispatchPaths(f.dataDir);
    const saved = JSON.parse(readFileSync(paths.runs, "utf8"));
    for (let index = 0; index < DISPATCH_HISTORY_LIMIT + 5; index += 1)
      saved.runs.push({
        ...saved.runs[0],
        run: `zz${String(index).padStart(3, "0")}-00000000`,
        key: "DEMO-T-0099",
        createdAt: new Date(Date.now() + index).toISOString(),
      });
    writeFileSync(paths.runs, JSON.stringify(saved));
    const trimmed = f.dispatcher(fake.options);
    await trimmed.start();
    expect(trimmed.listRuns().some((run) => run.run === first.run)).toBe(false);
    expect(await trimmed.enqueue(mobile(COMMAND))).toMatchObject({
      run: first.run,
      key: "DEMO-T-0001",
      state: "failed",
      exitCode: 3,
    });
    expect(fake.children).toHaveLength(1);
  });

  it("账本在起进程之前落盘；写不下去就不派", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    const fake = fakeProcesses();
    const seenAtSpawn: string[] = [];
    const dispatcher = f.dispatcher({
      ...fake.options,
      spawnImpl: (command, args, options) => {
        seenAtSpawn.push(readFileSync(dispatchPaths(f.dataDir).requests, "utf8"));
        return fake.options.spawnImpl(command, args, options);
      },
    });
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue(mobile(COMMAND));
    await waitFor(() => seenAtSpawn.length === 1);
    expect(seenAtSpawn[0]).toContain(COMMAND);

    // 账本路径被一个目录占住：原子改名必然失败。
    const ledger = dispatchPaths(f.dataDir).requests;
    rmSync(ledger);
    mkdirSync(ledger);
    const failure = await dispatcher
      .enqueue(mobile(OTHER, "DEMO-T-0002"))
      .catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("没有启动 Claude");
    expect(dispatcher.runForTask("DEMO", "DEMO-T-0002")).toBeNull();
    await new Promise((done) => setTimeout(done, 50));
    expect(seenAtSpawn).toHaveLength(1);
  });

  it("被拒的请求也记下：之后开了派单，同一请求仍然被拒，不补起会话", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const dispatcher = f.dispatcher(fake.options);
    expect((await rejection(dispatcher.enqueue(mobile(COMMAND)))).code).toBe("DISPATCH_DISABLED");
    await dispatcher.updateConfig({ enabled: true });
    const replay = await rejection(dispatcher.enqueue(mobile(COMMAND)));
    expect(replay.code).toBe("DISPATCH_DISABLED");
    expect(replay.details).toMatchObject({ requestId: COMMAND });
    expect(fake.children).toHaveLength(0);
    await dispatcher.enqueue(mobile(OTHER));
    await waitFor(() => fake.children.length === 1);
  });

  it(`条目保留 ${DISPATCH_REQUEST_RETENTION_MS / 86_400_000} 天，超期裁剪；条数到上限时拒收新请求而不是挤掉旧的`, async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    let at = Date.parse("2026-09-30T00:00:00.000Z");
    const now = () => new Date(at);
    const dispatcher = f.dispatcher({ ...fake.options, now });
    await dispatcher.updateConfig({ enabled: true });
    const first = await dispatcher.enqueue(mobile(COMMAND));
    await waitFor(() => fake.children.length === 1);
    fake.children[0]!.finish(1);
    await waitFor(() => dispatcher.runForTask("DEMO", "DEMO-T-0001")?.state === "failed");

    at += DISPATCH_REQUEST_RETENTION_MS - 1;
    expect((await dispatcher.enqueue(mobile(COMMAND))).run).toBe(first.run);
    expect(fake.children).toHaveLength(1);
    // 超过保留期：同步侧早已按 COMMAND_EXPIRED 拒掉这种命令，账本不再记着它。
    at += 2;
    const later = await dispatcher.enqueue(mobile(COMMAND));
    expect(later.run).not.toBe(first.run);
    await waitFor(() => fake.children.length === 2);
    expect(ledgerFile(f).requests.filter((entry) => entry.id === COMMAND)).toHaveLength(1);

    // 上限：直接写满账本（都是没过期的条目），新请求被拒，已记的仍能回放。
    const paths = dispatchPaths(f.dataDir);
    const filler = Array.from({ length: DISPATCH_REQUEST_LIMIT - 1 }, (_, index) => ({
      id: `fill-${index}`,
      at: new Date(at).toISOString(),
      rejected: { code: "DISPATCH_DISABLED", message: "派单未开启" },
    }));
    writeFileSync(
      paths.requests,
      JSON.stringify({ v: 1, requests: [...ledgerFile(f).requests, ...filler] }),
    );
    const full = f.dispatcher({ ...fake.options, now });
    await full.start();
    const refused = await rejection(full.enqueue(mobile(OTHER)));
    expect(refused.code).toBe("DISPATCH_TOO_MANY_REQUESTS");
    expect(refused.httpStatus).toBe(429);
    expect((await full.enqueue(mobile(COMMAND))).run).toBe(later.run);
    expect(fake.children).toHaveLength(2);
  });

  it("坏的账本改名留存、从空账本开始；格式不对的 requestId 被拒", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const paths = dispatchPaths(f.dataDir);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.requests, "{ 坏");
    const dispatcher = f.dispatcher(fakeProcesses().options);
    await dispatcher.updateConfig({ enabled: true });
    expect(readFileSync(paths.requests.replace(/\.json$/u, ".corrupt.json"), "utf8")).toBe("{ 坏");
    expect(f.warnings.some((warning) => warning.includes("派单请求账本"))).toBe(true);
    for (const bad of ["", "有中文", "a/b", "x".repeat(200)])
      expect((await rejection(dispatcher.enqueue(mobile(bad)))).code).toBe(
        "DISPATCH_INVALID_ARGUMENT",
      );
  });
});
