import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";
import { reconcileWorkItems } from "../src/reconcile.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function task(
  key: string,
  overrides: Partial<Parameters<typeof reconcileWorkItems>[0]["tasks"][number]> = {},
) {
  return {
    id: `id-${key}`,
    key,
    title: key,
    status: "READY",
    acceptance: [] as string[],
    claimedBySessionId: null,
    claimLeaseUntil: null,
    updatedAt: "2026-08-26T11:45:00.000Z",
    ...overrides,
  };
}

describe("只读工作项对账", () => {
  it("区分过期在线领取、已关闭停滞、可能已完成和正常活动项", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconcile-"));
    temporary.push(root);
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "release", "report.json"), "{}", "utf8");
    writeFileSync(join(root, "README.md"), "accepted", "utf8");

    const result = reconcileWorkItems({
      now: new Date("2026-08-26T12:00:00.000Z"),
      sourceRoot: root,
      tasks: [
        task("REC-T-0001", {
          status: "IN_PROGRESS",
          claimedBySessionId: "online-session",
          claimLeaseUntil: "2026-08-26T12:10:00.000Z",
        }),
        task("REC-T-0002", {
          status: "IN_PROGRESS",
          claimedBySessionId: "online-session",
          claimLeaseUntil: "2026-08-26T11:50:00.000Z",
        }),
        task("REC-T-0003", {
          status: "CLAIMED",
          claimedBySessionId: "closed-session",
          claimLeaseUntil: "2026-08-26T11:40:00.000Z",
        }),
        task("REC-T-0004", {
          acceptance: ["生成 `release/report.json`", "更新 `README.md`"],
        }),
        task("REC-T-0005", { acceptance: ["生成 `missing.json`"] }),
        task("REC-T-0006", { acceptance: ["更新 `release/report.json`"] }),
      ],
      sessions: [
        {
          id: "online-session",
          agentId: "agent-online",
          displayName: "在线 Agent",
          connectionState: "ONLINE",
          lastSeenAt: "2026-08-26T11:59:00.000Z",
          closedAt: null,
        },
        {
          id: "closed-session",
          agentId: "agent-closed",
          displayName: "已关闭 Agent",
          connectionState: "CLOSED",
          lastSeenAt: "2026-08-26T11:35:00.000Z",
          closedAt: "2026-08-26T11:36:00.000Z",
        },
      ],
      previouslyClaimedKeys: new Set(["REC-T-0006"]),
      includeActive: true,
    });

    expect(result.items.map(({ taskKey, classification }) => [taskKey, classification])).toEqual([
      ["REC-T-0001", "ACTIVE"],
      ["REC-T-0002", "LEASE_EXPIRED_ONLINE"],
      ["REC-T-0003", "STALLED"],
      ["REC-T-0004", "POSSIBLY_COMPLETE"],
      ["REC-T-0005", "ACTIVE"],
      ["REC-T-0006", "ACTIVE"],
    ]);
    expect(result.items[1]).toMatchObject({
      reason: "claim_lease_expired_but_session_online",
      ageSeconds: 600,
      session: { id: "online-session", connectionState: "ONLINE" },
    });
    expect(result.items[2]).toMatchObject({
      reason: "session_closed_and_lease_expired",
      ageSeconds: 1200,
      session: { id: "closed-session", connectionState: "CLOSED" },
    });
    expect(result.items[3]).toMatchObject({
      reason: "all_explicit_acceptance_paths_exist_and_never_claimed",
      evidencePaths: ["release/report.json", "README.md"],
    });
    for (const item of result.items) {
      expect(item.suggestedAction.length).toBeGreaterThan(5);
    }
    expect(result.attentionCount).toBe(3);
  });

  it("忽略 Node.js 和 v1.5 这类散文 token，仍用明确产物路径提示可能已完成", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconcile-prose-token-"));
    temporary.push(root);
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "release", "report.json"), "{}", "utf8");

    const result = reconcileWorkItems({
      now: new Date("2026-08-26T12:00:00.000Z"),
      sourceRoot: root,
      tasks: [
        task("REC-T-0007", {
          acceptance: ["支持 Node.js 24 与 v1.5 协议", "生成 `release/report.json`"],
        }),
      ],
      sessions: [],
      previouslyClaimedKeys: new Set(),
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        taskKey: "REC-T-0007",
        classification: "POSSIBLY_COMPLETE",
        reason: "all_explicit_acceptance_paths_exist_and_never_claimed",
        evidencePaths: ["release/report.json"],
      }),
    ]);
  });

  it("服务纵向切片读取历史领取和源码事实但不写项目事件", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconcile-service-"));
    temporary.push(root);
    const canonicalRoot = realpathSync.native(root);
    mkdirSync(join(root, "release"));
    writeFileSync(join(root, "release", "done.txt"), "done", "utf8");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
    git(["init"]);
    git(["config", "user.email", "atm@example.test"]);
    git(["config", "user.name", "ATM Test"]);
    git(["add", "release/done.txt"]);
    git(["commit", "-m", "fixture"]);
    const service = await AyanamiTaskService.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "对账", sourcePath: root, code: "RECS" });
      const objective = await service.createObjectiveAsUser("RECS", "reconcile-objective", {
        title: "对账",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser("RECS", "reconcile-tasks", [
        {
          clientRef: "stalled",
          objectiveId: objective.id,
          title: "停滞领取",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
        {
          clientRef: "artifact",
          objectiveId: objective.id,
          title: "已有产物",
          description: "",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: ["存在 `release/done.txt`"],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const begun = await service.begin({
        projectCode: "RECS",
        mode: "project",
        agentId: "stalled-agent",
        clientKind: "test",
      });
      await service.patchWorkItems("RECS", String(begun.session), "claim-stalled", [
        {
          taskKey: created.items[0]!.key,
          expectedVersion: created.items[0]!.version,
          operation: "claim",
        },
      ]);
      await service.forceCloseSessionAsUser("RECS", String(begun.session), false);
      const database = await service.databases.openProject("RECS");
      database.sqlite
        .prepare(
          "UPDATE work_items SET claim_lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        )
        .run(created.items[0]!.id);
      const sequenceBefore = (await service.delta("RECS", 0, 1)).currentSequence;

      const result = await service.reconcileProject("RECS");

      expect(result).toMatchObject({
        project: { code: "RECS", sourceRoot: canonicalRoot },
        attentionCount: 2,
      });
      expect(result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskKey: created.items[0]!.key, classification: "STALLED" }),
          expect.objectContaining({
            taskKey: created.items[1]!.key,
            classification: "POSSIBLY_COMPLETE",
          }),
        ]),
      );
      expect((await service.delta("RECS", 0, 1)).currentSequence).toBe(sequenceBefore);
      expect(await service.getWorkItem("RECS", created.items[0]!.key)).toMatchObject({
        status: "CLAIMED",
        claimedBySessionId: String(begun.session),
      });
    } finally {
      service.close();
    }
  });

  it("默认只返回需对账项，并拒绝缺失、点点越界和 junction 越界路径", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconcile-root-"));
    const outside = mkdtempSync(join(tmpdir(), "atm-reconcile-outside-"));
    temporary.push(root, outside);
    mkdirSync(join(root, "artifacts"));
    writeFileSync(join(root, "artifacts", "ok.txt"), "ok", "utf8");
    writeFileSync(join(outside, "outside.txt"), "outside", "utf8");
    symlinkSync(outside, join(root, "escaped"), "junction");

    const result = reconcileWorkItems({
      now: new Date("2026-08-26T12:00:00.000Z"),
      sourceRoot: root,
      tasks: [
        task("REC-T-0010", { acceptance: ["产物 `artifacts/ok.txt` 存在"] }),
        task("REC-T-0011", {
          acceptance: ["产物 `artifacts/ok.txt` 和 `artifacts/missing.txt` 存在"],
        }),
        task("REC-T-0012", {
          acceptance: [`产物 \`../${basename(outside)}/outside.txt\` 存在`],
        }),
        task("REC-T-0013", { acceptance: ["产物 `escaped/outside.txt` 存在"] }),
        task("REC-T-0014", { acceptance: ["不包含显式路径，仅描述行为"] }),
      ],
      sessions: [],
      previouslyClaimedKeys: new Set(),
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      taskKey: "REC-T-0010",
      classification: "POSSIBLY_COMPLETE",
    });
    expect(result.counts).toMatchObject({
      ACTIVE: 4,
      LEASE_EXPIRED_ONLINE: 0,
      STALLED: 0,
      POSSIBLY_COMPLETE: 1,
    });
    expect(result.attentionCount).toBe(1);
    expect(resolve(root, `../${basename(outside)}/outside.txt`)).not.toBe(
      resolve(root, "artifacts/ok.txt"),
    );
  });
});
