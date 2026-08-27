import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AyanamiTaskService } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("Session begin identity", () => {
  it("does not build a legacy brief while creating the Session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-application-begin-identity-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Begin identity",
      sourcePath: null,
      code: "BEGIDN",
    });
    const legacyBrief = vi.spyOn(ProjectRepository.prototype, "brief");
    try {
      const result = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "begin-identity-agent",
        operationId: "begin-identity-operation",
        maxChars: 5000,
      });

      expect(legacyBrief).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        scope: "project",
        project: project.code,
        session: expect.stringMatching(/^01/u),
        atomicBegin: { operationId: "begin-identity-operation", disposition: "CREATED" },
      });
    } finally {
      service.close();
    }
  });
});
