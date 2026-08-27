import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("REST Session page", () => {
  it("returns canonical camelCase page and rejects a tampered cursor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rest-session-page-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Session page",
      sourcePath: null,
      code: "SLREST",
    });
    for (let index = 0; index < 3; index += 1) {
      await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: `rest-agent-${index}`,
        role: "SUBAGENT",
      });
    }
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    try {
      const first = await app.inject({
        method: "GET",
        url: "/api/v1/projects/SLREST/agents?limit=2",
        headers: { authorization: "Bearer local-secret" },
      });
      expect(first.statusCode).toBe(200);
      const page = first.json() as Record<string, any>;
      expect(page).toMatchObject({
        items: expect.any(Array),
        nextCursor: expect.stringMatching(/^sl1\./u),
        hasMore: true,
      });
      expect(page.items[0]).toHaveProperty("agentId");
      expect(page.items[0]).toHaveProperty("lastSeenAt");
      expect(page.items[0]).toHaveProperty("git");
      expect(page.items[0]).not.toHaveProperty("agent_id");
      expect(page.items[0].git).toHaveProperty("repoRoot");

      const second = await app.inject({
        method: "GET",
        url: `/api/v1/projects/SLREST/agents?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as Record<string, any>).items).toHaveLength(1);

      const tampered = `${page.nextCursor.slice(0, -1)}${page.nextCursor.endsWith("a") ? "b" : "a"}`;
      const rejected = await app.inject({
        method: "GET",
        url: `/api/v1/projects/SLREST/agents?cursor=${encodeURIComponent(tampered)}`,
        headers: { authorization: "Bearer local-secret" },
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    } finally {
      await app.close();
      service.close();
    }
  });
});
