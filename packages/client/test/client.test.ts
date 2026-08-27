import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../../application/src/index.js";
import { buildAyanamiServer } from "../../../apps/daemon/src/index.js";
import {
  AyanamiClient,
  AyanamiClientError,
  type RecordCreateReceipt,
  type UserRecordCreateInput,
} from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("typed client", () => {
  it("通过真实 HTTP 创建项目并保留结构化错误码", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-client-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "typed-token" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(async () => {
      await app.close();
      service.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP");
    const endpoint = `http://127.0.0.1:${address.port}`;

    const denied = new AyanamiClient({ endpoint, token: "wrong" });
    await expect(denied.status()).rejects.toMatchObject<AyanamiClientError>({
      code: "UNAUTHORIZED",
      status: 401,
    });

    const client = new AyanamiClient({ endpoint, token: "typed-token" });
    const created = await client.projects.create({
      name: "客户端项目",
      sourcePath: null,
      code: "CLI",
    });
    expect(created).toMatchObject({ code: "CLI", name: "客户端项目" });
    await expect(client.projects.list()).resolves.toHaveLength(1);
    await expect(client.projects.reconciliation("CLI")).resolves.toMatchObject({
      project: { code: "CLI", sourceRoot: null },
      attentionCount: 0,
      items: [],
    });
    await expect(client.projects.reconciliation("CLI", true)).resolves.toMatchObject({
      counts: { ACTIVE: 0, LEASE_EXPIRED_ONLINE: 0, STALLED: 0, POSSIBLY_COMPLETE: 0 },
    });

    const recordInput: UserRecordCreateInput = {
      opId: "typed-ui-record",
      kind: "FACT",
      title: "Typed record",
      summary: "Typed client retains record topic metadata.",
      topic: "client/typed-record",
      subjectKey: "candidate:not-a-work-item",
    };
    const record: RecordCreateReceipt = await client.recordAsUser("CLI", recordInput);
    expect(record).toMatchObject({ ok: 1, relatedRecords: [] });
    await expect(client.projects.records("CLI")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: record.key,
          topic: "client/typed-record",
          subjectKey: "candidate:not-a-work-item",
          relatedRecords: [],
        }),
      ]),
    );
    await expect(client.projects.recordPage("CLI", 1)).resolves.toMatchObject({
      items: [expect.objectContaining({ key: record.key, sourceType: "USER" })],
      nextCursor: null,
      hasMore: false,
    });

    for (let index = 0; index < 3; index += 1) {
      await client.recordAsUser("CLI", {
        opId: `typed-search-record-${index}`,
        kind: "FACT",
        title: `客户端分页关键字 ${index}`,
        summary: "真实 HTTP 与 typed client 往返 opaque cursor。",
      });
    }
    const firstSearch = await client.search("客户端分页关键字", "CLI", 1);
    expect(firstSearch).toMatchObject({
      hits: [expect.objectContaining({ entityType: "RECORD" })],
      hasMore: true,
      nextCursor: expect.stringMatching(/^s1\./u),
    });
    const secondSearch = await client.search("客户端分页关键字", "CLI", 1, firstSearch.nextCursor!);
    expect(secondSearch.hits[0]?.entityKey).not.toBe(firstSearch.hits[0]?.entityKey);
    await expect(
      client.search("错误查询", "CLI", 1, firstSearch.nextCursor!),
    ).rejects.toMatchObject<AyanamiClientError>({ code: "INVALID_CURSOR", status: 422 });
    await expect(client.search("客户端分页关键字", undefined, 1)).resolves.toMatchObject({
      hits: [expect.objectContaining({ project: "CLI" })],
      hasMore: true,
      nextCursor: expect.stringMatching(/^s1\./u),
    });
  });
});
