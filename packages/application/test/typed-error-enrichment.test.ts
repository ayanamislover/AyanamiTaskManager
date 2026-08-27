import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AtmError } from "@ayanami-task/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openService(): Promise<AyanamiTaskService> {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-typed-enrichment-"));
  temporary.push(dataDir);
  return AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
}

describe("typed error enrichment", () => {
  it("preserves required source details while adding project suggestions", async () => {
    const service = await openService();
    try {
      await service.createProject({ name: "CrossAgent Hub", sourcePath: null, code: "CAH" });
      const enriched = await service.enrichError(
        new AtmError("PROJECT_NOT_FOUND", {
          message: "项目不存在",
          details: { entity: "PROJECT", reference: "CrossAgent" },
        }),
      );

      expect(enriched.details).toMatchObject({
        entity: "PROJECT",
        reference: "CrossAgent",
        did_you_mean: "CAH",
      });
    } finally {
      service.close();
    }
  });

  it("returns the original project error when the suggestion index fails", async () => {
    const service = await openService();
    try {
      const original = new AtmError("PROJECT_NOT_FOUND", {
        message: "项目不存在",
        details: { entity: "PROJECT", reference: "missing" },
      });
      vi.spyOn(service.databases, "listProjects").mockImplementation(() => {
        throw new Error("candidate index unavailable");
      });

      await expect(service.enrichError(original)).resolves.toBe(original);
      expect(original.details).toEqual({ entity: "PROJECT", reference: "missing" });
    } finally {
      service.close();
    }
  });

  it("preserves generic source details and fails safe when entity suggestions fail", async () => {
    const service = await openService();
    try {
      const original = new AtmError("WORK_ITEM_NOT_FOUND", {
        message: "任务不存在",
        details: { entity: "WORK_ITEM", reference: "ATM-T-9999", source_marker: "keep" },
      });
      vi.spyOn(service, "notFoundSuggestionDetails").mockRejectedValue(
        new Error("candidate query unavailable"),
      );

      await expect(service.enrichError(original, { projectCode: "ATM" })).resolves.toBe(original);
      expect(original.details).toEqual({
        entity: "WORK_ITEM",
        reference: "ATM-T-9999",
        source_marker: "keep",
      });
    } finally {
      service.close();
    }
  });
});
