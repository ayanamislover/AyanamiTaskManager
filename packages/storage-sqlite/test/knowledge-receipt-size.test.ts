import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

it("新回执不重复正文；回放保持原版本/归档语义并兼容旧完整回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "atm-compact-knowledge-"));
  const manager = await AyanamiDatabaseManager.open({
    dataDir: root,
    migrationsRoot: resolve("migrations"),
  });
  try {
    const repository = await manager.knowledge.open();
    const input = {
      opId: "large",
      expectedVersion: 0,
      slug: "large",
      title: "大正文",
      summary: "回执",
      bodyMarkdown: "x".repeat(500000),
    };
    const original = repository.save(input);
    const row = repository.database.sqlite
      .prepare("SELECT receipt FROM knowledge_operations WHERE op_id=?")
      .get("large") as { receipt: string };
    expect(row.receipt.length).toBeLessThan(1000);
    expect(row.receipt).not.toContain("bodyMarkdown");
    const changed = repository.save({
      ...input,
      opId: "update",
      id: original.id,
      expectedVersion: 1,
      expectedRevisionId: original.revisionId,
      bodyMarkdown: "new",
    });
    repository.archive({
      id: original.id,
      opId: "archive",
      expectedVersion: changed.version,
      expectedRevisionId: changed.revisionId,
      archived: true,
    });
    expect(repository.save(input)).toEqual(original);
    repository.database.sqlite
      .prepare("UPDATE knowledge_operations SET receipt=? WHERE op_id='large'")
      .run(JSON.stringify(original));
    expect(repository.save(input)).toEqual(original);
    expect(() => repository.save({ ...input, title: "changed payload" })).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("历史查询在 SQLite 中移除正文，进入 JS 的 JSON 不含大正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "atm-history-projection-"));
  const manager = await AyanamiDatabaseManager.open({
    dataDir: root,
    migrationsRoot: resolve("migrations"),
  });
  try {
    const repository = await manager.knowledge.open();
    const saved = repository.save({
      opId: "create",
      expectedVersion: 0,
      slug: "history",
      title: "历史",
      summary: "元数据",
      bodyMarkdown: "x".repeat(500000),
    });
    const parse = vi.spyOn(JSON, "parse");
    const page = repository.history(saved.id);
    const inputs = parse.mock.calls.map(([text]) => String(text));
    parse.mockRestore();
    expect(page.revisions).toHaveLength(1);
    expect(page.revisions[0]).not.toHaveProperty("bodyMarkdown");
    expect(inputs.some((text) => text.includes('"bodyMarkdown"'))).toBe(false);
    expect(Math.max(...inputs.map((text) => text.length))).toBeLessThan(1000);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
