import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

describe("Session Git context", () => {
  it("begin 使用本机事实覆盖自报值，并在有意义操作和手动刷新时更新", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-session-git-"));
    roots.push(root);
    const cwd = join(root, "repository");
    git(root, ["init", cwd]);
    git(cwd, ["config", "user.email", "atm@example.test"]);
    git(cwd, ["config", "user.name", "ATM Test"]);
    writeFileSync(join(cwd, "tracked.txt"), "baseline\n", "utf8");
    git(cwd, ["add", "tracked.txt"]);
    git(cwd, ["commit", "-m", "baseline"]);
    const canonicalCwd = realpathSync.native(cwd);

    const service = await AyanamiTaskService.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Session Git",
        sourcePath: cwd,
        code: "SGIT",
      });
      const begun = await service.begin({
        projectCode: project.code,
        cwd,
        agentId: "codex",
        gitBranch: "model/fabricated",
        gitHead: "fabricated",
      });
      const initial = (await service.listAgentSessions(project.code))[0]!;
      expect(initial).toMatchObject({
        id: begun.session,
        cwd,
        git_available: 1,
        git_dirty: 0,
        worktree_root: canonicalCwd,
      });
      expect(initial.git_branch).not.toBe("model/fabricated");
      expect(initial.git_head).toMatch(/^[0-9a-f]{40}$/u);

      const objective = await service.createObjective(project.code, begun.session, {
        title: "验证执行上下文",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItems(project.code, begun.session, "git-task", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          title: "执行 Git 上下文任务",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]);
      const started = await service.patchWorkItems(project.code, begun.session, "git-start", [
        {
          taskKey: created.items[0]!.key,
          expectedVersion: created.items[0]!.version,
          operation: "start",
        },
      ]);
      expect((await service.listAgentSessions(project.code))[0]).toMatchObject({
        current_task_key: started.items[0]!.key,
        work_state: "WORKING",
      });
      expect(
        (await service.getWorkItem(project.code, started.items[0]!.key, "context"))
          .executionSession,
      ).toMatchObject({ git_head: initial.git_head, worktree_root: canonicalCwd });

      writeFileSync(join(cwd, "tracked.txt"), "dirty\n", "utf8");
      await service.addProjectProgress(project.code, begun.session, "git-progress", {
        summary: "刷新 dirty 状态",
      });
      expect((await service.listAgentSessions(project.code))[0]).toMatchObject({ git_dirty: 1 });

      git(cwd, ["add", "tracked.txt"]);
      git(cwd, ["commit", "-m", "second"]);
      const refreshed = await service.refreshSessionGitContextAsUser(project.code, begun.session);
      expect(refreshed.session).toMatchObject({ git_dirty: 0 });
      expect(refreshed.session.git_head).not.toBe(initial.git_head);
    } finally {
      service.close();
    }
  });

  it("Git 观察失败不阻止 Session 创建", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-session-non-git-"));
    roots.push(root);
    const service = await AyanamiTaskService.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Non Git",
        sourcePath: null,
        code: "NGIT",
      });
      const begun = await service.begin({ projectCode: project.code, cwd: root, agentId: "codex" });
      expect(begun.session).toBeTruthy();
      expect((await service.listAgentSessions(project.code))[0]).toMatchObject({
        git_available: 0,
        git_error: "NOT_GIT",
      });
    } finally {
      service.close();
    }
  });
});
