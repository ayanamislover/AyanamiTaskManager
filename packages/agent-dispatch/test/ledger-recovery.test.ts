import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDispatcher,
  DISPATCH_HISTORY_LIMIT,
  DISPATCH_REQUEST_RETENTION_MS,
  DispatchError,
  dispatchPaths,
  REQUEST_STATE_LOST_MESSAGE,
} from "../src/index.js";
import { cleanupAll, fakeProcesses, type Fixture, fixture, waitFor } from "./support.js";

// 读盘失败（EACCES）只能靠替换 readFileSync 造：Windows 上没法可靠地 chmod 出「读不出来」。
// 只对名为 requests.json 的文件、只在开关打开时抛错，其余调用原样转给真的 fs。
const denied = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (denied.on && String(path).endsWith("requests.json"))
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), {
          code: "EACCES",
        });
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

afterEach(async () => {
  denied.on = false;
  await cleanupAll();
});

const T0 = Date.parse("2026-09-30T00:00:00.000Z");
/** 手机命令形的 requestId，发送时间（毫秒）写在 ID 里。 */
const commandId = (sentAt: number, tag: string) =>
  `m-0123456789ab.${sentAt.toString(36).padStart(13, "0")}${tag.padStart(8, "0")}`;

async function rejection(promise: Promise<unknown>): Promise<DispatchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DispatchError);
  return error as DispatchError;
}

const mobile = (requestId: string, key = "DEMO-T-0001") => ({
  project: "DEMO",
  key,
  origin: "mobile" as const,
  requestId,
});

type Clock = { at: number; now: () => Date };
function clock(start = T0): Clock {
  const self: Clock = { at: start, now: () => new Date(self.at) };
  return self;
}

/** 手机派一次、会话失败结束；返回那次派单。任务仍是 READY——没有账本就能被同一条命令再派一次。 */
async function dispatchedOnce(f: Fixture, fake: ReturnType<typeof fakeProcesses>, c: Clock) {
  f.addTask("DEMO-T-0001");
  const first = f.dispatcher({ ...fake.options, now: c.now });
  await first.updateConfig({ enabled: true });
  const id = commandId(c.at - 1_000, "1");
  const run = await first.enqueue(mobile(id));
  await waitFor(() => fake.children.length === 1);
  fake.children[0]!.finish(1);
  await waitFor(() => first.runForTask("DEMO", "DEMO-T-0001")?.state === "failed");
  first.close();
  return { id, run };
}

/** 上一次运行时历史已被裁剪：runs.json 里只剩更新的 50 次桌面派单，最早那次只有账本知道。 */
function pushOutOfHistory(f: Fixture) {
  const paths = dispatchPaths(f.dataDir);
  const saved = JSON.parse(readFileSync(paths.runs, "utf8"));
  const template = { ...saved.runs[0] };
  delete template.requestId;
  saved.runs = Array.from({ length: DISPATCH_HISTORY_LIMIT }, (_, index) => ({
    ...template,
    run: `zz${String(index).padStart(3, "0")}-00000000`,
    key: "DEMO-T-0099",
    origin: "desktop",
    createdAt: new Date(T0 + 60_000 + index).toISOString(),
  }));
  writeFileSync(paths.runs, JSON.stringify(saved));
}

async function restart(f: Fixture, fake: ReturnType<typeof fakeProcesses>, c: Clock) {
  const dispatcher: AgentDispatcher = f.dispatcher({ ...fake.options, now: c.now });
  await dispatcher.start();
  return dispatcher;
}

