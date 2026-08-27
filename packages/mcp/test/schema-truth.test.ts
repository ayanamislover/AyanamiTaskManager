import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { createAyanamiMcpServer } from "../src/index.js";
import { assertMcpSchemaBudget, mcpSchemaBytes } from "../src/schema-budget.js";

type JsonObject = Record<string, any>;
type ListedTool = { name: string; inputSchema: JsonObject };
type RuntimeSchemas = Record<string, z.ZodType>;

const publicFields: Record<string, readonly string[]> = {
  atm_begin: [
    "op_id",
    "cwd",
    "project_code",
    "title",
    "mode",
    "agent_id",
    "display_name",
    "client_kind",
    "thread_id",
    "parent_session_id",
    "resume",
    "brief",
    "max_chars",
    "predecessor_session_id",
    "role",
    "signals",
    "allow_project_create",
    "creation_reason",
  ],
  atm_brief: [
    "project_code",
    "session_id",
    "task_key",
    "since_seq",
    "cursor",
    "max_chars",
    "include",
  ],
  atm_task_list: [
    "project",
    "status",
    "owner",
    "parent_key",
    "milestone_id",
    "ready_only",
    "query",
    "limit",
    "cursor",
    "view",
    "include_active",
    "field_mask",
    "max_chars",
  ],
  atm_task_get: ["project", "task_key", "view", "field_mask", "cursor", "max_chars"],
  atm_task_create: ["project", "session", "op_id", "items"],
  atm_task_patch: ["project", "session", "op_id", "items"],
  atm_progress_add: [
    "project",
    "session",
    "op_id",
    "scope",
    "task_key",
    "summary",
    "percent",
    "completed",
    "evidence",
    "health",
    "blocker",
    "next",
  ],
  atm_record: [
    "project",
    "session",
    "op_id",
    "kind",
    "title",
    "summary",
    "detail",
    "work_item_key",
    "supersedes",
    "topic",
    "subject_key",
    "importance",
    "scope",
  ],
  atm_search: [
    "project",
    "query",
    "op_id",
    "session",
    "limit",
    "cursor",
    "field_mask",
    "max_chars",
  ],
  atm_delta: ["project", "since_seq", "limit", "types", "max_chars"],
  atm_end: [
    "project",
    "session",
    "op_id",
    "outcome",
    "summary",
    "next",
    "release_claims",
    "retirement_reason",
  ],
};

const createItemFields = [
  "client_ref",
  "objective_id",
  "milestone_id",
  "parent_key",
  "parent_ref",
  "depends_on",
  "depends_on_refs",
  "discovered_from",
  "discovered_from_ref",
  "title",
  "description",
  "type",
  "priority",
  "status",
  "acceptance",
  "checklist",
  "weight",
  "target_date",
  "verification_required",
  "assignee_agent_id",
] as const;

const patchItemFields = [
  "task_key",
  "expected_version",
  "expected_fields",
  "operation",
  "title",
  "description",
  "blocked_reason",
  "waiting_for",
  "cancel_reason",
  "duplicate_of",
  "superseded_by",
  "assignee_agent_id",
  "target_date",
  "parent_key",
  "takeover_stale",
  "parent_checklist_id",
  "expected_parent_checklist_version",
  "request_key",
  "candidate_hashes",
  "verdict",
  "evidence",
  "checklist_items",
] as const;

