import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import {
  RelayClient,
  SpaceStore,
  decodePairingCode,
  deriveSpaceKeys,
  newDeviceId,
  type AckDoc,
} from "@ayanami-task/sync-protocol";
import {
  FileSecretStore,
  SyncConnector,
  type DispatchPort,
  type SecretStore,
  type SyncConnectorOptions,
  type SyncDispatchRun,
} from "../../src/index.js";
import { MemoryRelay } from "./memory-relay.js";

export const RELAY_URL = "https://relay.example.com";

const temporary: string[] = [];

/** 在 afterEach 里调用：关库后删临时目录。 */
export async function cleanupFixtures(): Promise<void> {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export type Fixture = Awaited<ReturnType<typeof openFixture>>;

export async function openFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-sync-connector-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const relay = new MemoryRelay();
  const secrets = new FileSecretStore(join(dataDir, "sync"));
  const connectors: SyncConnector[] = [];
  return {
    dataDir,
    service,
    relay,
    secrets,
    /** 起一个连接器：快速计时，全部请求走内存中继。 */
    connector(overrides: Partial<SyncConnectorOptions> = {}): SyncConnector {
      const connector = new SyncConnector({
        dataDir,
        service,
        secrets,
        appVersion: "1.3.0-test",
        fetchImpl: relay.fetch,
        deviceName: "测试电脑",
        timings: {
          debounceMs: 5,
          maxDelayMs: 50,
          presenceMs: 60_000,
          pollIntervalMs: 5,
          retryPublishMs: 20,
          stopTimeoutMs: 1000,
        },
        sleep: (ms, signal) =>
          new Promise((done, fail) => {
            if (signal?.aborted) return fail(signal.reason);
            const timer = setTimeout(done, Math.min(ms, 5));
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                fail(signal.reason);
              },
              { once: true },
            );
          }),
        ...overrides,
      });
      connectors.push(connector);
      return connector;
    },
    async close() {
      for (const connector of connectors) await connector.stop();
      service.close();
    },
  };
}

/** 建项目 + 目标，返回目标 ID；objective=false 时只建项目。 */
export async function seedProject(
  service: AyanamiTaskService,
  code: string,
  options: { objective?: boolean; name?: string } = {},
): Promise<string | null> {
  await service.createProject({ name: options.name ?? `项目 ${code}`, sourcePath: null, code });
  if (options.objective === false) return null;
  const objective = await service.createObjectiveAsUser(code, `seed-objective-${code}`, {
    title: `${code} 目标`,
    description: "",
    definitionOfDone: [],
  });
  return String(objective.id);
}

export async function seedTask(
  service: AyanamiTaskService,
  code: string,
  objectiveId: string,
  input: { title: string; description?: string; acceptance?: string[]; opId?: string },
) {
  const created = await service.createWorkItemsAsUser(code, input.opId ?? `seed-${input.title}`, [
    {
      clientRef: "seed",
      objectiveId,
      title: input.title,
      description: input.description ?? "",
      type: "TASK",
      priority: "NORMAL",
      status: "READY",
      acceptance: input.acceptance ?? [],
      checklist: [],
      dependsOn: [],
      dependsOnRefs: [],
      weight: 1,
      verificationRequired: false,
    },
  ]);
  return created.items[0]!;
}

/** 启用 + 配置中继 + 启动 + 生成配对码，等到在线。 */
export async function connect(connector: SyncConnector, relay: MemoryRelay) {
  await connector.updateConfig({ enabled: true, relayUrl: RELAY_URL, token: relay.token });
  await connector.start();
  const pairing = await connector.createPairing();
  await waitFor(async () => (await connector.status()).state === "online", "连接器上线");
  return pairing;
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 手机一侧：用配对码里的 token 与密钥读写同一个空间。 */
export async function phoneFor(relay: MemoryRelay, pairingCode: string) {
  const payload = decodePairingCode(pairingCode);
  const client = new RelayClient({
    baseUrl: payload.u,
    appId: payload.a,
    token: payload.t,
    fetchImpl: relay.fetch,
  });
  const keys = await deriveSpaceKeys(payload.k);
  const store = new SpaceStore({ client, keys, spaceId: payload.s, sleep: async () => undefined });
  const device = { id: newDeviceId("m"), name: "测试手机" };
  return {
    payload,
    client,
    keys,
    store,
    device,
    async awaitAck(commandId: string): Promise<AckDoc> {
      let ack: AckDoc | null = null;
      await waitFor(async () => {
        ack = await store.readAck(commandId);
        return ack !== null;
      }, `回执 ${commandId}`);
      return ack!;
    },
  };
}

/** 记录调用的派单端口替身。 */
export function fakeDispatch(options: { reject?: { code: string; message: string } } = {}) {
  const calls: Array<{ project: string; key: string; requestedBy?: string }> = [];
  const runs = new Map<string, SyncDispatchRun>();
  const listeners = new Set<(event: { project?: string }) => void>();
  const port: DispatchPort = {
    summary: () => ({
      enabled: !options.reject,
      mode: "auto",
      running: [...runs.values()].filter((run) => run.state === "running").length,
    }),
    runForTask: (project, key) => runs.get(`${project}/${key}`) ?? null,
    async enqueue(input) {
      calls.push(input);
      if (options.reject)
        throw Object.assign(new Error(options.reject.message), { code: options.reject.code });
      const run: SyncDispatchRun = {
        run: `run-${calls.length}`,
        state: "queued",
        at: new Date().toISOString(),
      };
      runs.set(`${input.project}/${input.key}`, run);
      for (const listener of listeners) listener({ project: input.project });
      return run;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port, calls, runs };
}

/** 系统加密不可用的密钥存储（模拟 safeStorage.isEncryptionAvailable() 为假）。 */
export function unavailableSecrets(): SecretStore {
  return {
    kind: "os-encrypted",
    available: () => false,
    unavailableReason: () => "系统加密不可用（测试）",
    read: async () => null,
    write: async () => {
      throw new Error("不应写入");
    },
    remove: async () => undefined,
  };
}
