import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMAND_MAX_AGE_MS,
  commandKey,
  newCommandId,
  type AckDoc,
  type FetchLike,
} from "@ayanami-task/sync-protocol";
// 用真的派单器（只把进程相关的系统调用换成替身）：要验证的正是它的请求账本。
// sync 包不依赖 agent-dispatch，测试按相对路径引用其源码（与 client 测试引用 application 同一做法）。
import {
  AgentDispatcher,
  type AgentDispatcherOptions,
  type DispatchHost,
  DISPATCH_REQUEST_MAX_AGE_MS,
  DISPATCH_REQUEST_RETENTION_MS,
  type KillResult,
} from "../../agent-dispatch/src/index.js";
import { COMMAND_CLOCK_TOLERANCE_MS, COMMAND_FUTURE_TOLERANCE_MS } from "../src/commands.js";
import {
  PROCESSED_COMMAND_LIMIT,
  PROCESSED_RETENTION_MS,
  defaultSyncConfig,
  loadSyncConfig,
  rememberProcessed,
  saveSyncConfig,
} from "../src/config.js";
import { dispatchPortFrom, taskServiceDispatchHost, type DispatchPort } from "../src/index.js";
import {
  RELAY_URL,
  cleanupFixtures,
  connect,
  openFixture,
  phoneFor,
  seedTask,
  waitFor,
  type Fixture,
} from "./support/fixture.js";

const dispatchers: AgentDispatcher[] = [];
afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.close();
  await cleanupFixtures();
});

const DAY = 24 * 60 * 60 * 1000;
const FAKE_CLAUDE = resolve(process.cwd(), "packages/agent-dispatch/test/fixtures/fake-claude.mjs");

type FakeChild = ChildProcess & { finish(code: number): void };

/**
 * 派单器 + 进程替身：spawn 出来的是不起真进程的 {@link FakeChild}；结束进程树只记下调用。
 * `auth status` 由 agent-dispatch 的假 claude 回答（已登录），不会碰真 claude。
 */
async function realDispatcher(fixture: Fixture, options: Partial<AgentDispatcherOptions> = {}) {
  const children: FakeChild[] = [];
  let nextPid = 4_200_000;
  const dispatcher = new AgentDispatcher({
    dataDir: fixture.dataDir,
    host: taskServiceDispatchHost(fixture.service),
    resolveClaude: () => FAKE_CLAUDE,
    pollIntervalMs: 60_000,
    spawnImpl: () => {
      const child = new EventEmitter() as FakeChild;
      Object.assign(child, {
        pid: (nextPid += 4),
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        unref() {},
        finish(code: number) {
          Object.assign(child, { exitCode: code });
          child.emit("exit", code, null);
        },
      });
      children.push(child);
      return child;
    },
    processIdentity: async (pid) => `test:${pid}`,
    isPidAlive: (pid) => children.some((child) => child.pid === pid && child.exitCode === null),
    killProcessTree: async (): Promise<KillResult> => ({
      kind: "failed",
      reason: "测试里不结束进程",
    }),
    ...options,
  });
  dispatchers.push(dispatcher);
  await dispatcher.start();
  await dispatcher.updateConfig({ enabled: true });
  const port = dispatchPortFrom(dispatcher);
  const enqueued: Array<Parameters<DispatchPort["enqueue"]>[0]> = [];
  const counted: DispatchPort = {
    ...port,
    async enqueue(input) {
      enqueued.push(input);
      return port.enqueue(input);
    },
  };
  return { dispatcher, children, enqueued, port: counted };
}

/** 有工作目录的项目（派单要求项目绑定了存在的目录）+ 一个 READY 任务。 */
async function seedDispatchable(fixture: Fixture) {
  const source = join(fixture.dataDir, "alpha-src");
  mkdirSync(source, { recursive: true });
  await fixture.service.createProject({ name: "项目 ALPHA", sourcePath: source, code: "ALPHA" });
  const objective = await fixture.service.createObjectiveAsUser("ALPHA", "seed-objective", {
    title: "ALPHA 目标",
    description: "",
    definitionOfDone: [],
  });
  return seedTask(fixture.service, "ALPHA", String(objective.id), { title: "交给 Claude 的任务" });
}