const nestedFieldSets: Array<{
  tool: string;
  path: string[];
  expected: readonly string[];
  label: string;
}> = [
  {
    tool: "atm_task_create",
    path: ["properties", "items", "items"],
    expected: createItemFields,
    label: "create.items",
  },
  {
    tool: "atm_task_create",
    path: ["properties", "items", "items", "properties", "checklist", "items"],
    expected: ["title", "evidence_required", "weight"],
    label: "create.items.checklist",
  },
  {
    tool: "atm_task_patch",
    path: ["properties", "items", "items"],
    expected: patchItemFields,
    label: "patch.items",
  },
  {
    tool: "atm_task_patch",
    path: ["properties", "items", "items", "properties", "expected_fields"],
    expected: ["title", "description", "target_date", "parent_key"],
    label: "patch.items.expected_fields",
  },
  {
    tool: "atm_task_patch",
    path: ["properties", "items", "items", "properties", "evidence", "items"],
    expected: ["kind", "value", "note"],
    label: "patch.items.evidence",
  },
  {
    tool: "atm_task_patch",
    path: ["properties", "items", "items", "properties", "checklist_items", "items"],
    expected: ["id", "status", "evidence"],
    label: "patch.items.checklist_items",
  },
  {
    tool: "atm_progress_add",
    path: ["properties", "completed", "items", "anyOf", "1"],
    expected: ["text", "work_item_key"],
    label: "progress.completed",
  },
  {
    tool: "atm_progress_add",
    path: ["properties", "evidence", "items", "anyOf", "1"],
    expected: ["kind", "value", "note"],
    label: "progress.evidence",
  },
];

function at(root: unknown, path: readonly string[]): any {
  let current = root as any;
  for (const segment of path) current = current?.[segment];
  return current;
}

function assertFieldSet(schema: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(schema.properties ?? {});
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`PUBLIC_FIELD_SET_MISMATCH:${label}:${JSON.stringify(actual)}`);
  }
}

function assertPublicSurface(tools: ListedTool[]): void {
  for (const [toolName, expected] of Object.entries(publicFields)) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MISSING_PUBLIC_TOOL:${toolName}`);
    assertFieldSet(tool.inputSchema, expected, toolName);
  }
  for (const fieldSet of nestedFieldSets) {
    const schema = tools.find((tool) => tool.name === fieldSet.tool)!.inputSchema;
    assertFieldSet(
      dereference(at(schema, fieldSet.path), schema),
      fieldSet.expected,
      fieldSet.label,
    );
  }
}

function dereference(schema: JsonObject, root: JsonObject): JsonObject {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  return schema.$ref
    .slice(2)
    .split("/")
    .reduce((value: any, segment: string) => value?.[segment], root) as JsonObject;
}

function semanticConstraints(schema: JsonObject, runtime: boolean): Map<string, string> {
  const constraints = new Map<string, string>();
  const visit = (candidate: JsonObject, root: JsonObject, path: string): void => {
    const node = dereference(candidate, root);
    const simpleUnionTypes = Array.isArray(node.anyOf)
      ? node.anyOf.map((branch: JsonObject) => branch?.type)
      : [];
    const hasSimpleTypeUnion =
      simpleUnionTypes.length > 0 &&
      simpleUnionTypes.every((type: unknown) => typeof type === "string") &&
      node.anyOf.every(
        (branch: JsonObject) => branch.enum === undefined && branch.const === undefined,
      ) &&
      simpleUnionTypes.includes("null");
    if (Array.isArray(node.enum)) constraints.set(`${path}#enum`, JSON.stringify(node.enum));
    if (node.const !== undefined) constraints.set(`${path}#const`, JSON.stringify(node.const));
    if (
      (node.type !== undefined || hasSimpleTypeUnion) &&
      node.enum === undefined &&
      node.const === undefined
    ) {
      constraints.set(`${path}#type`, JSON.stringify(node.type ?? simpleUnionTypes));
    }
    if (typeof node.additionalProperties === "boolean") {
      constraints.set(`${path}#additionalProperties`, JSON.stringify(node.additionalProperties));
    } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, root, `${path}.*`);
    }
    if (node.properties && typeof node.properties === "object") {
      const required = Array.isArray(node.required)
        ? node.required.filter(
            (field: string) =>
              !runtime ||
              !(
                node.properties[field] &&
                typeof node.properties[field] === "object" &&
                "default" in node.properties[field]
              ),
          )
        : [];
      if (required.length > 0) constraints.set(`${path}#required`, JSON.stringify(required));
      for (const [field, child] of Object.entries(node.properties)) {
        visit(child as JsonObject, root, `${path}.${field}`);
      }
    }
    if (node.items && typeof node.items === "object") visit(node.items, root, `${path}[]`);
    if (Array.isArray(node.anyOf) && !hasSimpleTypeUnion) {
      node.anyOf.forEach((branch: JsonObject, index: number) =>
        visit(branch, root, `${path}.anyOf[${index}]`),
      );
    }
  };
  visit(schema, schema, "$input");
  return constraints;
}

