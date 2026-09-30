import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpaceStore, headKey, spacePrefix } from "@ayanami-task/sync-protocol";
import {
  FileSecretStore,
  SECRET_NAMES,
  loadSyncConfig,
  saveSyncConfig,
  type SecretStore,
} from "../src/index.js";
import {
  RELAY_URL,
  cleanupFixtures,
  connect,
  openFixture,
  phoneFor,
  seedProject,
  unavailableSecrets,
  waitFor,
} from "./support/fixture.js";

afterEach(cleanupFixtures);

describe("密钥与状态", () => {
  it("状态里搜不到 token、空间密钥和配对码，字段与桌面客户端契约一致", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const status = await connector.status();
      expect(Object.keys(status).sort()).toEqual(
        [
          "enabled",
          "configured",
          "relayUrl",
          "appId",
          "deviceName",
          "state",
          "lastError",
          "lastSyncAt",
          "longPoll",
          "secretStore",
          "paired",
          "pendingCommands",
        ].sort(),
      );
      expect(status).toMatchObject({
        enabled: true,
        configured: true,
        relayUrl: RELAY_URL,
        state: "online",
        lastError: null,
        secretStore: "plaintext",
      });
      const text = JSON.stringify(status);
      for (const secret of [fixture.relay.token, phone.payload.k, pairing.pairingCode])
        expect(text).not.toContain(secret);
      expect(text).not.toContain(pairing.pairingCode.slice(5, 40));
      // 密钥确实落在密钥存储里，而不是配置文件里。
      expect(await fixture.secrets.read(SECRET_NAMES.relayToken)).toBe(fixture.relay.token);
      expect(await fixture.secrets.read(SECRET_NAMES.spaceSecret)).toContain(phone.payload.k);
    } finally {
      await fixture.close();
    }
  });

  it("默认关闭：启动后不发任何请求，状态是 disabled，deviceId 固定下来", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector();
      await connector.start();
      await connector.syncNow();
      expect((await connector.status()).state).toBe("disabled");
      expect(fixture.relay.requests).toEqual([]);
      const deviceId = loadSyncConfig(fixture.dataDir).deviceId;
      await connector.stop();
      const again = fixture.connector();
      await again.start();
      expect(loadSyncConfig(fixture.dataDir).deviceId).toBe(deviceId);
    } finally {
      await fixture.close();
    }
  });

  it("启用了但没填中继：状态 error 并说明缺什么", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector();
      await connector.start();
      const status = await connector.updateConfig({ enabled: true });
      expect(status).toMatchObject({ state: "error", configured: false });
      expect(status.lastError).toContain("还没有填写中继地址或 token");
      expect(fixture.relay.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("系统加密不可用时拒绝保存 token，状态里说明原因", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector({ secrets: unavailableSecrets() });
      await expect(connector.updateConfig({ token: "abcdefgh12345" })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      const status = await connector.status();
      expect(status).toMatchObject({ secretStore: "safeStorage", configured: false });
      expect(status.lastError).toContain("系统加密不可用");
      const configPath = join(fixture.dataDir, "sync", "config.json");
      const saved = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      expect(saved).not.toContain("abcdefgh12345");
    } finally {
      await fixture.close();
    }
  });

  it("配置补丁逐项校验：http 公网地址、坏应用 ID、过短 token 都拒绝", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector();
      for (const patch of [
        { relayUrl: "http://relay.example.com" },
        { appId: "Bad App" },
        { token: "short" },
        { unknown: true },
      ])
        await expect(connector.updateConfig(patch)).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      const status = await connector.updateConfig({ relayUrl: "http://127.0.0.1:8790/" });
      expect(status).toMatchObject({ relayUrl: "http://127.0.0.1:8790", configured: false });
      expect((await connector.updateConfig({ token: "long-enough-token" })).configured).toBe(true);
      expect((await connector.updateConfig({ relayUrl: "" })).configured).toBe(false);
      await connector.updateConfig({ relayUrl: RELAY_URL });
      expect((await connector.updateConfig({ token: "" })).configured).toBe(false);
      expect(await fixture.secrets.read(SECRET_NAMES.relayToken)).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});

