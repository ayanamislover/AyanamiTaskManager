import { describe, expect, it } from "vitest";

import {
  COMMAND_ID_PATTERN,
  classifyKey,
  commandKey,
  commandTimestamp,
  decodePairingCode,
  encodePairingCode,
  generateSpace,
  headKey,
  newCommandId,
  newDeviceId,
  normalizeRelayUrl,
  partKey,
  projectKey,
  type PairingPayload,
} from "../src/index.js";

function payload(overrides: Partial<PairingPayload> = {}): PairingPayload {
  const space = generateSpace();
  return {
    v: 1,
    u: "https://relay.example.com/",
    a: "atm",
    t: "atr_abcdefgh_secret-token",
    s: space.spaceId,
    k: space.secret,
    n: "工作站",
    ...overrides,
  };
}

describe("配对码", () => {
  it("往返；地址被规范化；容忍复制带进来的空白与换行", () => {
    const original = payload();
    const code = encodePairingCode(original);
    expect(code.startsWith("atm1:")).toBe(true);
    const spaced = `  ${code.slice(0, 20)}\n ${code.slice(20)}  `;
    expect(decodePairingCode(spaced)).toEqual({ ...original, u: "https://relay.example.com" });
  });

  it("前缀、内容、字段、密钥长度出错都给出 PAIRING_CODE_INVALID", () => {
    const good = encodePairingCode(payload());
    for (const bad of ["", "atm2:xxxx", "atm1:!!!", `atm1:${btoa("{}")}`, good.slice(0, -6)]) {
      expect(() => decodePairingCode(bad)).toThrowError(
        expect.objectContaining({ code: "PAIRING_CODE_INVALID" }),
      );
    }
    expect(() => encodePairingCode(payload({ k: "short" }))).toThrow();
  });

  it("只接受 https；http 只留给本机调试", () => {
    expect(normalizeRelayUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    expect(normalizeRelayUrl("http://localhost:8790")).toBe("http://localhost:8790");
    expect(normalizeRelayUrl("https://relay.example.com/sub/")).toBe(
      "https://relay.example.com/sub",
    );
    for (const bad of [
      "http://192.168.1.2:8790",
      "ftp://relay.example.com",
      "https://user:pw@relay.example.com",
      "https://relay.example.com/?x=1",
      "not a url",
    ]) {
      expect(() => normalizeRelayUrl(bad)).toThrowError(
        expect.objectContaining({ code: "RELAY_URL_INVALID" }),
      );
    }
    expect(() => encodePairingCode(payload({ u: "http://10.0.0.2" }))).toThrow();
  });
});

describe("文档键", () => {
  const { spaceId } = generateSpace();

  it("各类键归类正确，分片后缀被识别，外来键返回 null", () => {
    const device = newDeviceId("m");
    const command = newCommandId(device);
    expect(command).toMatch(COMMAND_ID_PATTERN);
    const hash = "0123456789abcdef0123";
    expect(classifyKey(spaceId, headKey(spaceId))).toMatchObject({ kind: "head", part: 0 });
    expect(classifyKey(spaceId, projectKey(spaceId, hash))).toMatchObject({
      kind: "project",
      hash,
    });
    expect(classifyKey(spaceId, partKey(projectKey(spaceId, hash), 3))).toMatchObject({
      kind: "project",
      hash,
      part: 3,
      logicalKey: projectKey(spaceId, hash),
    });
    // 命令 ID 自带一个点，不能被误认成分片。
    expect(classifyKey(spaceId, commandKey(spaceId, command))).toMatchObject({
      kind: "command",
      id: command,
      part: 0,
    });
    const other = generateSpace().spaceId;
    expect(classifyKey(spaceId, headKey(other))).toBeNull();
    expect(classifyKey(spaceId, `atm1/${spaceId}/p/NOT-A-HASH`)).toBeNull();
    expect(classifyKey(spaceId, `atm1/${spaceId}/zzz/abc`)).toBeNull();
    expect(classifyKey(spaceId, `atm1/${spaceId}/p/${hash}/extra`)).toBeNull();
  });

  it("命令 ID 可取回发送时间且按时间排序", () => {
    const device = newDeviceId("pc");
    const early = newCommandId(device, 1_700_000_000_000);
    const late = newCommandId(device, 1_800_000_000_000);
    expect(commandTimestamp(early)).toBe(1_700_000_000_000);
    expect(early.split(".")[1]! < late.split(".")[1]!).toBe(true);
    expect(commandTimestamp("garbage")).toBeNull();
  });

  it("非法输入不生成键", () => {
    expect(() => headKey("XYZ")).toThrow();
    expect(() => projectKey(spaceId, "short")).toThrow();
    expect(() => partKey("k", 0)).toThrow();
    expect(() => newCommandId("bad")).toThrow();
  });
});