function assertRuntimeSemantics(runtimeSchemas: RuntimeSchemas, tools: ListedTool[]): void {
  for (const tool of tools) {
    const runtimeSchema = runtimeSchemas[tool.name];
    if (!runtimeSchema) throw new Error(`MISSING_RUNTIME_SCHEMA:${tool.name}`);
    const runtime = semanticConstraints(z.toJSONSchema(runtimeSchema) as JsonObject, true);
    const published = semanticConstraints(tool.inputSchema, false);
    for (const [path, expected] of runtime) {
      const actual = published.get(path);
      if (actual !== expected) {
        throw new Error(`SCHEMA_SEMANTIC_MISMATCH:${tool.name}:${path}:${actual ?? "missing"}`);
      }
    }
  }
}

const expectedManualConditions = {
  patchDependent: { expected_fields: { properties: { operation: { const: "edit" } } } },
  patchExpectedFieldsMinProperties: 1,
  patchChecklistMinItems: 1,
  patchAllOf: [
    {
      if: { properties: { operation: { const: "block" } } },
      then: { required: ["blocked_reason"] },
    },
    {
      if: { properties: { operation: { enum: ["wait_user", "wait_agent"] } } },
      then: { required: ["waiting_for"] },
    },
    {
      if: { properties: { operation: { const: "review_request" } } },
      then: {
        required: ["parent_checklist_id", "expected_parent_checklist_version", "candidate_hashes"],
        propertyNames: {
          enum: [
            "task_key",
            "expected_version",
            "takeover_stale",
            "operation",
            "parent_checklist_id",
            "expected_parent_checklist_version",
            "candidate_hashes",
          ],
        },
      },
    },
    {
      if: { properties: { operation: { const: "review_submit" } } },
      then: {
        required: ["request_key", "verdict", "candidate_hashes", "evidence"],
        propertyNames: {
          enum: [
            "task_key",
            "expected_version",
            "takeover_stale",
            "operation",
            "request_key",
            "verdict",
            "candidate_hashes",
            "evidence",
          ],
        },
      },
    },
    {
      if: { properties: { operation: { const: "checklist_single" } } },
      then: {
        required: ["checklist_items"],
        properties: { checklist_items: { maxItems: 1 } },
        propertyNames: {
          enum: ["task_key", "expected_version", "takeover_stale", "operation", "checklist_items"],
        },
      },
    },
    {
      if: { properties: { operation: { const: "checklist_batch" } } },
      then: {
        required: ["checklist_items"],
        propertyNames: {
          enum: ["task_key", "expected_version", "takeover_stale", "operation", "checklist_items"],
        },
      },
    },
    {
      if: { properties: { operation: { const: "verify_and_complete" } } },
      then: {
        propertyNames: {
          enum: ["task_key", "expected_version", "takeover_stale", "operation"],
        },
      },
    },
  ],
  patchRootAllOf: [
    {
      if: {
        properties: {
          items: {
            contains: {
              properties: {
                operation: {
                  enum: [
                    "verify_and_complete",
                    "review_request",
                    "review_submit",
                    "checklist_single",
                    "checklist_batch",
                  ],
                },
              },
            },
          },
        },
      },
      then: { properties: { items: { maxItems: 1 } } },
    },
  ],
  progressAllOf: [
    {
      if: { properties: { scope: { const: "task" } } },
      then: { required: ["task_key"], not: { required: ["health"] } },
    },
    {
      if: { properties: { scope: { const: "project" } } },
      then: { not: { required: ["percent"] } },
    },
  ],
  searchAnyOf: [{ required: ["query"] }, { required: ["op_id"] }],
  searchDependentRequired: { session: ["op_id"] },
};