/** 中继上一条命令的原始密文（不经任何重新加密）。 */
function ciphertext(fixture: Fixture, key: string): unknown {
  const doc = fixture.relay.docs.get(key);
  expect(doc).toBeDefined();
  return structuredClone(doc!.data);
}

/** 不可信中继把旧密文原样放回去。 */
async function replayCiphertext(fixture: Fixture, key: string, data: unknown) {
  const response = await fixture.relay.fetch(
    `${RELAY_URL}/v1/apps/${fixture.relay.appId}/documents/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${fixture.relay.token}` },
      body: JSON.stringify({ expected_revision: 0, data }),
    },
  );
  expect(response.status).toBe(201);
}

/** 停机期间往已处理集合里塞 `count` 条别的命令（都是刚发的，没过期）。 */
function fillProcessed(fixture: Fixture, count: number) {
  const now = new Date();
  let config = loadSyncConfig(fixture.dataDir);
  for (let index = 0; index < count; index += 1)
    config = rememberProcessed(config, newCommandId("m-00000000beef", now.getTime() + index), now);
  saveSyncConfig(fixture.dataDir, config);
  return config;
}

describe("派单命令重放（peer R1-02）", () => {
  it("派单失败后再处理 500 条命令，中继原样放回旧密文：已处理集合按时间保留仍挡得住，enqueue 只发生 1 次", async () => {
    const fixture = await openFixture();
    try {
      const task = await seedDispatchable(fixture);
      const dispatch = await realDispatcher(fixture);
      const connector = fixture.connector({ dispatch: dispatch.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key: task.key },
      });
      const key = commandKey(pairing.spaceId, sent.id);
      const sealed = ciphertext(fixture, key);
      const ack = await phone.awaitAck(sent.id);
      expect(ack).toMatchObject({ ok: true, result: { dispatch: { state: "queued" } } });
      await waitFor(() => dispatch.children.length === 1, "会话已起");
      dispatch.children[0]!.finish(1);
      await waitFor(
        () => dispatch.dispatcher.runForTask("ALPHA", task.key)?.state === "failed",
        "派单失败",
      );

      await connector.stop();
      // 旧实现只留最近 500 条：这一步就会把原命令 ID 挤掉。
      const filled = fillProcessed(fixture, 500);
      expect(filled.processed).toContain(sent.id);
      await replayCiphertext(fixture, key, sealed);
      const mark = fixture.relay.requests.length;
      const restarted = fixture.connector({ dispatch: dispatch.port });
      await restarted.start();
      await waitFor(() => !fixture.relay.docs.has(key), "重放的命令被删掉");

      expect(dispatch.enqueued).toHaveLength(1);
      expect(dispatch.children).toHaveLength(1);
      expect(dispatch.dispatcher.listRuns()).toHaveLength(1);
      expect(fixture.relay.putsSince(mark).filter((put) => put.includes("/ack/"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("已处理集合被挤爆（超过硬上限）后重放：派单账本兜底，拿回那次失败的派单，不再起会话", async () => {
    const fixture = await openFixture();
    try {
      const task = await seedDispatchable(fixture);
      const dispatch = await realDispatcher(fixture);
      const connector = fixture.connector({ dispatch: dispatch.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key: task.key },
      });
      const key = commandKey(pairing.spaceId, sent.id);
      const sealed = ciphertext(fixture, key);
      const first = await phone.awaitAck(sent.id);
      const run = first.ok ? first.result.dispatch?.run : undefined;
      expect(run).toBeDefined();
      await waitFor(() => dispatch.children.length === 1, "会话已起");
      dispatch.children[0]!.finish(1);
      await waitFor(
        () => dispatch.dispatcher.runForTask("ALPHA", task.key)?.state === "failed",
        "派单失败",
      );

      await connector.stop();
      const filled = fillProcessed(fixture, PROCESSED_COMMAND_LIMIT);
      expect(filled.processed).not.toContain(sent.id);
      await phone.store.deleteAck(sent.id);
      await replayCiphertext(fixture, key, sealed);
      const restarted = fixture.connector({ dispatch: dispatch.port });
      await restarted.start();
      const replayed = await phone.awaitAck(sent.id);

      // 命令确实被再处理了一遍（enqueue 第二次、同一个 requestId），但派单层只回放那次的结局。
      expect(dispatch.enqueued.map((input) => input.requestId)).toEqual([sent.id, sent.id]);
      expect(replayed).toMatchObject({ ok: true, result: { dispatch: { run, state: "failed" } } });
      expect(dispatch.children).toHaveLength(1);
      expect(dispatch.dispatcher.listRuns()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("回执写失败后重做：建任务靠 op_id、派单靠账本，各只发生一次，回执带同一次派单", async () => {
    const fixture = await openFixture();
    try {
      await seedDispatchable(fixture);
      const dispatch = await realDispatcher(fixture);
      let blockAcks = true;
      let blockedAckPuts = 0;
      const fetchImpl: FetchLike = async (url, init) => {
        if (blockAcks && init.method === "PUT" && decodeURIComponent(url).includes("/ack/")) {
          blockedAckPuts += 1;
          throw new TypeError("fetch failed");
        }
        return fixture.relay.fetch(url, init);
      };
      const connector = fixture.connector({ dispatch: dispatch.port, fetchImpl });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "手机建的，顺便交给 Claude", dispatch: true },
      });
      await waitFor(() => dispatch.children.length === 1, "会话已起");
      await waitFor(() => blockedAckPuts >= 1, "回执写失败");
      // 会话随即失败：任务最近一次派单不再是 queued/running，旧的「复用进行中派单」挡不住重做。
      dispatch.children[0]!.finish(1);
      const created = dispatch.dispatcher.listRuns()[0]!;
      await waitFor(
        () => dispatch.dispatcher.runForTask("ALPHA", created.key)?.state === "failed",
        "派单失败",
      );
      await waitFor(() => blockedAckPuts >= 2, "又重做了一次（回执仍写不进去）");
      blockAcks = false;
      const ack: AckDoc = await phone.awaitAck(sent.id);
      expect(ack).toMatchObject({
        ok: true,
        result: { key: created.key, dispatch: { run: created.run, state: "failed" } },
      });
      expect(dispatch.children).toHaveLength(1);
      expect(dispatch.dispatcher.listRuns()).toHaveLength(1);
      expect(new Set(dispatch.enqueued.map((input) => input.requestId))).toEqual(
        new Set([sent.id]),
      );
      const keys = (await fixture.service.listWorkItemsForUi("ALPHA", {})).map((item) => item.key);
      expect(keys.filter((key) => key === created.key)).toHaveLength(1);
      expect(keys).toHaveLength(2); // 种子任务 + 手机建的这一个。
    } finally {
      await fixture.close();
    }
  });
});

describe("电脑上的 ATM 退出时手机派单还在途（peer R3-01）", () => {
  it.each([
    ["交给 Claude（task.dispatch）", "dispatch"],
    ["建任务并交给 Claude（task.create + dispatch）", "create"],
  ] as const)(
    "%s：派单器先随退出关闭，在途派单立即结束、不再读库、不写回执；下次启动处理这条命令，只建一次、只派一次",
    async (_name, kind) => {
      const fixture = await openFixture();
      try {
        const task = await seedDispatchable(fixture);
        // 这次启动时 claude 的登录探测迟迟不回来（假 claude 的 hang 模式，1.5 s 后超时）。
        const authFile = join(fixture.dataDir, "fake-claude-auth.json");
        writeFileSync(authFile, JSON.stringify({ mode: "hang" }));
        const baseEnv = { ...process.env, FAKE_CLAUDE_AUTH_FILE: authFile };
        const base = taskServiceDispatchHost(fixture.service);
        let stopped = false;
        const late: string[] = [];
        const host: DispatchHost = {
          getProject(code) {
            if (stopped) late.push("getProject");
            return base.getProject(code);
          },
          getTask(code, key) {
            if (stopped) late.push("getTask");
            return base.getTask(code, key);
          },
        };
        const abort = new AbortController();
        const first = await realDispatcher(fixture, {
          host,
          signal: abort.signal,
          baseEnv,
          authProbeTimeoutMs: 1_500,
        });
        const connector = fixture.connector({ dispatch: first.port });
        const pairing = await connect(connector, fixture.relay);
        const phone = await phoneFor(fixture.relay, pairing.pairingCode);
        const sent = await phone.store.sendCommand(
          phone.device,
          kind === "dispatch"
            ? { type: "task.dispatch", body: { project: "ALPHA", key: task.key } }
            : {
                type: "task.create",
                body: { project: "ALPHA", title: "退出时还在派的任务", dispatch: true },
              },
        );
        await waitFor(() => existsSync(`${authFile}.count`), "登录探测已发出");
        const mark = fixture.relay.requests.length;
        // 与 core-mobile 收尾同序：先中止（派单器随之关闭），再停连接器。
        abort.abort();
        const began = performance.now();
        await connector.stop();
        // 在途的派单立即结束，连接器不用等满停止预算（1 s）。
        expect(performance.now() - began).toBeLessThan(500);
        stopped = true;
        expect(fixture.relay.putsSince(mark).filter((put) => put.includes("/ack/"))).toEqual([]);
        expect(fixture.relay.docs.has(commandKey(pairing.spaceId, sent.id))).toBe(true);
        // 探测超时回来以后也不再往下走：不读库、不排队。
        await new Promise((resolve) => setTimeout(resolve, 1_800));
        expect(late).toEqual([]);
        expect(first.dispatcher.listRuns()).toEqual([]);

        writeFileSync(authFile, JSON.stringify({ mode: "in" }));
        const second = await realDispatcher(fixture, { baseEnv });
        const restarted = fixture.connector({ dispatch: second.port });
        await restarted.start();
        const ack = await phone.awaitAck(sent.id);
        expect(ack).toMatchObject({ ok: true, result: { dispatch: { state: "queued" } } });
        await waitFor(() => second.children.length === 1, "会话已起");
        expect(second.dispatcher.listRuns()).toHaveLength(1);
        expect(second.enqueued.map((input) => input.requestId)).toEqual([sent.id]);
        // 建任务那一半在第一次就做完了：重做靠 op_id 拿回同一个任务，不会建出第二个。
        const items = await fixture.service.listWorkItemsForUi("ALPHA", {});
        expect(items).toHaveLength(kind === "dispatch" ? 1 : 2);
        await restarted.stop();
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("已处理命令的保留窗口", () => {
  it("按命令 ID 里的发送时间保留到有效期之后，不按条数滚动；硬上限只挤最早记下的", () => {
    const now = Date.parse("2026-09-30T00:00:00.000Z");
    const at = (ms: number) => newCommandId("m-00000000cafe", ms);
    const old = at(now - PROCESSED_RETENTION_MS - 1);
    const edge = at(now - PROCESSED_RETENTION_MS + 1);
    const future = at(now + 2 * DAY); // 手机时钟快了：要等它过期才能忘。
    const current = at(now);
    let config = { ...defaultSyncConfig("测试电脑"), processed: [old, edge, future] };
    config = rememberProcessed(config, current, new Date(now));
    expect(config.processed).toEqual([edge, future, current]);
    // 旧实现到 500 条就开始挤：这里记 600 条，最早那条仍在。
    for (let index = 0; index < 600; index += 1)
      config = rememberProcessed(config, at(now - index * 1000), new Date(now));
    expect(config.processed).toHaveLength(603);
    expect(config.processed[0]).toBe(edge);
    // 同一条再记一次不变。
    expect(rememberProcessed(config, edge, new Date(now))).toBe(config);
    // 硬上限：只挤最早记下的。
    for (let index = 0; index < PROCESSED_COMMAND_LIMIT; index += 1)
      config = rememberProcessed(config, at(now - index), new Date(now));
    expect(config.processed).toHaveLength(PROCESSED_COMMAND_LIMIT);
    expect(config.processed).not.toContain(edge);
  });

  it("窗口与派单账本都盖住命令的整个有效期（含时钟容差）；派单层抄的有效期与协议一致", () => {
    expect(DISPATCH_REQUEST_MAX_AGE_MS).toBe(COMMAND_MAX_AGE_MS);
    expect(PROCESSED_RETENTION_MS).toBeGreaterThan(COMMAND_MAX_AGE_MS + COMMAND_CLOCK_TOLERANCE_MS);
    // 账本从首次处理算起：手机时钟最多快 COMMAND_FUTURE_TOLERANCE_MS，命令还能在那之后活满有效期。
    expect(DISPATCH_REQUEST_RETENTION_MS).toBeGreaterThan(
      COMMAND_MAX_AGE_MS + COMMAND_FUTURE_TOLERANCE_MS + COMMAND_CLOCK_TOLERANCE_MS,
    );
  });
});
