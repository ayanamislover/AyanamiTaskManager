import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import {
  createAyanamiMcpServer,
  createAyanamiToolRegistry,
  MCP_SURFACE_VERSION,
} from "../src/index.js";
import {
  generateMcpToolContractMarkdown,
  LEGACY_TOOL_LIST_ARTIFACT_BYTES,
  LEGACY_TOOL_LIST_ARTIFACT_SHA256,
  LEGACY_TOOL_LIST_SOURCE_COMMIT,
  normalizePublishedSchema,
  semanticSchemaHash,
} from "../src/tool-publication.js";

type PublishedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: {
    surface_version?: string;
    schema_hash?: string;
  };
};

function assertMetadataContract(tools: PublishedTool[]): void {
  for (const tool of tools) {
    if (!tool.description || !/^\S[^\r\n]*$/u.test(tool.description)) {
      throw new Error(`TOOL_DESCRIPTION_REQUIRED:${tool.name}`);
    }
    if (typeof tool.annotations?.readOnlyHint !== "boolean") {
      throw new Error(`TOOL_READ_ONLY_HINT_REQUIRED:${tool.name}`);
    }
    if (typeof tool.annotations?.destructiveHint !== "boolean") {
      throw new Error(`TOOL_DESTRUCTIVE_HINT_REQUIRED:${tool.name}`);
    }
    if (!/^v\d+$/u.test(tool._meta?.surface_version ?? "")) {
      throw new Error(`TOOL_SURFACE_VERSION_REQUIRED:${tool.name}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(tool._meta?.schema_hash ?? "")) {
      throw new Error(`TOOL_SCHEMA_HASH_REQUIRED:${tool.name}`);
    }
  }
}

async function list(profile: "core" | "memory" | "legacy") {
  const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile });
  const client = new Client({ name: `metadata-${profile}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const first = (await client.listTools()).tools as PublishedTool[];
  const second = (await client.listTools()).tools as PublishedTool[];
  return {
    first,
    second,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

describe("MCP tools/list metadata contract", () => {
  it.each(["core", "memory"] as const)(
    "%s publishes descriptions, safety annotations and stable schema identity",
    async (profile) => {
      const fixture = await list(profile);
      try {
        expect(fixture.first.length).toBeGreaterThan(0);
        expect(() => assertMetadataContract(fixture.first)).not.toThrow();
        expect(fixture.first.every((tool) => tool.outputSchema === undefined)).toBe(true);
        expect(fixture.first.every((tool) => tool.execution === undefined)).toBe(true);
        expect(
          fixture.second.map((tool) => ({
            name: tool.name,
            surfaceVersion: tool._meta?.surface_version,
            schemaHash: tool._meta?.schema_hash,
          })),
        ).toEqual(
          fixture.first.map((tool) => ({
            name: tool.name,
            surfaceVersion: tool._meta?.surface_version,
            schemaHash: tool._meta?.schema_hash,
          })),
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps legacy on the byte-for-byte v1.0.18 compatibility artifact", async () => {
    const fixture = await list("legacy");
    try {
      const serialized = JSON.stringify(fixture.first);
      expect(Buffer.byteLength(serialized, "utf8")).toBe(LEGACY_TOOL_LIST_ARTIFACT_BYTES);
      expect(createHash("sha256").update(serialized, "utf8").digest("hex")).toBe(
        LEGACY_TOOL_LIST_ARTIFACT_SHA256,
      );
      expect(fixture.first).toHaveLength(11);
      expect(fixture.first.every((tool) => tool._meta === undefined)).toBe(true);
      expect(LEGACY_TOOL_LIST_SOURCE_COMMIT).toBe("410969b7fed5f1837078f6731271bf6c18381faf");
    } finally {
      await fixture.close();
    }
  });

  it("metadata guard turns red for every required descriptor field", async () => {
    const fixture = await list("core");
    try {
      const mutations: Array<[string, (tool: PublishedTool) => void]> = [
        ["TOOL_DESCRIPTION_REQUIRED", (tool) => delete tool.description],
        ["TOOL_READ_ONLY_HINT_REQUIRED", (tool) => delete tool.annotations!.readOnlyHint],
        ["TOOL_DESTRUCTIVE_HINT_REQUIRED", (tool) => delete tool.annotations!.destructiveHint],
        ["TOOL_SURFACE_VERSION_REQUIRED", (tool) => delete tool._meta!.surface_version],
        ["TOOL_SCHEMA_HASH_REQUIRED", (tool) => delete tool._meta!.schema_hash],
      ];
      for (const [code, mutate] of mutations) {
        const changed = structuredClone(fixture.first);
        mutate(changed[0]!);
        expect(() => assertMetadataContract(changed)).toThrow(code);
      }
    } finally {
      await fixture.close();
    }
  });

  it("hash is key-order stable, semantic-sensitive and publication normalization is generic", () => {
    const first = {
      type: "object",
      properties: {
        alpha: { type: "string", maxLength: 20 },
        beta: { type: "string", enum: ["A", "B"] },
      },
      additionalProperties: false,
    };
    const reordered = {
      additionalProperties: false,
      properties: {
        beta: { enum: ["A", "B"], type: "string" },
        alpha: { maxLength: 20, type: "string" },
      },
      type: "object",
    };
    expect(semanticSchemaHash(first)).toBe(semanticSchemaHash(reordered));
    expect(semanticSchemaHash(first)).not.toBe(
      semanticSchemaHash({
        ...first,
        properties: { ...first.properties, alpha: { type: "string", maxLength: 21 } },
      }),
    );

    const normalized = normalizePublishedSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        choice: { type: "string", enum: ["A", "B"] },
        optional: { anyOf: [{ type: "string", maxLength: 8 }, { type: "null" }] },
      },
    });
    expect(normalized).toMatchObject({
      type: "object",
      properties: {
        choice: { enum: ["A", "B"] },
        optional: { type: ["string", "null"], maxLength: 8 },
      },
    });
    expect(normalized).not.toHaveProperty("$schema");

    for (const restricted of [
      { type: "string", enum: ["A"] },
      { type: "string", const: "A" },
    ]) {
      const nullableRestricted = normalizePublishedSchema({
        anyOf: [restricted, { type: "null" }],
      });
      expect(nullableRestricted).toHaveProperty("anyOf");
      expect(nullableRestricted).not.toHaveProperty("type");
      expect(nullableRestricted).not.toMatchObject({ enum: ["A"] });
      expect(nullableRestricted).not.toMatchObject({ const: "A" });
    }
  });

  it("keeps the generated contract page byte-for-byte aligned with the registry", () => {
    const generated = generateMcpToolContractMarkdown(
      createAyanamiToolRegistry({} as AyanamiTaskService),
      MCP_SURFACE_VERSION,
    );
    expect(readFileSync("docs/generated/mcp-tool-contracts.md", "utf8")).toBe(generated);
  });
});