function assertManualConditions(tools: ListedTool[]): void {
  const patch = at(tools.find((tool) => tool.name === "atm_task_patch")!.inputSchema, [
    "properties",
    "items",
    "items",
  ]);
  for (const [label, actual, expected] of [
    ["patch.dependentSchemas", patch.dependentSchemas, expectedManualConditions.patchDependent],
    [
      "patch.expected_fields.minProperties",
      patch.properties.expected_fields.minProperties,
      expectedManualConditions.patchExpectedFieldsMinProperties,
    ],
    [
      "patch.checklist_items.minItems",
      patch.properties.checklist_items.minItems,
      expectedManualConditions.patchChecklistMinItems,
    ],
    ["patch.allOf", patch.allOf, expectedManualConditions.patchAllOf],
    [
      "patch.root.allOf",
      tools.find((tool) => tool.name === "atm_task_patch")!.inputSchema.allOf,
      expectedManualConditions.patchRootAllOf,
    ],
    [
      "progress.allOf",
      tools.find((tool) => tool.name === "atm_progress_add")!.inputSchema.allOf,
      expectedManualConditions.progressAllOf,
    ],
    [
      "search.anyOf",
      tools.find((tool) => tool.name === "atm_search")!.inputSchema.anyOf,
      expectedManualConditions.searchAnyOf,
    ],
    [
      "search.dependentRequired",
      tools.find((tool) => tool.name === "atm_search")!.inputSchema.dependentRequired,
      expectedManualConditions.searchDependentRequired,
    ],
  ] as const) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`MANUAL_CONDITION_MISMATCH:${label}`);
    }
  }
}

async function listedTools(): Promise<{
  tools: ListedTool[];
  profiles: ListedTool[][];
  runtimeSchemas: RuntimeSchemas;
  close: () => Promise<void>;
}> {
  const fixtures = await Promise.all(
    (["core", "memory"] as const).map(async (profile) => {
      const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile });
      const registered = (
        server as unknown as { _registeredTools: Record<string, { inputSchema: z.ZodType }> }
      )._registeredTools;
      const client = new Client({ name: `schema-truth-${profile}`, version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = (await client.listTools()).tools as ListedTool[];
      return { server, client, registered, tools };
    }),
  );
  const tools = fixtures.flatMap((fixture) => fixture.tools);
  const activeNames = new Set(tools.map((tool) => tool.name));
  const runtimeSchemas = Object.fromEntries(
    Object.entries(fixtures[0]!.registered)
      .filter(([name]) => activeNames.has(name))
      .map(([name, tool]) => [name, tool.inputSchema]),
  );
  return {
    tools,
    profiles: fixtures.map((fixture) => fixture.tools),
    runtimeSchemas,
    close: async () => {
      await Promise.all(
        fixtures.flatMap((fixture) => [fixture.client.close(), fixture.server.close()]),
      );
    },
  };
}