describe("请求账本坏了、丢了、读不出来：不能让同一条命令再派一次（peer R2-02）", () => {
  it("JSON 损坏，派单还在历史里：用历史里存的 requestId 补回条目，精确回放，spawn 仍为 1", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id, run } = await dispatchedOnce(f, fake, c);
    writeFileSync(dispatchPaths(f.dataDir).requests, "{broken");
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    expect(await dispatcher.enqueue(mobile(id))).toMatchObject({ run: run.run, state: "failed" });
    expect(fake.children).toHaveLength(1);
    expect((await dispatcher.status()).requestLedger).toMatchObject({
      lostBefore: new Date(c.at).toISOString(),
      lostUntil: new Date(c.at + DISPATCH_REQUEST_RETENTION_MS).toISOString(),
      unavailable: false,
    });
  });

  it("JSON 损坏，派单已被挤出历史：无法确认，拒绝（409，不记账）；水位线之后发出的新命令照常派", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id } = await dispatchedOnce(f, fake, c);
    pushOutOfHistory(f);
    writeFileSync(dispatchPaths(f.dataDir).requests, "{broken");
    c.at += 60_000;
    const lostAt = c.at;
    const dispatcher = await restart(f, fake, c);
    const lost = await rejection(dispatcher.enqueue(mobile(id)));
    expect(lost.code).toBe("DISPATCH_REQUEST_STATE_LOST");
    expect(lost.httpStatus).toBe(409);
    expect(lost.message).toBe(REQUEST_STATE_LOST_MESSAGE);
    // 拒绝没有固化进账本：账本里只有水位线，没有这个 ID。
    const file = JSON.parse(readFileSync(dispatchPaths(f.dataDir).requests, "utf8"));
    expect(file.lostBefore).toBe(new Date(lostAt).toISOString());
    expect(file.requests.some((entry: { id: string }) => entry.id === id)).toBe(false);
    // 取不出发送时间的 requestId 在有水位线期间同样拒绝。
    expect((await rejection(dispatcher.enqueue(mobile("custom-request-1")))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    // 恰好在水位线那一刻发出的也拒绝；之后发出的照常派。
    expect((await rejection(dispatcher.enqueue(mobile(commandId(lostAt, "2"))))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    c.at += 5_000;
    const fresh = await dispatcher.enqueue(mobile(commandId(lostAt + 1, "3")));
    expect(fresh.state).toBe("queued");
    await waitFor(() => fake.children.length === 2);
    expect(fake.children).toHaveLength(2);
  });

  it("单条记录不合法：其余条目照常精确回放，坏条目对应的命令按丢失拒绝", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id, run } = await dispatchedOnce(f, fake, c);
    pushOutOfHistory(f);
    const paths = dispatchPaths(f.dataDir);
    const file = JSON.parse(readFileSync(paths.requests, "utf8"));
    const good = { ...file.requests[0], id: commandId(T0 - 5_000, "9") };
    file.requests = [good, { ...file.requests[0], at: 42 }];
    writeFileSync(paths.requests, JSON.stringify(file));
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    expect(await dispatcher.enqueue(mobile(good.id))).toMatchObject({ run: run.run });
    expect((await rejection(dispatcher.enqueue(mobile(id)))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    expect(fake.children).toHaveLength(1);
    expect(f.warnings).toContain("派单请求账本数据丢失，设下水位线");
  });

  it("账本文件被删、历史里还有带 requestId 的派单：判为丢失并从历史补回，旧命令精确回放", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id, run } = await dispatchedOnce(f, fake, c);
    rmSync(dispatchPaths(f.dataDir).requests);
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    expect(await dispatcher.enqueue(mobile(id))).toMatchObject({ run: run.run, state: "failed" });
    expect(fake.children).toHaveLength(1);
    expect((await dispatcher.status()).requestLedger.lostBefore).toBe(new Date(c.at).toISOString());
    const rebuilt = JSON.parse(readFileSync(dispatchPaths(f.dataDir).requests, "utf8"));
    expect(rebuilt.requests).toEqual([expect.objectContaining({ id, run: expect.anything() })]);
  });

  it("从没用过手机派单（没有账本、历史里也没有 requestId）：全新，不设水位线", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const dispatcher = await restart(f, fake, clock());
    expect((await dispatcher.status()).requestLedger).toEqual({
      lostBefore: null,
      lostUntil: null,
      unavailable: false,
    });
    await dispatcher.updateConfig({ enabled: true });
    await dispatcher.enqueue(mobile(commandId(T0 - 86_400_000, "1")));
    await waitFor(() => fake.children.length === 1);
  });

  it("读盘失败（EACCES）：手机派单 503 可重试，不改名不重建；读得出来以后精确回放，spawn 仍为 1", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id, run } = await dispatchedOnce(f, fake, c);
    const path = dispatchPaths(f.dataDir).requests;
    const before = readFileSync(path, "utf8");
    denied.on = true;
    const dispatcher = await restart(f, fake, c);
    const refused = await rejection(dispatcher.enqueue(mobile(id)));
    expect(refused.code).toBe("DISPATCH_LEDGER_UNAVAILABLE");
    expect(refused.httpStatus).toBe(503);
    expect(refused.retryable).toBe(true);
    // 新命令也一样拒绝（不知道账本里有什么，就不能判断任何命令）。
    expect((await rejection(dispatcher.enqueue(mobile(commandId(c.at + 1, "5"))))).code).toBe(
      "DISPATCH_LEDGER_UNAVAILABLE",
    );
    expect((await dispatcher.status()).requestLedger.unavailable).toBe(true);
    expect(fake.children).toHaveLength(1);
    // 桌面派单不需要账本，照常可派；其间写历史也不会顺手覆盖读不出来的账本。
    f.addTask("DEMO-T-0002");
    await dispatcher.enqueue({ project: "DEMO", key: "DEMO-T-0002", origin: "desktop" });
    await waitFor(() => fake.children.length === 2);
    denied.on = false;
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(await dispatcher.enqueue(mobile(id))).toMatchObject({ run: run.run, state: "failed" });
    expect(fake.children).toHaveLength(2);
    expect((await dispatcher.status()).requestLedger).toMatchObject({
      unavailable: false,
      lostBefore: null,
    });
  });

  it("水位线在保留期后自动清除（持久化的也一并清掉）", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    await dispatchedOnce(f, fake, c);
    pushOutOfHistory(f);
    writeFileSync(dispatchPaths(f.dataDir).requests, "{broken");
    c.at += 60_000;
    const lostAt = c.at;
    const dispatcher = await restart(f, fake, c);
    expect((await dispatcher.status()).requestLedger.lostBefore).not.toBeNull();
    c.at = lostAt + DISPATCH_REQUEST_RETENTION_MS + 1;
    expect((await dispatcher.status()).requestLedger.lostBefore).toBeNull();
    const file = JSON.parse(readFileSync(dispatchPaths(f.dataDir).requests, "utf8"));
    expect(file).not.toHaveProperty("lostBefore");
    // 重启后也不会再冒出来。
    const again = await restart(f, fake, c);
    expect((await again.status()).requestLedger.lostBefore).toBeNull();
  });

  it("历史文件也坏了、账本又不在：同样按丢失处理", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id } = await dispatchedOnce(f, fake, c);
    const paths = dispatchPaths(f.dataDir);
    rmSync(paths.requests);
    writeFileSync(paths.runs, "{ 坏");
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    expect((await rejection(dispatcher.enqueue(mobile(id)))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    expect(fake.children).toHaveLength(1);
  });
});

