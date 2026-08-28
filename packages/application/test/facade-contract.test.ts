import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as application from "../src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const EXPECTED_EXPORTS = [
  "AyanamiTaskService",
  "explicitAcceptancePaths",
  "parseAgentTaskMarkdown",
  "projectTaskView",
  "reconcileWorkItems",
] as const;
const EXPECTED_STATIC_METHODS = ["open"] as const;
const EXPECTED_PROTOTYPE_METHODS = [
  "addProgress",
  "addProjectProgress",
  "agentPage",
  "applyAgentTaskImport",
  "archiveProject",
  "assertMilestonesExist",
  "assertSessionCanProvisionPlanningRoot",
  "attachProjectPath",
  "begin",
  "brief",
  "briefSnapshot",
  "checklistConflictSnapshot",
  "close",
  "createBackup",
  "createMilestone",
  "createMilestoneAsUser",
  "createObjective",
  "createObjectiveAsUser",
  "createProject",
  "createQuickTask",
  "createRecord",
  "createRecordAsUser",
  "createReviewRequest",
  "createSavedView",
  "createWorkItems",
  "createWorkItemsAsUser",
  "deleteSavedView",
  "delta",
  "doctor",
  "draftProjectUpdateAsUser",
  "end",
  "engineeringMetrics",
  "enrichError",
  "ensurePlanningRoot",
  "exportProject",
  "forceCloseSessionAsUser",
  "getOperationTrace",
  "getProgressUpdate",
  "getProjectUpdate",
  "getRecord",
  "getReviewRequest",
  "getSession",
  "getSetting",
  "getWorkItem",
  "getWorkItemForUi",
  "globalDelta",
  "globalSearch",
  "listAgentSessionPage",
  "listAgentSessions",
  "listBackups",
  "listMilestones",
  "listObjectives",
  "listProjectUpdates",
  "listProjects",
  "listQuickTasks",
  "listRecords",
  "listSavedViews",
  "listSettings",
  "listWorkItemPage",
  "listWorkItemPageForUi",
  "listWorkItems",
  "listWorkItemsForUi",
  "notFoundSuggestionDetails",
  "overview",
  "patchWorkItems",
  "patchWorkItemsAsUser",
  "planningContext",
  "previewAgentTaskImport",
  "projectSuggestionDetails",
  "projectionState",
  "projectionStates",
  "projectionSummary",
  "promoteQuickTask",
  "publishProjectUpdateAsUser",
  "recentChecklistChanges",
  "recentWorkItemChanges",
  "reconcileProject",
  "reconcileProjectPage",
  "reconcileProjection",
  "reconcileProjections",
  "recordPage",
  "refreshSessionGitContextAsUser",
  "restoreBackup",
  "restoreProject",
  "runMaintenance",
  "search",
  "setSetting",
  "submitReview",
  "subscribeGlobal",
  "subscribeProject",
  "trashProject",
  "updateChecklist",
  "updateChecklistAsUser",
  "updateChecklistBatch",
  "updateChecklistBatchAsUser",
  "updateQuickTask",
  "updateSavedView",
  "verifyAndComplete",
  "verifyAndCompleteAsUser",
] as const;

type FacadeSurface = {
  exports: string[];
  staticDescriptors: Record<string, PropertyDescriptor | undefined>;
  prototypeDescriptors: Record<string, PropertyDescriptor | undefined>;
  instanceFunctions: string[];
};

function methodDescriptorViolations(
  scope: "static" | "prototype",
  expected: readonly string[],
  descriptors: Record<string, PropertyDescriptor | undefined>,
): string[] {
  const violations: string[] = [];
  const actual = Object.entries(descriptors)
    .filter(([, descriptor]) => typeof descriptor?.value === "function")
    .map(([name]) => name)
    .filter((name) => name !== "constructor")
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    violations.push(`${scope} methods changed`);
  }
  for (const name of expected) {
    const descriptor = descriptors[name];
    if (
      typeof descriptor?.value !== "function" ||
      descriptor.enumerable !== false ||
      descriptor.writable !== true ||
      descriptor.configurable !== true
    ) {
      violations.push(`${scope} descriptor changed: ${name}`);
    }
  }
  return violations;
}

function facadeContractViolations(surface: FacadeSurface): string[] {
  const violations: string[] = [];
  if (
    JSON.stringify([...surface.exports].sort()) !== JSON.stringify([...EXPECTED_EXPORTS].sort())
  ) {
    violations.push("package exports changed");
  }
  violations.push(
    ...methodDescriptorViolations("static", EXPECTED_STATIC_METHODS, surface.staticDescriptors),
    ...methodDescriptorViolations(
      "prototype",
      EXPECTED_PROTOTYPE_METHODS,
      surface.prototypeDescriptors,
    ),
  );
  if (surface.instanceFunctions.length > 0) {
    violations.push(`instance functions added: ${surface.instanceFunctions.join(",")}`);
  }
  return violations;
}

function surfaceOf(service: application.AyanamiTaskService): FacadeSurface {
  return {
    exports: Object.keys(application),
    staticDescriptors: Object.getOwnPropertyDescriptors(application.AyanamiTaskService),
    prototypeDescriptors: Object.getOwnPropertyDescriptors(
      application.AyanamiTaskService.prototype,
    ),
    instanceFunctions: Object.getOwnPropertyNames(service)
      .filter((name) => typeof (service as unknown as Record<string, unknown>)[name] === "function")
      .sort(),
  };
}

function compileTimeReadonlyDatabases(
  service: application.AyanamiTaskService,
  replacement: application.AyanamiTaskService["databases"],
): void {
  // @ts-expect-error databases is part of the facade as a readonly compatibility seam.
  service.databases = replacement;
}
void compileTimeReadonlyDatabases;

describe("AyanamiTaskService public facade contract", () => {
  it("freezes exact exports plus every static and prototype method descriptor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-facade-contract-"));
    temporary.push(dataDir);
    const service = await application.AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      expect(facadeContractViolations(surfaceOf(service))).toEqual([]);
    } finally {
      service.close();
    }
  });

  it("proves the guard rejects missing methods, instance arrows, and missing exports", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-facade-mutation-"));
    temporary.push(dataDir);
    const service = await application.AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const valid = surfaceOf(service);
      const missingMethod = {
        ...valid,
        prototypeDescriptors: { ...valid.prototypeDescriptors, overview: undefined },
      };
      const instanceArrow = { ...valid, instanceFunctions: ["overview"] };
      const missingExport = {
        ...valid,
        exports: valid.exports.filter((name) => name !== "reconcileWorkItems"),
      };

      expect(facadeContractViolations(missingMethod)).toContain("prototype methods changed");
      expect(facadeContractViolations(instanceArrow)).toContain(
        "instance functions added: overview",
      );
      expect(facadeContractViolations(missingExport)).toContain("package exports changed");
    } finally {
      service.close();
    }
  });
});
