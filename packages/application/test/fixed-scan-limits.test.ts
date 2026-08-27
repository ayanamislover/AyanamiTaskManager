import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project-level bounded scans", () => {
  it("returns the exact 521-item open count, first 20 keys, and durable truncation facts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-fixed-scan-open-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Fixed scan open items",
        sourcePath: null,
        code: "SCAN",
      });
      const begun = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "fixed-scan-agent",
        clientKind: "test",
      });
      const objective = await service.createObjectiveAsUser(project.code, "scan-objective", {
        title: "Fixed scan objective",
        description: "",
        definitionOfDone: [],
      });
      const created = [];
      for (let offset = 0; offset < 521; offset += 50) {
        const count = Math.min(50, 521 - offset);
        const batch = await service.createWorkItemsAsUser(
          project.code,
          `scan-batch-${offset}`,
          Array.from({ length: count }, (_, index) => ({
            clientRef: `task-${offset + index + 1}`,
            objectiveId: objective.id,
            title: `Active task ${String(offset + index + 1).padStart(3, "0")}`,
            type: "TASK",
            priority: "NORMAL",
            status: "READY" as const,
          })),
        );
        created.push(...batch.items);
      }

      const listSpy = vi.spyOn(ProjectRepository.prototype, "listWorkItems");
      const receipt = await service.addProjectProgress(
        project.code,
        String(begun.session),
        "scan-project-progress",
        {
          health: "ON_TRACK",
          summary: "Reported a completed external deliverable",
          completed: ["External deliverable"],
        },
      );

      expect(listSpy).not.toHaveBeenCalled();
      expect(receipt).toMatchObject({
        opId: "scan-project-progress",
        unlinked: true,
        openWorkItemCount: 521,
        openWorkItems: created.slice(0, 20).map((item) => item.key),
        openWorkItemsTruncated: true,
      });
      expect(
        await service.addProjectProgress(
          project.code,
          String(begun.session),
          "scan-project-progress",
          {
            health: "ON_TRACK",
            summary: "Reported a completed external deliverable",
            completed: ["External deliverable"],
          },
        ),
      ).toEqual(receipt);
      expect(
        (
          await service.getOperationTrace(
            project.code,
            "scan-project-progress",
            String(begun.session),
          )
        ).mutations[0]?.response,
      ).toMatchObject({
        openWorkItemCount: 521,
        openWorkItems: created.slice(0, 20).map((item) => item.key),
        openWorkItemsTruncated: true,
      });
      await expect(
        service.addProjectProgress(
          project.code,
          String(begun.session),
          "scan-project-progress-empty-completed",
          {
            health: "ON_TRACK",
            summary: "No completed entries in this update",
          },
        ),
      ).resolves.toMatchObject({
        unlinked: false,
        openWorkItemCount: 521,
        openWorkItems: created.slice(0, 20).map((item) => item.key),
        openWorkItemsTruncated: true,
      });
    } finally {
      service.close();
    }
  });

  it("returns exact NOT_FOUND candidate totals and explicit bounded SQL scan facts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-fixed-scan-candidates-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Fixed scan candidates",
        sourcePath: null,
        code: "CAND",
      });
      const objective = await service.createObjectiveAsUser(project.code, "candidate-objective", {
        title: "Candidate objective",
        description: "",
        definitionOfDone: [],
      });
      const created = [];
      for (let offset = 0; offset < 521; offset += 50) {
        const count = Math.min(50, 521 - offset);
        const batch = await service.createWorkItemsAsUser(
          project.code,
          `candidate-batch-${offset}`,
          Array.from({ length: count }, (_, index) => ({
            clientRef: `candidate-${offset + index + 1}`,
            objectiveId: objective.id,
            title: `Candidate ${String(offset + index + 1).padStart(3, "0")}`,
            type: "TASK",
            priority: "NORMAL",
            status: "READY" as const,
          })),
        );
        created.push(...batch.items);
      }

      const details = await service.notFoundSuggestionDetails(
        project.code,
        "WORK_ITEM_NOT_FOUND",
        `${project.code}-T-0522`,
      );
      expect(details).toMatchObject({
        entity: "WORK_ITEM",
        did_you_mean: created.at(-1)!.key,
        candidate_count: 521,
        candidate_scan_count: 50,
        candidate_scan_truncated: true,
        candidates_truncated: true,
      });
      expect(details?.candidates).toHaveLength(5);
    } finally {
      service.close();
    }
  });
});