describe("中继异常", () => {
  it("中继拒绝 token（401）后停下并提示；换上正确 token 恢复", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      await connect(connector, fixture.relay);
      fixture.relay.token = "revoked-token-000";
      await waitFor(async () => (await connector.status()).state === "error", "进入 error");
      expect((await connector.status()).lastError).toContain("中继拒绝了 token");
      // 停下了：不再发请求。
      const mark = fixture.relay.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(fixture.relay.requests.length).toBe(mark);

      fixture.relay.token = "rotated-token-111";
      await connector.updateConfig({ token: fixture.relay.token });
      await waitFor(async () => (await connector.status()).state === "online", "恢复在线");
    } finally {
      await fixture.close();
    }
  });

  it("断网时退避重试并写中文错误，恢复后回到在线", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector();
      await connect(connector, fixture.relay);
      fixture.relay.offline = true;
      await waitFor(async () => (await connector.status()).state === "error", "进入 error");
      expect((await connector.status()).lastError).toContain("连不上中继");
      fixture.relay.offline = false;
      await waitFor(async () => (await connector.status()).state === "online", "恢复在线");
    } finally {
      await fixture.close();
    }
  });

  it("游标过期（410）时重读命令并把快照全部重写一遍", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      await connector.stop();
      // 写一些别处的变更，再把旧的全部裁掉：保存的游标就落在保留窗口之外。
      const other = await phoneFor(fixture.relay, pairing.pairingCode);
      for (let index = 0; index < 3; index += 1)
        await other.client.putDocument(`noise/${index}`, 0, { index });
      fixture.relay.prune(1);
      const mark = fixture.relay.requests.length;
      const restarted = fixture.connector();
      await restarted.start();
      await waitFor(
        () => fixture.relay.putsSince(mark).includes(headKey(pairing.spaceId)),
        "410 后重写 head",
      );
      await waitFor(async () => (await restarted.status()).state === "online", "重新在线");
    } finally {
      await fixture.close();
    }
  });

  it("中继不认保存的游标（400）时清掉游标重来一次，并强制重写快照", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      await connector.stop();
      const config = loadSyncConfig(fixture.dataDir);
      saveSyncConfig(fixture.dataDir, { ...config, cursor: "cloud:opaque-cursor" });
      const mark = fixture.relay.requests.length;
      const restarted = fixture.connector();
      await restarted.start();
      await waitFor(
        () => fixture.relay.putsSince(mark).includes(headKey(pairing.spaceId)),
        "清游标后重写 head",
      );
      await waitFor(async () => (await restarted.status()).state === "online", "重新在线");
      expect(loadSyncConfig(fixture.dataDir).cursor).toMatch(/^\d+$/u);
    } finally {
      await fixture.close();
    }
  });
});

