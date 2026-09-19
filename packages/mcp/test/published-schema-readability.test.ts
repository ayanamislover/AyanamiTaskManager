import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createAyanamiMcpServer } from "../src/index.js";

/**
 * $defs 去重能省字节，但客户端解析 $ref 时会把被抽走的类型渲染成 {}——枚举和联合类型
 * 就此对 agent 不可见，只能靠试错。实测由此产生过：atm_record.kind 被猜成 FINDING、
 * atm_progress_add.scope 被猜成 TASK、atm_task_patch.items 被穷举六种形状。
 *
 * 三个 profile 目前都能完全内联，所以这里守住「不许出现 $ref」。core 余量只剩几十字节，
 * 加字段撑破预算时 publishedTools 会静默退回去重——那正是这条用例要拦下的静默回归。
 */
const SUPPORTED_PROFILES = ["core", "memory", "actions"] as const;

async function listProfile(profile: (typeof SUPPORTED_PROFILES)[number]): Promise<Tool[]> {
  const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile });
  const client = new Client({ name: `readability-${profile}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.listTools()).tools;
}

function tool(tools: Tool[], name: string): Record<string, unknown> {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`TOOL_NOT_PUBLISHED:${name}`);
  return found.inputSchema as unknown as Record<string, unknown>;
}

function property(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const value = properties?.[name];
  if (!value || typeof value !== "object") throw new Error(`PROPERTY_NOT_PUBLISHED:${name}`);
  return value as Record<string, unknown>;
}

function walkSchema(
  value: unknown,
  visit: (node: Record<string, unknown>, path: string) => void,
  path = "$input",
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkSchema(child, visit, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  visit(node, path);
  for (const [key, child] of Object.entries(node)) walkSchema(child, visit, `${path}.${key}`);
}

function assertPublishedEnumTypes(tools: Tool[]): void {
  const enumPaths: string[] = [];
  const missingTypes: string[] = [];
  for (const published of tools) {
    walkSchema(published.inputSchema, (node, path) => {
      if (!Array.isArray(node.enum)) return;
      enumPaths.push(`${published.name}${path}`);
      if (node.type !== "string") missingTypes.push(`${published.name}${path}`);
    });
  }
  if (enumPaths.length === 0) throw new Error("NO_ENUMS_TO_GUARD");
  if (missingTypes.length > 0) throw new Error(`ENUM_TYPE_MISSING:${missingTypes.join(",")}`);
}

function assertTaskPatchBranchContext(schema: Record<string, unknown>): void {
  const items = property(schema, "items");
  const itemSchema = items.items;
  if (!itemSchema || typeof itemSchema !== "object" || Array.isArray(itemSchema)) {
    throw new Error("TASK_PATCH_ITEMS_SCHEMA_MISSING");
  }
  const item = itemSchema as Record<string, unknown>;
  const branches = item.oneOf ?? item.anyOf;
  if (!Array.isArray(branches) || branches.length < 2) {
    throw new Error("TASK_PATCH_DISCRIMINATED_BRANCHES_MISSING");
  }
  for (const [index, candidate] of branches.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`TASK_PATCH_BRANCH_INVALID:${index}`);
    }
    const branch = candidate as Record<string, unknown>;
    const properties = branch.properties;
    const required = branch.required;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error(`TASK_PATCH_BRANCH_PROPERTIES_MISSING:${index}`);
    }
    if (!required || !Array.isArray(required)) {
      throw new Error(`TASK_PATCH_BRANCH_REQUIRED_MISSING:${index}`);
    }
    for (const field of ["task_key", "expected_version", "operation"]) {
      if (!(field in (properties as Record<string, unknown>))) {
        throw new Error(`TASK_PATCH_BRANCH_FIELD_MISSING:${index}:${field}`);
      }
    }
    if (
      !required.includes("task_key") ||
      !required.includes("expected_version") ||
      !required.includes("operation")
    ) {
      throw new Error(`TASK_PATCH_BRANCH_REQUIRED_FIELD_MISSING:${index}`);
    }
  }
}

describe("published schema readability", () => {
  it.each(SUPPORTED_PROFILES)(
    "%s 的工具 schema 不含 $ref，客户端能直接读到类型",
    async (profile) => {
      const serialized = JSON.stringify(await listProfile(profile));
      expect(serialized).not.toContain('"$ref"');
      expect(serialized).not.toContain('"$defs"');
    },
  );

  it.each(SUPPORTED_PROFILES)("%s 没有属性在客户端侧塌成 {}", async (profile) => {
    // 光查 `{}` 会空转：被抽进 $defs 的属性在 published 里是 {"$ref":…}，有一个键，
    // 客户端解析不到定义才渲染成 {}。两种形状都要算「对 agent 不可见」。
    const invisible: string[] = [];
    for (const published of await listProfile(profile)) {
      const properties = (published.inputSchema as unknown as Record<string, unknown>)
        .properties as Record<string, unknown>;
      for (const [name, value] of Object.entries(properties ?? {})) {
        if (!value || typeof value !== "object") continue;
        const keys = Object.keys(value);
        if (keys.length === 0 || (keys.length === 1 && keys[0] === "$ref")) {
          invisible.push(`${published.name}.${name}`);
        }
      }
    }
    expect(invisible).toEqual([]);
  });

  it("必填枚举对客户端可见", async () => {
    const memory = await listProfile("memory");
    expect(property(tool(memory, "atm_record"), "kind").enum).toEqual([
      "DECISION",
      "CONSTRAINT",
      "FACT",
      "RISK",
      "REFERENCE",
      "LESSON",
    ]);
    expect(property(tool(memory, "atm_progress_add"), "scope").enum).toEqual(["task", "project"]);
  });

  it.each(SUPPORTED_PROFILES)("%s 的每处 enum 都保留显式 string type", async (profile) => {
    assertPublishedEnumTypes(await listProfile(profile));
  });

  it("enum type 守卫在删掉兄弟 type 时验红", async () => {
    const memory = await listProfile("memory");
    const mutated = structuredClone(memory);
    const record = mutated.find((candidate) => candidate.name === "atm_record");
    if (!record) throw new Error("TOOL_NOT_PUBLISHED:atm_record");
    const kind = property(record.inputSchema as unknown as Record<string, unknown>, "kind");
    delete kind.type;
    expect(() => assertPublishedEnumTypes(mutated)).toThrow(/ENUM_TYPE_MISSING/u);
  });

  it("atm_task_patch 的检查项形状可从 schema 读出，不必靠试错", async () => {
    const actions = await listProfile("actions");
    const serialized = JSON.stringify(property(tool(actions, "atm_task_patch"), "items"));
    // 这三项正是 agent 反复问的：id 的键名、evidence 的类型、kind 的合法取值。
    expect(serialized).toContain('"checklist_items"');
    expect(serialized).toContain('"TODO","DOING","DONE","SKIPPED"');
    expect(serialized).toContain('"git_sha","atm_record","atm_task","test_result","url","file"');
  });

  it("atm_task_patch 的每个判别分支都带定位骨架和必填 operation", async () => {
    const actions = await listProfile("actions");
    const patch = tool(actions, "atm_task_patch");
    assertTaskPatchBranchContext(patch);

    const mutated = structuredClone(patch);
    const items = property(mutated, "items");
    const branches = ((items.items as Record<string, unknown>).oneOf ??
      (items.items as Record<string, unknown>).anyOf) as Record<string, unknown>[];
    delete (branches[0]!.properties as Record<string, unknown>).task_key;
    expect(() => assertTaskPatchBranchContext(mutated)).toThrow(/TASK_PATCH_BRANCH_FIELD_MISSING/u);
  });
});

/**
 * 即便 schema 里枚举完整发布了，客户端仍可能把枚举字段渲染成 {}——值到不了 agent 手里，
 * 只能靠试错。实例：本会话调 atm_begin 传 brief="delta"，报 expected one of
 * none|minimal|full，白花一个来回。description 是客户端必定渲染的字段，把值写进去能绕过
 * 渲染差异。合法值从已发布 schema 派生，所以枚举一改这条就红，不会和文案漂移。
 *
 * 只覆盖 memory：core 余量只剩 51 字节，付不起 atm_begin 的 brief/mode/role，
 * 那一批留给 ATM-T-0344 连同 profile 预算一起决策。
 */
const DISCOVERABLE_ENUMS = [
  { profile: "memory", tool: "atm_progress_add", field: "scope" },
  { profile: "memory", tool: "atm_progress_add", field: "health" },
  { profile: "memory", tool: "atm_record", field: "kind" },
  { profile: "memory", tool: "atm_feedback", field: "severity" },
] as const;

describe("枚举值必须能从 description 读到", () => {
  it.each(DISCOVERABLE_ENUMS)(
    "$tool.$field 的全部合法值出现在工具说明里",
    async ({ profile, tool: toolName, field }) => {
      const tools = await listProfile(profile);
      const published = tools.find((candidate) => candidate.name === toolName);
      if (!published) throw new Error(`TOOL_NOT_PUBLISHED:${toolName}`);
      const values = enumValues(property(published.inputSchema as any, field));
      // 阳性对照：字段确实还是闭合枚举。退化成自由字符串时这里先红，
      // 免得下面那条断言在一个空数组上永远通过。
      expect(values.length).toBeGreaterThan(1);
      for (const value of values)
        expect(published.description ?? "", `${toolName}.${field} 缺 ${value}`).toContain(value);
    },
  );
});

function enumValues(schema: Record<string, unknown>): string[] {
  const direct = schema.enum;
  if (Array.isArray(direct)) return direct.map(String);
  // nullable/optional 会被 zod 展开成 anyOf，枚举躲在其中一支里。
  for (const branch of (schema.anyOf ?? []) as Record<string, unknown>[]) {
    if (Array.isArray(branch?.enum)) return branch.enum.map(String);
  }
  throw new Error(`NOT_AN_ENUM:${JSON.stringify(schema).slice(0, 120)}`);
}
