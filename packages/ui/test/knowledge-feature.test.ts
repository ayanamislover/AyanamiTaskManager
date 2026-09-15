import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "../src/features/knowledge.js";
import { KnowledgeBackupPanel } from "../src/features/knowledge-backup-panel.js";

const featurePath = join(process.cwd(), "packages", "ui", "src", "features", "knowledge.tsx");
const supportPath = join(
  process.cwd(),
  "packages",
  "ui",
  "src",
  "features",
  "knowledge-support.ts",
);
const detailPath = join(process.cwd(), "packages", "ui", "src", "features", "knowledge-detail.tsx");
const editorPath = join(process.cwd(), "packages", "ui", "src", "features", "knowledge-editor.tsx");
const stylePath = join(process.cwd(), "packages", "ui", "src", "styles", "features-knowledge.css");

function client(): AyanamiClient {
  return {
    knowledge: {
      search: vi.fn(),
      get: vi.fn(),
      history: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      previewRecord: vi.fn(),
    },
    backups: { list: vi.fn(), createKnowledge: vi.fn(), restore: vi.fn() },
  } as unknown as AyanamiClient;
}

function renderCatalog(): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["knowledge", "search", "", "", false, 0], {
    pages: [
      {
        hits: [
          {
            id: "knowledge-1",
            revision: 2,
            version: 2,
            slug: "sqlite-paths",
            title: "SQLite 路径约定",
            summary: "用于 Windows 路径校验。",
            useWhen: "迁移时",
            tags: ["sqlite"],
            appliesTo: ["Windows"],
            createdAt: "2026-09-14T00:00:00.000Z",
            archived: false,
          },
        ],
        hasMore: true,
        nextCursor: "k1.next.digest",
      },
    ],
    pageParams: [undefined],
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(KnowledgePage, { client: client(), notify: vi.fn() }),
    ),
  );
}

describe("Knowledge feature", () => {
  it("renders a global catalog with Markdown actions and no native select or HTML injection", () => {
    const markup = renderCatalog();
    expect(markup).toContain("知识库");
    expect(markup).toContain("SQLite 路径约定");
    expect(markup).toContain("导入 Markdown");
    expect(markup).toContain("导出 Markdown");
    expect(markup).toContain("加载更多知识");
    expect(markup).not.toMatch(/<select(?:\s|>)/u);
    expect(readFileSync(featurePath, "utf8")).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps knowledge page source contracts and visual styles", () => {
    const source = [featurePath, supportPath, detailPath, editorPath]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const styles = readFileSync(stylePath, "utf8");
    for (const contract of [
      "client.knowledge.search",
      "readFullEntry",
      "sourceVersion",
      "确认保存修订",
      "修订历史",
      "载入为新修订",
      "复制引用",
      "JSON.stringify(metadata, null, 2)",
      "results.fetchNextPage()",
      "saveOperation",
    ]) {
      expect(source).toContain(contract);
    }
    expect(styles).toContain(".atm-knowledge-layout");
    expect(styles).toContain(".atm-knowledge-markdown");
    expect(styles).toContain(".atm-knowledge-body-editor");
  });

  it("exposes the global KNOWLEDGE backup and restore entry in settings", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["backups", "knowledge"],
      [
        {
          id: "backup-1",
          scope: "KNOWLEDGE",
          reason: "MANUAL",
          sizeBytes: 2048,
          createdAt: "2026-09-14T00:00:00.000Z",
          verifiedAt: "2026-09-14T00:00:01.000Z",
        },
      ],
    );
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(KnowledgeBackupPanel, { client: client(), notify: vi.fn() }),
      ),
    );
    expect(markup).toContain('data-testid="knowledge-backup-panel"');
    expect(markup).toContain("知识库备份");
    expect(markup).toContain("MANUAL");
    expect(markup).toContain("恢复");
    const backupSource = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "features", "knowledge-backup-panel.tsx"),
      "utf8",
    );
    expect(backupSource).toContain('scope === "KNOWLEDGE"');
    expect(backupSource).toContain("createKnowledge");
    expect(backupSource).toContain("显示全部备份");
  });
});
