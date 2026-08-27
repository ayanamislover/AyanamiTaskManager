import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "@ayanami-task/mcp";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("typed error transport parity", () => {
  it("preserves the same project suggestion code/details through REST and MCP", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-typed-error-parity-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "CrossAgent Hub", sourcePath: null, code: "CAH" });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const mcpServer = createAyanamiMcpServer(service, { profile: "core" });
    const mcpClient = new Client({ name: "typed-error-parity", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const rest = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${encodeURIComponent("CrossAgent")}`,
        headers: { authorization: "Bearer local-secret" },
      });
      const restError = rest.json().error as {
        code: string;
        details: Record<string, unknown>;
      };
      const mcp = await mcpClient.callTool({
        name: "atm_task_list",
        arguments: { project: "CrossAgent" },
      });
      const mcpError = mcp.structuredContent as
        | { code?: string; details?: Record<string, unknown> }
        | undefined;

      expect(rest.statusCode).toBe(404);
      expect(mcp.isError).toBe(true);
      expect(mcpError).toEqual({
        code: restError.code,
        message: expect.any(String),
        details: restError.details,
        retryable: false,
      });
      expect(String((mcp.content[0] as { text?: unknown }).text)).not.toContain("MCP_DETAILS=");
    } finally {
      await Promise.all([mcpClient.close(), mcpServer.close()]);
      await app.close();
      service.close();
    }
  });
});

describe("typed error implementation guard", () => {
  const productionFiles = [
    "apps/daemon/src/index.ts",
    "packages/application/src/index.ts",
    "packages/client/src/index.ts",
    "packages/mcp/src/index.ts",
    "packages/storage-sqlite/src/manager.ts",
    "packages/storage-sqlite/src/project-repository.ts",
    "packages/storage-sqlite/src/search-pagination.ts",
  ];

  function forbiddenFindings(source: string): string[] {
    const patterns = [
      /error\.message\s*\.\s*(?:split|includes|indexOf|match)\s*\(/gu,
      /error\.message\s*\.\s*slice\s*\(\s*error\.message\.indexOf/gu,
      /MCP_DETAILS=/gu,
    ];
    return patterns.flatMap((pattern) => source.match(pattern) ?? []);
  }

  it("detects the legacy message protocol in its positive control", () => {
    expect(forbiddenFindings('error.message.split(":"); MCP_DETAILS=')).toHaveLength(2);
  });

  it("does not reparse business error fields from message text", () => {
    const findings = productionFiles.flatMap((file) =>
      forbiddenFindings(readFileSync(resolve(process.cwd(), file), "utf8")).map(
        (finding) => `${file}: ${finding}`,
      ),
    );
    expect(findings).toEqual([]);
  });

  it("has a single edit-distance implementation", () => {
    const files = [...productionFiles, "packages/errors/src/index.ts"];
    const declarations = files.flatMap((file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      return (source.match(/function\s+editDistance\s*\(/gu) ?? []).map(() => file);
    });
    expect(declarations).toEqual(["packages/errors/src/index.ts"]);
  });
});
