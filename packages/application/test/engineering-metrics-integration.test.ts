import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(directory: string, args: string[]): void {
  execFileSync("git", args, { cwd: directory, stdio: "ignore", windowsHide: true });
}

describe("工程统计应用集成", () => {
  it("任务开始建立 baseline，当前变更和项目快照写入独立项目库并可重启读取", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-metrics-integration-"));
    temporary.push(root);
    const sourcePath = join(root, "source");
    const dataDir = join(root, "data");
    mkdirSync(join(sourcePath, "src"), { recursive: true });
    writeFileSync(
      join(sourcePath, "package.json"),
      JSON.stringify({ dependencies: { react: "1" } }, null, 2),
    );
    writeFileSync(join(sourcePath, "src", "main.ts"), "export const main = 1;\n");
    git(sourcePath, ["init"]);
    git(sourcePath, ["config", "user.email", "atm@example.test"]);
    git(sourcePath, ["config", "user.name", "ATM Test"]);
    git(sourcePath, ["add", "-A"]);
    git(sourcePath, ["commit", "-m", "baseline"]);

    let service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "工程统计", sourcePath, code: "METR" });
    const objective = await service.createObjectiveAsUser("METR", "objective", {
      title: "落地统计",
      description: "",
      definitionOfDone: [],
    });
    const task = (
      await service.createWorkItemsAsUser("METR", "task", [
        {
          clientRef: "metrics",
          objectiveId: objective.id,
          title: "实现统计",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ])
    ).items[0]!;
    await service.patchWorkItemsAsUser("METR", "start", [
      {
        taskKey: task.key,
        expectedVersion: task.version,
        operation: "start",
      },
    ]);

    writeFileSync(
      join(sourcePath, "src", "main.ts"),
      "export const main = 1;\nexport const next = 2;\n",
    );
    writeFileSync(join(sourcePath, "src", "new.ts"), "export const created = true;\n");
    const result = await service.engineeringMetrics("METR", { taskKey: task.key, refresh: true });
    try {
      if (!result.available) throw new Error(`METRICS_UNAVAILABLE: ${JSON.stringify(result)}`);
      expect(result).toMatchObject({
        available: true,
        project: { sourceLoc: 3, dependencyCount: 1 },
        workItem: { taskKey: task.key, metrics: { filesCreated: 1, sourceLinesAdded: 2 } },
      });
    } finally {
      service.close();
    }

    service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      expect(await service.databases.latestProjectEngineeringMetrics("METR")).toMatchObject({
        sourceLoc: 3,
      });
      expect(await service.databases.workItemEngineeringMetrics("METR", task.key)).toMatchObject({
        baseline: expect.stringMatching(/^[0-9a-f]{40}$/u),
        metrics: { filesCreated: 1, sourceLinesAdded: 2 },
      });
    } finally {
      service.close();
    }
  });

  /**
   * 打开任务详情不该等 git。
   *
   * scanWorkItemChanges 要跑一串 git 子进程（ATM 自己的仓库实测 1.7 秒）而且是同步的：
   * 它一跑，daemon 这一整段时间什么请求都答不了——点开任务之所以慢，慢的不是任务本身，
   * 是它排在这次扫描后面。所以手里有一份就先给手里那份，新的放到这次响应之后再补。
   */
  it("已经有一份工程变更时不再当场重扫，只有 refresh 才重新扫", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-metrics-reuse-"));
    temporary.push(root);
    const sourcePath = join(root, "source");
    const dataDir = join(root, "data");
    mkdirSync(join(sourcePath, "src"), { recursive: true });
    writeFileSync(join(sourcePath, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(sourcePath, "src", "main.ts"), "export const main = 1;\n");
    git(sourcePath, ["init"]);
    git(sourcePath, ["config", "user.email", "atm@example.test"]);
    git(sourcePath, ["config", "user.name", "ATM Test"]);
    git(sourcePath, ["add", "-A"]);
    git(sourcePath, ["commit", "-m", "baseline"]);

    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "复用", sourcePath, code: "REUSE" });
      const objective = await service.createObjectiveAsUser("REUSE", "objective", {
        title: "目标",
        description: "",
        definitionOfDone: [],
      });
      const task = (
        await service.createWorkItemsAsUser("REUSE", "task", [
          {
            clientRef: "reuse",
            objectiveId: objective.id,
            title: "任务",
            description: "",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
            acceptance: [],
            checklist: [],
            verificationRequired: false,
          },
        ])
      ).items[0]!;

      writeFileSync(join(sourcePath, "src", "one.ts"), "export const one = 1;\n");
      const first = await service.engineeringMetrics("REUSE", {
        taskKey: task.key,
        refresh: true,
      });
      expect(first.workItem).toMatchObject({ metrics: { filesCreated: 1 } });

      // 盘上又多了一个文件，但这一次不许再扫：拿到的还是刚才存下的那一份。
      writeFileSync(join(sourcePath, "src", "two.ts"), "export const two = 2;\n");
      const reused = await service.engineeringMetrics("REUSE", { taskKey: task.key });
      expect(reused.workItem).toMatchObject({ metrics: { filesCreated: 1 } });

      // 明确要求刷新时才重新扫，这时才看得到第二个文件。
      const refreshed = await service.engineeringMetrics("REUSE", {
        taskKey: task.key,
        refresh: true,
      });
      expect(refreshed.workItem).toMatchObject({ metrics: { filesCreated: 2 } });
    } finally {
      service.close();
    }
  });
});
