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
    // 描述被预算挤成半句话是真发生过的：atm_begin 曾经只有「直接使用返回的 brief」，
    // atm_brief 只有「仅在上下文压缩、长时间离开或明确恢复 working set」——两句都没说
    // 这个工具本身做什么。描述是所有 MCP 客户端都会显示、Agent 判断怎么调用的唯一依据，
    // 挤掉它省下的字节会以试错往返的形式加倍还回来。要求是完整的一句话。
    if (!tool.description.endsWith("。")) {
      throw new Error(`TOOL_DESCRIPTION_INCOMPLETE:${tool.name}`);
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
    if (!/^[a-f0-9]{16}$/u.test(tool._meta?.schema_hash ?? "")) {
      throw new Error(`TOOL_SCHEMA_HASH_REQUIRED:${tool.name}`);
    }
  }
}

async function list(profile: "core" | "memory" | "actions" | "legacy") {
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
  it.each(["core", "memory", "actions"] as const)(
    "%s publishes descriptions, safety annotations and stable schema identity",
    async (profile) => {
      const fixture = await list(profile);
      try {
        expect(fixture.first.length).toBeGreaterThan(0);
        expect(() => assertMetadataContract(fixture.first)).not.toThrow();
        expect(
          fixture.first.every(
            (tool) =>
              tool.outputSchema === undefined ||
              ["atm_knowledge_search", "atm_knowledge_get"].includes(tool.name),
          ),
        ).toBe(true);
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

  /**
   * 描述里写 `prop=a|b|c` 就必须和 schema 里的 enum 对得上。
   *
   * 枚举取值现在必须写进描述——实测有客户端把 `enum` 渲染成 `{}`，描述是唯一稳定的通道
   * （ATM-R-186）。但手抄一份取值就会漂：schema 加了一个取值、描述没跟上，调用方照着
   * 描述调就被拒，而且会以为是自己写错了。这条用例把两份钉在一起。
   */
  it("描述里点名的枚举取值与 schema 一致", async () => {
    let checked = 0;
    for (const profile of ["core", "memory", "actions"] as const) {
      const fixture = await list(profile);
      try {
        for (const tool of fixture.first) {
          const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
          for (const match of (tool.description ?? "").matchAll(/([a-z_]+)=([A-Za-z_|]{3,})/gu)) {
            const property = properties[match[1]!] as { enum?: unknown } | undefined;
            if (!Array.isArray(property?.enum)) continue;
            expect(match[2]!.split("|"), `${tool.name}.${match[1]}`).toEqual(property.enum);
            checked += 1;
          }
        }
      } finally {
        await fixture.close();
      }
    }
    // 正则写错就永远查不到东西、永远绿，所以确认真的比对过几处。
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  /**
   * guide 曾经写着「outcome 是 ATM 里唯一的小写枚举，其余枚举都是大写」。这句话是错的：
   * scope / view / operation 全是小写。而 guide 本轮又要求调用方优先信它，于是这个
   * 泛化会直接制造新的参数重试——调用方照着推断，把小写的 scope 写成大写。
   *
   * 前提从 schema 里数出来，不是手写的：只要小写枚举不止一个，那句话就不能出现。
   */
  it("guide 不把 outcome 说成唯一的小写枚举", async () => {
    const lowercase: string[] = [];
    for (const profile of ["core", "memory", "actions"] as const) {
      const fixture = await list(profile);
      try {
        const walk = (node: unknown, path: string): void => {
          if (!node || typeof node !== "object") return;
          const value = node as Record<string, unknown>;
          if (
            Array.isArray(value.enum) &&
            value.enum.length > 0 &&
            value.enum.every((each) => typeof each === "string" && /^[a-z][a-z_]*$/u.test(each))
          ) {
            lowercase.push(path);
          }
          for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
        };
        for (const tool of fixture.first) walk(tool.inputSchema, tool.name);
      } finally {
        await fixture.close();
      }
    }
    // 小写枚举不止一个，所以「唯一」这个说法本身就不成立。
    expect(lowercase.length).toBeGreaterThan(1);
    expect(readFileSync("ATM_AGENT_GUIDE.md", "utf8")).not.toContain("唯一的小写枚举");
  });

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
        ["TOOL_DESCRIPTION_INCOMPLETE", (tool) => (tool.description = "直接使用返回的 brief")],
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

  /**
   * 描述里写枚举取值时惯用 `a|b|c`，而表格的列分隔符也是 `|`：不转义的话那一行会被切成
   * 十几列，页面上整张表当场散架，而逐字节对比的用例照样全绿——它比的是两边一样，
   * 不是比出来的东西还算不算一张表。
   */
  it("contract 表格的每一行列数一致，描述里的竖线不会把表切开", () => {
    const generated = generateMcpToolContractMarkdown(
      createAyanamiToolRegistry({} as AyanamiTaskService),
      MCP_SURFACE_VERSION,
    );
    const rows = generated
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| --"));
    expect(rows.length).toBeGreaterThan(10);
    const columns = rows.map((row) => row.replace(/\\\|/gu, "").split("|").length);
    // 表头三列的那张与六列的那张各自内部一致，合起来只应出现两种列数。
    expect([...new Set(columns)].sort((left, right) => left - right)).toEqual([5, 8]);
  });
});