describe("MCP public/runtime schema truth", () => {
  it("publishes every supported property and the exact conditional contracts within budget", async () => {
    const fixture = await listedTools();
    try {
      expect(() => assertPublicSurface(fixture.tools)).not.toThrow();
      expect(() => assertRuntimeSemantics(fixture.runtimeSchemas, fixture.tools)).not.toThrow();
      expect(() => assertManualConditions(fixture.tools)).not.toThrow();
      expect(fixture.tools).toHaveLength(11);
      for (const profile of fixture.profiles) {
        expect(mcpSchemaBytes(profile)).toBeLessThanOrEqual(7680);
        expect(() => assertMcpSchemaBudget(profile)).not.toThrow();
      }

      const patchItem = at(
        fixture.tools.find((tool) => tool.name === "atm_task_patch")!.inputSchema,
        ["properties", "items", "items"],
      );
      expect(patchItem.dependentSchemas).toEqual({
        expected_fields: { properties: { operation: { const: "edit" } } },
      });
      expect(patchItem.allOf).toEqual([
        {
          if: { properties: { operation: { const: "block" } } },
          then: { required: ["blocked_reason"] },
        },
        {
          if: { properties: { operation: { enum: ["wait_user", "wait_agent"] } } },
          then: { required: ["waiting_for"] },
        },
        {
          if: { properties: { operation: { const: "review_request" } } },
          then: {
            required: [
              "parent_checklist_id",
              "expected_parent_checklist_version",
              "candidate_hashes",
            ],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "parent_checklist_id",
                "expected_parent_checklist_version",
                "candidate_hashes",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "review_submit" } } },
          then: {
            required: ["request_key", "verdict", "candidate_hashes", "evidence"],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "request_key",
                "verdict",
                "candidate_hashes",
                "evidence",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "checklist_single" } } },
          then: {
            required: ["checklist_items"],
            properties: { checklist_items: { maxItems: 1 } },
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "checklist_items",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "checklist_batch" } } },
          then: {
            required: ["checklist_items"],
            propertyNames: {
              enum: [
                "task_key",
                "expected_version",
                "takeover_stale",
                "operation",
                "checklist_items",
              ],
            },
          },
        },
        {
          if: { properties: { operation: { const: "verify_and_complete" } } },
          then: {
            propertyNames: {
              enum: ["task_key", "expected_version", "takeover_stale", "operation"],
            },
          },
        },
      ]);
      expect(patchItem.properties.expected_fields.minProperties).toBe(1);
      expect(
        fixture.tools.find((tool) => tool.name === "atm_task_patch")!.inputSchema.allOf,
      ).toEqual(expectedManualConditions.patchRootAllOf);
      const progress = fixture.tools.find((tool) => tool.name === "atm_progress_add")!.inputSchema;
      expect(progress.allOf).toEqual([
        {
          if: { properties: { scope: { const: "task" } } },
          then: { required: ["task_key"], not: { required: ["health"] } },
        },
        {
          if: { properties: { scope: { const: "project" } } },
          then: { not: { required: ["percent"] } },
        },
      ]);
      expect(
        at(progress, ["properties", "completed", "items", "anyOf", "1", "properties"]),
      ).toEqual({ text: { type: "string" }, work_item_key: { type: "string" } });

      const invalidSchemaNodes: string[] = [];
      const inspect = (value: unknown, path: string): void => {
        if (typeof value === "boolean") {
          if (!path.endsWith(".additionalProperties") || value !== false) {
            invalidSchemaNodes.push(`${path}:boolean`);
          }
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
          return;
        }
        if (!value || typeof value !== "object") return;
        const object = value as JsonObject;
        if (Object.keys(object).length === 0) invalidSchemaNodes.push(`${path}:empty`);
        Object.entries(object).forEach(([key, entry]) => inspect(entry, `${path}.${key}`));
      };
      fixture.tools.forEach((tool) => inspect(tool.inputSchema, tool.name));
      expect(invalidSchemaNodes).toEqual([]);
      for (const tool of fixture.tools) {
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }

      // 阳性对照：逐个删除公开字段，守卫必须精确指出被删的路径，而非靠 JSON 子串假绿。
      for (const [toolName, fields] of Object.entries(publicFields)) {
        for (const field of fields) {
          const mutated = structuredClone(fixture.tools);
          const schema = mutated.find((tool) => tool.name === toolName)!.inputSchema;
          delete schema.properties[field];
          expect(() => assertPublicSurface(mutated)).toThrow(
            `PUBLIC_FIELD_SET_MISMATCH:${toolName}`,
          );
        }
      }
      for (const fieldSet of nestedFieldSets) {
        for (const field of fieldSet.expected) {
          const mutated = structuredClone(fixture.tools);
          const schema = mutated.find((tool) => tool.name === fieldSet.tool)!.inputSchema;
          delete dereference(at(schema, fieldSet.path), schema).properties[field];
          expect(() => assertPublicSurface(mutated)).toThrow(
            `PUBLIC_FIELD_SET_MISMATCH:${fieldSet.label}`,
          );
        }
      }

      type ConstraintMutation = {
        tool: string;
        location: Array<string | number>;
        field?: string;
        semanticPath: string;
      };
      const semanticMutations: ConstraintMutation[] = [];
      for (const tool of fixture.tools) {
        const visit = (
          node: JsonObject,
          location: Array<string | number>,
          semanticPath: string,
        ): void => {
          if (node.$ref) return;
          if (Array.isArray(node.enum)) {
            semanticMutations.push({
              tool: tool.name,
              location: [...location, "enum"],
              semanticPath: `${semanticPath}#enum`,
            });
          }
          if (node.type !== undefined && node.enum === undefined && node.const === undefined) {
            semanticMutations.push({
              tool: tool.name,
              location: [...location, "type"],
              semanticPath: `${semanticPath}#type`,
            });
          }
          if (node.additionalProperties !== undefined) {
            if (typeof node.additionalProperties === "boolean") {
              semanticMutations.push({
                tool: tool.name,
                location: [...location, "additionalProperties"],
                semanticPath: `${semanticPath}#additionalProperties`,
              });
            } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
              visit(
                node.additionalProperties,
                [...location, "additionalProperties"],
                `${semanticPath}.*`,
              );
            }
          }
          if (node.properties && typeof node.properties === "object") {
            for (const field of node.required ?? []) {
              semanticMutations.push({
                tool: tool.name,
                location: [...location, "required"],
                field,
                semanticPath: `${semanticPath}#required`,
              });
            }
            for (const [field, child] of Object.entries(node.properties)) {
              visit(
                child as JsonObject,
                [...location, "properties", field],
                `${semanticPath}.${field}`,
              );
            }
          }
          if (node.items && typeof node.items === "object") {
            visit(node.items, [...location, "items"], `${semanticPath}[]`);
          }
          if (Array.isArray(node.anyOf)) {
            node.anyOf.forEach((branch: JsonObject, index: number) =>
              visit(branch, [...location, "anyOf", index], `${semanticPath}.anyOf[${index}]`),
            );
          }
        };
        visit(tool.inputSchema, [], "$input");
      }
      for (const mutation of semanticMutations) {
        const mutated = structuredClone(fixture.tools);
        const schema = mutated.find((tool) => tool.name === mutation.tool)!.inputSchema;
        const target = at(schema, mutation.location.map(String));
        if (mutation.field === undefined) {
          const parent = at(schema, mutation.location.slice(0, -1).map(String));
          delete parent[mutation.location.at(-1)!];
        } else {
          const required = target as string[];
          required.splice(required.indexOf(mutation.field), 1);
        }
        expect(() => assertRuntimeSemantics(fixture.runtimeSchemas, mutated)).toThrow(
          `SCHEMA_SEMANTIC_MISMATCH:${mutation.tool}:${mutation.semanticPath}`,
        );
      }
      // `$ref` 节点不能靠上面的直接遍历命中；逐项破坏共享 evidence 定义，
      // 证明 required / enum / type / strictness 仍由 runtime parity 守卫真实覆盖。
      for (const location of [
        ["$defs", "e", "required"],
        ["$defs", "e", "properties", "kind", "enum"],
        ["$defs", "e", "properties", "value", "type"],
        ["$defs", "e", "additionalProperties"],
      ] as const) {
        const mutated = structuredClone(fixture.tools);
        const schema = mutated.find((tool) => tool.name === "atm_task_patch")!.inputSchema;
        const parent = at(schema, location.slice(0, -1));
        delete parent[location.at(-1)!];
        expect(() => assertRuntimeSemantics(fixture.runtimeSchemas, mutated)).toThrow(
          /SCHEMA_SEMANTIC_MISMATCH:atm_task_patch/u,
        );
      }

      const patchBase = ["properties", "items", "items"] as const;
      const manualMutations: Array<{
        tool: string;
        location: Array<string | number>;
        field?: string;
      }> = [
        {
          tool: "atm_task_patch",
          location: [
            ...patchBase,
            "dependentSchemas",
            "expected_fields",
            "properties",
            "operation",
            "const",
          ],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "properties", "expected_fields", "minProperties"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "properties", "checklist_items", "minItems"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 0, "if", "properties", "operation", "const"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 0, "then", "required"],
          field: "blocked_reason",
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 1, "if", "properties", "operation", "enum"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 1, "then", "required"],
          field: "waiting_for",
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 2, "if", "properties", "operation", "const"],
        },
        ...["parent_checklist_id", "expected_parent_checklist_version", "candidate_hashes"].map(
          (field) => ({
            tool: "atm_task_patch",
            location: [...patchBase, "allOf", 2, "then", "required"] as Array<string | number>,
            field,
          }),
        ),
        ...[
          "task_key",
          "expected_version",
          "takeover_stale",
          "operation",
          "parent_checklist_id",
          "expected_parent_checklist_version",
          "candidate_hashes",
        ].map((field) => ({
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 2, "then", "propertyNames", "enum"] as Array<
            string | number
          >,
          field,
        })),
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 3, "if", "properties", "operation", "const"],
        },
        ...["request_key", "verdict", "candidate_hashes", "evidence"].map((field) => ({
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 3, "then", "required"] as Array<string | number>,
          field,
        })),
        ...[
          "task_key",
          "expected_version",
          "takeover_stale",
          "operation",
          "request_key",
          "verdict",
          "candidate_hashes",
          "evidence",
        ].map((field) => ({
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 3, "then", "propertyNames", "enum"] as Array<
            string | number
          >,
          field,
        })),
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 4, "if", "properties", "operation", "const"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 4, "then", "required"],
          field: "checklist_items",
        },
        ...["task_key", "expected_version", "takeover_stale", "operation", "checklist_items"].map(
          (field) => ({
            tool: "atm_task_patch",
            location: [...patchBase, "allOf", 4, "then", "propertyNames", "enum"] as Array<
              string | number
            >,
            field,
          }),
        ),
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 4, "then", "properties", "checklist_items", "maxItems"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 5, "if", "properties", "operation", "const"],
        },
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 5, "then", "required"],
          field: "checklist_items",
        },
        ...["task_key", "expected_version", "takeover_stale", "operation", "checklist_items"].map(
          (field) => ({
            tool: "atm_task_patch",
            location: [...patchBase, "allOf", 5, "then", "propertyNames", "enum"] as Array<
              string | number
            >,
            field,
          }),
        ),
        {
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 6, "if", "properties", "operation", "const"],
        },
        ...["task_key", "expected_version", "takeover_stale", "operation"].map((field) => ({
          tool: "atm_task_patch",
          location: [...patchBase, "allOf", 6, "then", "propertyNames", "enum"] as Array<
            string | number
          >,
          field,
        })),
        {
          tool: "atm_task_patch",
          location: [
            "allOf",
            0,
            "if",
            "properties",
            "items",
            "contains",
            "properties",
            "operation",
            "enum",
          ],
        },
        {
          tool: "atm_task_patch",
          location: ["allOf", 0, "then", "properties", "items", "maxItems"],
        },
        {
          tool: "atm_progress_add",
          location: ["allOf", 0, "if", "properties", "scope", "const"],
        },
        {
          tool: "atm_progress_add",
          location: ["allOf", 0, "then", "required"],
          field: "task_key",
        },
        {
          tool: "atm_progress_add",
          location: ["allOf", 0, "then", "not", "required"],
          field: "health",
        },
        {
          tool: "atm_progress_add",
          location: ["allOf", 1, "if", "properties", "scope", "const"],
        },
        {
          tool: "atm_progress_add",
          location: ["allOf", 1, "then", "not", "required"],
          field: "percent",
        },
        {
          tool: "atm_search",
          location: ["anyOf", 0, "required"],
          field: "query",
        },
        {
          tool: "atm_search",
          location: ["anyOf", 1, "required"],
          field: "op_id",
        },
        {
          tool: "atm_search",
          location: ["dependentRequired", "session"],
          field: "op_id",
        },
      ];
      for (const mutation of manualMutations) {
        const mutated = structuredClone(fixture.tools);
        const schema = mutated.find((tool) => tool.name === mutation.tool)!.inputSchema;
        if (mutation.field === undefined) {
          const parent = at(schema, mutation.location.slice(0, -1).map(String));
          delete parent[mutation.location.at(-1)!];
        } else {
          const required = at(schema, mutation.location.map(String)) as string[];
          required.splice(required.indexOf(mutation.field), 1);
        }
        expect(() => assertManualConditions(mutated)).toThrow(/MANUAL_CONDITION_MISMATCH/u);
      }
    } finally {
      await fixture.close();
    }
  });

  it("accepts every restored field in the same runtime schemas published to tools/list", async () => {
    const fixture = await listedTools();
    try {
      const cases: Array<{ tool: string; arguments: JsonObject }> = [
        {
          tool: "atm_begin",
          arguments: {
            agent_id: "agent",
            title: "Restored title",
            display_name: "Restored agent",
            client_kind: "test",
            signals: { expected_minutes: 10, multi_agent: true },
            creation_reason: "Restore the complete surface",
          },
        },
        {
          tool: "atm_task_list",
          arguments: {
            project: "TRUTH",
            status: "READY",
            owner: "agent",
            parent_key: "TRUTH-T-0001",
            milestone_id: "m",
            query: "q",
            field_mask: [],
            include_active: true,
            limit: 1,
            max_chars: 1000,
          },
        },
        {
          tool: "atm_task_create",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "retired-create",
            items: [
              {
                client_ref: "one",
                title: "one",
                objective_id: "objective",
                milestone_id: "milestone",
                discovered_from: "task",
                weight: 2,
                target_date: "2026-08-27",
                checklist: [{ title: "check", weight: 2 }],
              },
            ],
          },
        },
        {
          tool: "atm_task_create",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "restored-create-ref",
            items: [{ client_ref: "two", title: "two", discovered_from_ref: "one" }],
          },
        },
        {
          tool: "atm_task_patch",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "retired-patch",
            items: [
              {
                task_key: "TRUTH-T-0001",
                expected_version: 1,
                operation: "edit",
                assignee_agent_id: "agent",
                target_date: null,
                parent_key: null,
              },
              {
                task_key: "TRUTH-T-0002",
                expected_version: 2,
                operation: "edit",
                target_date: "2026-08-27",
                parent_key: "TRUTH-T-0001",
                expected_fields: { target_date: null, parent_key: null },
              },
            ],
          },
        },
        {
          tool: "atm_progress_add",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "retired-progress",
            scope: "task",
            task_key: "TRUTH-T-0001",
            summary: "summary",
            percent: 50,
            next: [],
            blocker: null,
          },
        },
        {
          tool: "atm_record",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "retired-record",
            kind: "FACT",
            title: "title",
            summary: "summary",
            importance: "HIGH",
            scope: "PROJECT",
          },
        },
        {
          tool: "atm_search",
          arguments: { project: "TRUTH", op_id: "legacy", session: "legacy", limit: 1 },
        },
        {
          tool: "atm_delta",
          arguments: {
            project: "TRUTH",
            since_seq: 0,
            limit: 1,
            types: [],
            max_chars: 1000,
          },
        },
        {
          tool: "atm_end",
          arguments: {
            project: "TRUTH",
            session: "session",
            op_id: "retired-end",
            outcome: "paused",
            summary: "summary",
            next: [],
            release_claims: false,
          },
        },
      ];

      for (const entry of cases) {
        const parsed = fixture.runtimeSchemas[entry.tool]!.safeParse(entry.arguments);
        expect(parsed.success, `${entry.tool}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }

      const projectPercent = fixture.runtimeSchemas.atm_progress_add!.safeParse({
        project: "TRUTH",
        session: "session",
        op_id: "invalid-project-percent",
        scope: "project",
        summary: "summary",
        percent: 50,
      });
      expect(projectPercent.success).toBe(false);
      expect(projectPercent.error?.issues).toContainEqual(
        expect.objectContaining({ path: ["percent"] }),
      );
    } finally {
      await fixture.close();
    }
  });
});
