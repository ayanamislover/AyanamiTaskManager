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
    'message: "关闭该异常 Session 并释放其任务领取？"',
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

    expect(markup).toContain("默认只显示在线和 7 天内活跃的 Agent");
    expect(markup).toContain("没有 Agent 会话");
    expect(markup).toContain("Agent 调用 atm_begin 后会在这里出现。");
  });

  it("有项目读失败、已读到的只有历史 Agent 时不下「最近 7 天没有活跃的 Agent」的结论", () => {
    const projects = ["ATM", "SEARCH"].map((code) => ({
      id: `id-${code}`,
      code,
      name: code,
      lifecycle: "ACTIVE",
    })) as any[];
    const render = (search: Record<string, unknown>) => {
      const queryClient = new QueryClient();
      const settled = (owner: string) => ({
        owner,
        items: [],
        hasMore: false,
        loading: false,
        error: null,
        cursor: undefined,
        seenCursors: [],
      });
      queryClient.setQueryData(["agents", "all", "ATM", "SEARCH", "ATM\u0000SEARCH"], {
        // 已读到的只有一个 30 天前的 Session：进历史，不算活跃。
        ATM: {
          ...settled("ATM"),
          items: [
            {
              id: "old-session",
              agentId: "old-agent",
              connectionState: "CLOSED",
              lastSeenAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
            },
          ],
        },
        SEARCH: { ...settled("SEARCH"), ...search },
      });
      return renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AgentsPage, { client: client(), projects }),
        ),
      );
    };
    const failed = render({ error: new Error("断了"), hasMore: true });
    expect(failed).not.toContain("<strong>最近 7 天没有活跃的 Agent</strong>");
    expect(failed).toContain("<strong>结果还不完整</strong>");
    expect(failed).toContain("已读到的部分里最近 7 天没有活跃的 Agent");
    // 全部读完、确实没有，才是确定性的空态。
    const complete = render({});
    expect(complete).toContain("<strong>最近 7 天没有活跃的 Agent</strong>");
    expect(complete).not.toContain("结果还不完整");
  });

  it("分页、聚合、Git context 与 mutation 契约有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingAgentContracts(source)).toEqual([]);

    for (const contract of [
      "client.projects.agentPage(project.code, 100, cursor)",
      "client.sessions.refreshGitContext(String(session.id), String(session.project))",
      "groupAgentSessions(allSessions)",
      'message: "关闭该异常 Session 并释放其任务领取？"',
    ]) {
      expect(missingAgentContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});
