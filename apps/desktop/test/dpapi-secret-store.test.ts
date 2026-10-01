import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SECRET_NAMES } from "@ayanami-task/sync";
import { hostDpapi, type Dpapi } from "../src/dpapi.js";
import { DpapiSecretStore } from "../src/dpapi-secret-store.js";

/**
 * 手机同步密钥的 DPAPI 存储（ATM-T-0567）：Electron safeStorage 随 Electron 去掉以后，
 * 密钥经原生宿主的 `--dpapi` 一次性模式加密。不可用时拒绝保存，绝不退回明文。
 */
const scratchRoot = resolve(process.cwd(), "output");
mkdirSync(scratchRoot, { recursive: true });
const work = mkdtempSync(join(scratchRoot, "dpapi-store-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const fakeHost = resolve(process.cwd(), "apps/desktop/test/fixtures/fake-dpapi.mjs");
const fake = (timeoutMs?: number) =>
  hostDpapi(process.execPath, { prefixArgs: [fakeHost], ...(timeoutMs ? { timeoutMs } : {}) });
const realHost = resolve(process.cwd(), "apps/desktop/native/target/debug/AyanamiTaskManager.exe");

let counter = 0;
const freshDirectory = () => join(work, `case-${(counter += 1)}`);

afterEach(() => {
  delete process.env.FAKE_DPAPI_MODE;
});

describe("经宿主调 DPAPI 的协议", () => {
  it("往返：密文不含明文，解开等于原文", async () => {
    const dpapi = fake();
    const secret = Buffer.from("atr_relay-token");
    const sealed = await dpapi.protect(secret);
    expect(sealed.includes(secret)).toBe(false);
    expect((await dpapi.unprotect(sealed)).equals(secret)).toBe(true);
  });

  it("宿主不存在、不认识 --dpapi（普通 node）、调用失败、输出不是 hex、输出超长、超时都 reject", async () => {
    await expect(hostDpapi(join(work, "missing.exe")).protect(Buffer.from("x"))).rejects.toThrow();
    await expect(hostDpapi(process.execPath).protect(Buffer.from("x"))).rejects.toThrow();
    for (const mode of ["fail", "garbage", "huge"]) {
      process.env.FAKE_DPAPI_MODE = mode;
      await expect(fake().protect(Buffer.from("x"))).rejects.toThrow();
    }
    process.env.FAKE_DPAPI_MODE = "hang";
    await expect(fake(300).protect(Buffer.from("x"))).rejects.toThrow("DPAPI_TIMEOUT");
  });

  it.skipIf(process.platform !== "win32" || !existsSync(realHost))(
    "真宿主（cargo build -p atm-host）：DPAPI 往返，篡改过的密文解不开",
    async () => {
      const dpapi = hostDpapi(realHost);
      const secret = Buffer.from("space:0123456789abcdef");
      const sealed = await dpapi.protect(secret);
      expect(sealed.includes(secret)).toBe(false);
      expect((await dpapi.unprotect(sealed)).equals(secret)).toBe(true);
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
      await expect(dpapi.unprotect(tampered)).rejects.toThrow();
    },
  );
});

describe("DpapiSecretStore", () => {
  it("可用时写入的是密文，读回原文；删除后读不到", async () => {
    const directory = freshDirectory();
    const store = await DpapiSecretStore.open(directory, fake());
    expect(store.kind).toBe("os-encrypted");
    expect(store.available()).toBe(true);
    expect(store.unavailableReason()).toBeNull();
    await store.write(SECRET_NAMES.relayToken, "atr_secret-token");
    await store.write(SECRET_NAMES.spaceSecret, "space-1:pairing-secret");
    const onDisk = readFileSync(join(directory, "secrets.dpapi.json"), "utf8");
    expect(onDisk).not.toContain("atr_secret-token");
    expect(onDisk).not.toContain("pairing-secret");
    expect(await store.read(SECRET_NAMES.relayToken)).toBe("atr_secret-token");
    expect(await store.read(SECRET_NAMES.spaceSecret)).toBe("space-1:pairing-secret");
    await store.remove(SECRET_NAMES.relayToken);
    expect(await store.read(SECRET_NAMES.relayToken)).toBeNull();
    expect(await store.read(SECRET_NAMES.spaceSecret)).toBe("space-1:pairing-secret");
  });

  it("自检不通过（没有 DPAPI、调用失败、解出来不一样、密文里带着明文）就整体不可用：拒绝写入，读一律为空", async () => {
    const broken: Array<Dpapi | null> = [
      null,
      {
        protect: () => Promise.reject(new Error("no")),
        unprotect: () => Promise.reject(new Error("no")),
      },
      {
        protect: (data) => Promise.resolve(Buffer.from(data)),
        unprotect: (data) => Promise.resolve(data),
      },
      {
        protect: () => Promise.resolve(Buffer.from("sealed")),
        unprotect: () => Promise.resolve(Buffer.from("something else")),
      },
    ];
    for (const dpapi of broken) {
      const directory = freshDirectory();
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "secrets.dpapi.json"),
        JSON.stringify({ [SECRET_NAMES.relayToken]: Buffer.from("x").toString("base64") }),
      );
      const store = await DpapiSecretStore.open(directory, dpapi);
      expect(store.available()).toBe(false);
      expect(store.unavailableReason()).toMatch(/DPAPI/u);
      await expect(store.write(SECRET_NAMES.relayToken, "atr_plain")).rejects.toThrow(/DPAPI/u);
      expect(await store.read(SECRET_NAMES.relayToken)).toBeNull();
      expect(readFileSync(join(directory, "secrets.dpapi.json"), "utf8")).not.toContain(
        "atr_plain",
      );
    }
  });

  it("解不开的密文（换了 Windows 用户、文件被改坏）当作没有；坏掉的文件当作空", async () => {
    const directory = freshDirectory();
    const store = await DpapiSecretStore.open(directory, fake());
    await store.write(SECRET_NAMES.relayToken, "atr_token");
    const path = join(directory, "secrets.dpapi.json");
    const values = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    values[SECRET_NAMES.relayToken] = Buffer.from("not sealed by us").toString("base64");
    writeFileSync(path, JSON.stringify(values));
    expect(await store.read(SECRET_NAMES.relayToken)).toBeNull();
    writeFileSync(path, "{broken");
    expect(await store.read(SECRET_NAMES.spaceSecret)).toBeNull();
    await store.write(SECRET_NAMES.spaceSecret, "space-2:secret");
    expect(await store.read(SECRET_NAMES.spaceSecret)).toBe("space-2:secret");
  });

  it("两项同时写入不会互相覆盖", async () => {
    const directory = freshDirectory();
    const store = await DpapiSecretStore.open(directory, fake());
    await Promise.all([
      store.write(SECRET_NAMES.relayToken, "atr_concurrent"),
      store.write(SECRET_NAMES.spaceSecret, "space-3:concurrent"),
    ]);
    expect(await store.read(SECRET_NAMES.relayToken)).toBe("atr_concurrent");
    expect(await store.read(SECRET_NAMES.spaceSecret)).toBe("space-3:concurrent");
  });
});
