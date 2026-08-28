import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { AgentsPage } from "../src/features/agents.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "features", "agents.tsx");

function client(): AyanamiClient {
  return {
    projects: { agentPage: vi.fn() },
    sessions: { forceClose: vi.fn(), refreshGitContext: vi.fn() },
  } as unknown as AyanamiClient;
}

function missingAgentContracts(source: string): string[] {
  const contracts = [
    '.filter((project) => project.lifecycle === "ACTIVE")',
    "client.projects.agentPage(project.code, 100, cursor)",
    '["agents", "all", ...agentSources.map((source) => source.key)]',
    "client.sessions.forceClose(String(session.id), String(session.project), true)",
    "client.sessions.refreshGitContext(String(session.id), String(session.project))",
    'queryClient.invalidateQueries({ queryKey: ["agents"] })',
    'queryClient.invalidateQueries({ queryKey: ["overview"] })',
    "groupAgentSessions(allSessions)",
    "findAgentSessionConflicts(allSessions)",
    'window.confirm("关闭该异常 Session 并释放其任务领取？")',
    "data-agent-project={group.project}",
    "data-agent-id={session.agentId}",
    'aria-label="历史 Session"',
    "compactPath(session.git?.worktreeRoot)",
    "formatDuration(session.startedAt)",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Agents feature", () => {
  it("保持无项目时的 Agent 页面与空态 DOM", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AgentsPage, { client: client(), projects: [] }),
      ),
    );

    expect(markup).toContain("按项目与 Agent 身份聚合正式 Session");
    expect(markup).toContain("没有 Agent 会话");
    expect(markup).toContain("Agent 调用 atm_begin 后会在这里出现。");
  });

  it("分页、聚合、Git context 与 mutation 契约有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingAgentContracts(source)).toEqual([]);

    for (const contract of [
      "client.projects.agentPage(project.code, 100, cursor)",
      "client.sessions.refreshGitContext(String(session.id), String(session.project))",
      "groupAgentSessions(allSessions)",
      'window.confirm("关闭该异常 Session 并释放其任务领取？")',
    ]) {
      expect(missingAgentContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});