describe("账本用过的标记不随历史裁剪消失（peer R3-01）", () => {
  const runsFile = (f: Fixture) => JSON.parse(readFileSync(dispatchPaths(f.dataDir).runs, "utf8"));

  it("手机派单被 50 次桌面派单挤出历史后单删账本：标记还在 → 判丢失，旧命令拒绝，spawn 仍为 1", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id } = await dispatchedOnce(f, fake, c);
    expect(runsFile(f).requestsSince).toBe(new Date(T0).toISOString());
    pushOutOfHistory(f);
    rmSync(dispatchPaths(f.dataDir).requests);
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    const error = await rejection(dispatcher.enqueue(mobile(id)));
    expect(error.code).toBe("DISPATCH_REQUEST_STATE_LOST");
    expect(error.message).toBe(REQUEST_STATE_LOST_MESSAGE);
    expect(fake.children).toHaveLength(1);
    expect((await dispatcher.status()).requestLedger.lostBefore).toBe(new Date(c.at).toISOString());
    // 标记跟着之后的历史保存一直留着。
    expect(runsFile(f).requestsSince).toBe(new Date(T0).toISOString());
  });

  it("账本里只有被拒的记录、历史里没有手机派单：单删账本仍判丢失，开了派单也不会补起会话", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    const fake = fakeProcesses();
    const c = clock();
    const first = f.dispatcher({ ...fake.options, now: c.now });
    const id = commandId(c.at - 1_000, "1");
    expect((await rejection(first.enqueue(mobile(id)))).code).toBe("DISPATCH_DISABLED");
    first.close();
    expect(runsFile(f)).toMatchObject({ requestsSince: new Date(T0).toISOString(), runs: [] });
    rmSync(dispatchPaths(f.dataDir).requests);
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    await dispatcher.updateConfig({ enabled: true });
    expect((await rejection(dispatcher.enqueue(mobile(id)))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    expect(fake.children).toHaveLength(0);
  });

  it("只用过桌面派单（没有标记、没有手机派单）：删掉账本仍是全新，不设水位线", async () => {
    const f = fixture();
    f.addTask("DEMO-T-0001");
    f.addTask("DEMO-T-0002");
    const fake = fakeProcesses();
    const c = clock();
    const first = f.dispatcher({ ...fake.options, now: c.now });
    await first.updateConfig({ enabled: true });
    await first.enqueue({ project: "DEMO", key: "DEMO-T-0002", origin: "desktop" });
    await waitFor(() => fake.children.length === 1);
    fake.children[0]!.finish(0);
    await waitFor(() => first.runForTask("DEMO", "DEMO-T-0002")?.state !== "running");
    first.close();
    expect(runsFile(f).requestsSince).toBeUndefined();
    rmSync(dispatchPaths(f.dataDir).requests, { force: true });
    const dispatcher = await restart(f, fake, c);
    expect((await dispatcher.status()).requestLedger.lostBefore).toBeNull();
    await dispatcher.enqueue(mobile(commandId(c.at - 1_000, "2")));
    await waitFor(() => fake.children.length === 2);
  });

  it("旧版本留下的账本（历史里还没有标记）：启动时补写标记，之后单删账本也认得出", async () => {
    const f = fixture();
    const fake = fakeProcesses();
    const c = clock();
    const { id } = await dispatchedOnce(f, fake, c);
    const paths = dispatchPaths(f.dataDir);
    const legacy = runsFile(f);
    delete legacy.requestsSince;
    writeFileSync(paths.runs, JSON.stringify(legacy));
    c.at += 60_000;
    (await restart(f, fake, c)).close();
    expect(runsFile(f).requestsSince).toBe(new Date(c.at).toISOString());
    pushOutOfHistory(f);
    rmSync(paths.requests);
    c.at += 60_000;
    const dispatcher = await restart(f, fake, c);
    expect((await rejection(dispatcher.enqueue(mobile(id)))).code).toBe(
      "DISPATCH_REQUEST_STATE_LOST",
    );
    expect(fake.children).toHaveLength(1);
  });
});