describe("配对", () => {
  it("并发两次取配对码只建一个空间；已有空间时返回同一个配对码", async () => {
    const fixture = await openFixture();
    try {
      // 记下空间密钥写了几次；写入稍慢一点（DPAPI 落盘也要时间），让并发请求真的交错。
      const spaceWrites: string[] = [];
      const counting: SecretStore = {
        kind: fixture.secrets.kind,
        read: (name) => fixture.secrets.read(name),
        remove: (name) => fixture.secrets.remove(name),
        async write(name, value) {
          if (name === SECRET_NAMES.spaceSecret) spaceWrites.push(value);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await fixture.secrets.write(name, value);
        },
      };
      const connector = fixture.connector({ secrets: counting });
      await connector.updateConfig({ relayUrl: RELAY_URL, token: fixture.relay.token });
      const [first, second] = await Promise.all([
        connector.createPairing(),
        connector.createPairing(),
      ]);
      expect(second).toEqual(first);
      expect(spaceWrites).toHaveLength(1);
      expect(await connector.createPairing()).toEqual(first);
      expect(loadSyncConfig(fixture.dataDir).spaceId).toBe(first.spaceId);
      // 启用后同步循环也不会另建空间；循环与配对请求同时要空间也只建一次。
      await connector.start();
      await Promise.all([connector.updateConfig({ enabled: true }), connector.createPairing()]);
      await waitFor(async () => (await connector.status()).state === "online", "上线");
      expect((await connector.createPairing()).spaceId).toBe(first.spaceId);
      expect(spaceWrites).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("同步循环与配对请求同时要建空间：只建一次，配对码指向循环在用的空间", async () => {
    const fixture = await openFixture();
    try {
      const spaceWrites: string[] = [];
      const counting: SecretStore = {
        kind: fixture.secrets.kind,
        read: (name) => fixture.secrets.read(name),
        remove: (name) => fixture.secrets.remove(name),
        async write(name, value) {
          if (name === SECRET_NAMES.spaceSecret) spaceWrites.push(value);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await fixture.secrets.write(name, value);
        },
      };
      const connector = fixture.connector({ secrets: counting });
      await connector.start();
      // 启用后循环立刻开始建空间（写密钥要 10 ms），配对请求此时进来。
      await connector.updateConfig({
        enabled: true,
        relayUrl: RELAY_URL,
        token: fixture.relay.token,
      });
      const pairing = await connector.createPairing();
      await waitFor(async () => (await connector.status()).state === "online", "上线");
      expect(spaceWrites).toHaveLength(1);
      expect(loadSyncConfig(fixture.dataDir).spaceId).toBe(pairing.spaceId);
      expect(fixture.relay.docs.has(headKey(pairing.spaceId))).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("没填中继就要配对码：拒绝并说明", async () => {
    const fixture = await openFixture();
    try {
      await expect(fixture.connector().createPairing()).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    } finally {
      await fixture.close();
    }
  });

  it("手机写的在线状态出现在已配对设备里，本机不在其中", async () => {
    const fixture = await openFixture();
    try {
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const at = new Date().toISOString();
      await phone.store.writeDevice({
        v: 1,
        id: phone.device.id,
        name: phone.device.name,
        kind: "android",
        role: "client",
        app: "1.0.0",
        at,
        state: "online",
      });
      await waitFor(
        async () => (await connector.status()).paired.length === 1,
        "手机出现在设备列表",
      );
      expect((await connector.status()).paired).toEqual([
        {
          id: phone.device.id,
          name: "测试手机",
          kind: "android",
          role: "client",
          app: "1.0.0",
          at,
          state: "online",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("resetSpace 换新空间：旧空间被清空，旧密钥读不了新数据，新配对码可用", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const oldPhone = await phoneFor(fixture.relay, pairing.pairingCode);
      expect(await oldPhone.store.readHead()).not.toBeNull();

      const reset = await connector.resetSpace();
      expect(reset.spaceId).not.toBe(pairing.spaceId);
      expect(reset.removed).toBeGreaterThan(0);
      expect(reset.cleanupError).toBeUndefined();
      const oldKeys = [...fixture.relay.docs.keys()].filter((key) =>
        key.startsWith(spacePrefix(pairing.spaceId)),
      );
      expect(oldKeys).toEqual([]);
      expect(await oldPhone.store.readHead()).toBeNull();

      await waitFor(async () => (await connector.status()).state === "online", "新空间上线");
      await waitFor(() => fixture.relay.docs.has(headKey(reset.spaceId)), "新空间有 head");
      // 旧手机拿着旧密钥去读新空间：kid 对不上，读不出来。
      const snooping = new SpaceStore({
        client: oldPhone.client,
        keys: oldPhone.keys,
        spaceId: reset.spaceId,
      });
      await expect(snooping.readHead()).rejects.toMatchObject({ code: "KEY_MISMATCH" });

      const fresh = await connector.createPairing();
      expect(fresh.spaceId).toBe(reset.spaceId);
      expect(fresh.pairingCode).not.toBe(pairing.pairingCode);
      const newPhone = await phoneFor(fixture.relay, fresh.pairingCode);
      expect((await newPhone.store.readHead())?.projects.map((project) => project.code)).toEqual([
        "ALPHA",
      ]);
    } finally {
      await fixture.close();
    }
  });
});

describe("FileSecretStore", () => {
  it("明文 JSON 文件读写删，标 plaintext；空间密钥与配置里的空间 ID 对不上就不拿它上线", async () => {
    const fixture = await openFixture();
    try {
      const directory = join(fixture.dataDir, "secrets-probe");
      const store = new FileSecretStore(directory);
      expect(store.kind).toBe("plaintext");
      expect(await store.read(SECRET_NAMES.relayToken)).toBeNull();
      await store.write(SECRET_NAMES.relayToken, "token-value-123");
      await store.write(SECRET_NAMES.spaceSecret, "aaaa:bbbb");
      expect(await store.read(SECRET_NAMES.relayToken)).toBe("token-value-123");
      if (process.platform !== "win32") expect(statSync(store.path).mode & 0o777).toBe(0o600);
      await store.remove(SECRET_NAMES.relayToken);
      expect(await store.read(SECRET_NAMES.relayToken)).toBeNull();
      expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({
        [SECRET_NAMES.spaceSecret]: "aaaa:bbbb",
      });

      // 配置指向的空间与密钥存储里的对不上：不会拿错的密钥去那个空间，而是另建新空间。
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      await connector.stop();
      const bogus = "0".repeat(24);
      const config = loadSyncConfig(fixture.dataDir);
      saveSyncConfig(fixture.dataDir, { ...config, spaceId: bogus });
      const confused = fixture.connector();
      await confused.start();
      await waitFor(async () => (await confused.status()).state === "online", "新空间上线");
      const spaceId = loadSyncConfig(fixture.dataDir).spaceId;
      expect(spaceId).not.toBe(bogus);
      expect(spaceId).not.toBe(pairing.spaceId);
      expect([...fixture.relay.docs.keys()].some((key) => key.startsWith(spacePrefix(bogus)))).toBe(
        false,
      );
    } finally {
      await fixture.close();
    }
  });
});
