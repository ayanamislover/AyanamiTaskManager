import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectDataModal } from "../src/features/project-data-modal.js";

function client(): AyanamiClient {
  return {
    backups: { list: vi.fn(), create: vi.fn(), restore: vi.fn() },
    data: {
      exportProject: vi.fn(),
      previewAgentTask: vi.fn(),
      applyAgentTask: vi.fn(),
      importSources: vi.fn(),
      previewImport: vi.fn(),
      applyImport: vi.fn(),
    },
  } as unknown as AyanamiClient;
}

function render(sources: unknown): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["backups", "ATM"], []);
  queryClient.setQueryData(["import-sources"], sources);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectDataModal, {
        client: client(),
        project: "ATM",
        close: vi.fn(),
        notify: vi.fn(),
      }),
    ),
  );
}

describe("project data import", () => {
  it("lists packages and 2.x project backups, each with a preview entry", () => {
    const markup = render({
      packages: [
        {
          source: { kind: "PACKAGE", origin: "EXPORTS", name: "ALPHA-2026.aytproj" },
          name: "ALPHA-2026.aytproj",
          origin: "EXPORTS",
          sizeBytes: 4096,
          modifiedAt: "2026-10-09T00:00:00.000Z",
        },
        {
          source: { kind: "PACKAGE", origin: "LEGACY_EXPORTS", name: "OLD-2026.aytproj" },
          name: "OLD-2026.aytproj",
          origin: "LEGACY_EXPORTS",
          sizeBytes: 2048,
          modifiedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      legacyBackups: [
        {
          source: { kind: "LEGACY_BACKUP", id: "lb-p" },
          id: "lb-p",
          scope: "PROJECT",
          importable: "AS_PROJECT",
          project: "LEG",
          reason: "DAILY",
          sizeBytes: 1024,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        {
          source: { kind: "LEGACY_BACKUP", id: "lb-k" },
          id: "lb-k",
          scope: "KNOWLEDGE",
          importable: "AS_KNOWLEDGE",
          reason: "KNOWLEDGE_ONLY",
          sizeBytes: 1024,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    expect(markup).toContain("导入项目包");
    expect(markup).toContain("ALPHA-2026.aytproj");
    expect(markup).toContain("2.x 导出 · ");
    expect(markup).toContain("2.x 项目备份 · LEG · DAILY");
    // 知识库备份在设置页的知识库面板里合并，不在这里。
    expect(markup).not.toContain("KNOWLEDGE_ONLY");
    expect(markup.match(/>预览</g)?.length).toBe(3);
  });

  it("says where packages come from when there is nothing to import", () => {
    const markup = render({ packages: [], legacyBackups: [] });
    expect(markup).toContain("没有可导入的项目包");
    expect(markup).toContain("exports 文件夹");
    expect(markup).not.toContain('id="import-code"');
  });
});
