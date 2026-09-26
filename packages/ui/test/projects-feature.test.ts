import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectWizard, ProjectsPage } from "../src/features/projects.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "features", "projects.tsx");

function client(): AyanamiClient {
  return {
    projects: {
      list: vi.fn(),
      trashed: vi.fn(),
      create: vi.fn(),
      restore: vi.fn(),
      createObjectiveAsUser: vi.fn(),
      createMilestoneAsUser: vi.fn(),
    },
    status: vi.fn(),
  } as unknown as AyanamiClient;
}

function project(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "project-id",
    code: "ATM",
    name: "AyanamiTaskManager",
    description: "任务管理器",
    lifecycle: "ACTIVE",
    sourcePaths: ["R:\\Project_All\\AyanamiTaskManager"],
    ...overrides,
  } as RegisteredProject;
}

function renderWithClient(queryClient: QueryClient, child: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, child));
}

function missingProjectContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["wizard-mcp-configs"]',
    'queryKey: ["projects"]',
    "sourcePath: form.path.trim() || null",
    'coordinationMode: form.mode as "SOLO" | "AUTO" | "MULTI"',
    "client.projects.createObjectiveAsUser(project.code, {",
    "client.projects.createMilestoneAsUser(project.code, {",
    "client.projects.restore(code)",
    'queryKey: ["projects", "trash"]',
    "client.projects.trashed()",
    "client.projects.approveRestoreRequest(id)",
    "client.projects.rejectRestoreRequest(id)",
    "await queryClient.invalidateQueries();",
    "onCreated(project.code)",
    "onProject(project.code)",
    "desktop!.getMcpConfigs!()",
    "desktop!.installMcp!(target)",
    "desktop.copyText!(configs.data!.stdio)",
    "await client.status()",
    "浏览器预览模式可创建项目；Agent 自动安装请在桌面应用设置中完成。",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Projects feature", () => {
  it("保持项目列表、垃圾箱恢复入口与 ProjectWizard 初始 DOM", () => {
    // 夹具照真实接口的形状：list() 不含 TRASHED，垃圾箱单独取数。原来这里把 TRASHED 塞进
    // ["projects"]，于是测试里恢复按钮看得见、真实界面里永远看不见（ATM-T-0492）。
    const queryClient = new QueryClient();
    queryClient.setQueryData(["projects"], [project()]);
    queryClient.setQueryData(
      ["projects", "trash"],
      [project({ id: "trashed-id", code: "OLD", name: "旧项目", lifecycle: "TRASHED" })],
    );

    const projectsMarkup = renderWithClient(
      queryClient,
      createElement(ProjectsPage, {
        client: client(),
        onProject: vi.fn(),
        notify: vi.fn(),
      }),
    );
    const wizardMarkup = renderWithClient(
      new QueryClient(),
      createElement(ProjectWizard, {
        client: client(),
        close: vi.fn(),
        notify: vi.fn(),
        onCreated: vi.fn(),
      }),
    );

    expect(projectsMarkup).toContain("每个正式项目拥有独立 SQLite 文件和可移动的路径别名。");
    expect(projectsMarkup).toContain("AyanamiTaskManager");
    expect(projectsMarkup).toContain("旧项目");
    expect(projectsMarkup).toContain("恢复项目");
    expect(projectsMarkup).toContain("垃圾箱（1）");
    expect(projectsMarkup).toContain('aria-label="恢复项目 旧项目"');
    // 垃圾箱默认折叠；恢复按钮在分区里，不在正常项目网格里。
    expect(projectsMarkup).toMatch(/id="project-trash-content" hidden=""/u);
    const [grid, trash] = projectsMarkup.split('aria-label="垃圾箱"');
    expect(grid).not.toContain("恢复项目");
    expect(trash).toContain("旧项目");
    expect(wizardMarkup).toContain('aria-labelledby="project-wizard-title"');
    expect(wizardMarkup).toContain("选择与配置");
    expect(wizardMarkup).toContain('id="project-name"');
  });

  // ATM-T-0494：Agent 撞上垃圾箱项目留下的请求，只能由用户在这里授权或拒绝。
  it("有 Agent 恢复请求时垃圾箱默认展开，卡片给出授权与拒绝", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["projects"], [project()]);
    queryClient.setQueryData(
      ["projects", "trash"],
      [
        {
          ...project({ id: "asked-id", code: "ASK", name: "被请求项目", lifecycle: "TRASHED" }),
          restoreRequest: {
            id: "request-1",
            projectId: "asked-id",
            requestedBy: "codex-agent",
            sourceCwd: "R:\\Project_All\\Asked",
            status: "PENDING",
            requestCount: 3,
            createdAt: "2026-09-26T00:00:00.000Z",
            updatedAt: "2026-09-26T00:00:00.000Z",
            decidedAt: null,
            decidedBy: null,
          },
        },
        {
          ...project({ id: "quiet-id", code: "QUIET", name: "安静项目", lifecycle: "TRASHED" }),
          restoreRequest: null,
        },
      ],
    );
    const markup = renderWithClient(
      queryClient,
      createElement(ProjectsPage, { client: client(), onProject: vi.fn(), notify: vi.fn() }),
    );
    const trash = markup.split('aria-label="垃圾箱"')[1] ?? "";
    expect(trash).toMatch(/id="project-trash-content">/u);
    expect(trash).toContain("1 个 Agent 恢复请求等待你授权");
    expect(trash).toContain("1 待授权");
    expect(trash).toContain("codex-agent 请求恢复这个项目");
    expect(trash).toContain("共 3 次");
    expect(trash).toContain('aria-label="授权恢复 被请求项目"');
    expect(trash).toContain('aria-label="拒绝恢复 被请求项目"');
    // 挂着请求的卡片用「授权恢复」代替「恢复项目」；没请求的卡片照旧。
    expect(trash).not.toContain('aria-label="恢复项目 被请求项目"');
    expect(trash).toContain('aria-label="恢复项目 安静项目"');
    expect(trash).not.toContain('aria-label="授权恢复 安静项目"');
  });

  it("垃圾箱为空时整块不出现", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["projects"], [project()]);
    queryClient.setQueryData(["projects", "trash"], []);
    const markup = renderWithClient(
      queryClient,
      createElement(ProjectsPage, { client: client(), onProject: vi.fn(), notify: vi.fn() }),
    );
    expect(markup).not.toContain("垃圾箱");
  });

  it("创建、恢复、桌面接入与路由契约有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingProjectContracts(source)).toEqual([]);

    for (const contract of [
      "sourcePath: form.path.trim() || null",
      "client.projects.restore(code)",
      "desktop!.installMcp!(target)",
      "onCreated(project.code)",
    ]) {
      expect(missingProjectContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});
