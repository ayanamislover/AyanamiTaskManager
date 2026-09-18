import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const drawerPath = join(process.cwd(), "packages", "ui", "src", "features", "task-drawer.tsx");

function missingExecutionSessionContracts(source: string): string[] {
  const contracts = [
    '["task", project, taskKey, "execution-sessions"]',
    // 过滤在 SQL 里做：整表拉回来再前端筛，项目里三百多条 session 就是四个来回。
    "client.projects.agentPage(project, 100, cursor, taskKey)",
    "<h3>执行 Session</h3>",
    "session.displayName || session.agentId",
    "session.git?.branch",
    "session.git?.worktreeRoot",
    "session.git?.head",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("TaskDrawer execution sessions", () => {
  it("按当前任务读取并展示 Agent 与 Git 上下文", () => {
    const source = readFileSync(drawerPath, "utf8");
    expect(missingExecutionSessionContracts(source)).toEqual([]);

    for (const contract of [
      "client.projects.agentPage(project, 100, cursor, taskKey)",
      "session.git?.worktreeRoot",
    ]) {
      expect(missingExecutionSessionContracts(source.replaceAll(contract, "MUTATED"))).toContain(
        contract,
      );
    }
  });
});
