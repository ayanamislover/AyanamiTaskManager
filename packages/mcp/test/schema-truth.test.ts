import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { createAyanamiMcpServer, createAyanamiToolRegistry } from "../src/index.js";
import { normalizePublishedSchema } from "../src/tool-publication.js";

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
  if (!schema || typeof schema !== "object") return {};
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
        (branch: JsonObject) =>
          branch.enum === undefined &&
          branch.const === undefined &&
          Object.keys(branch).every((key) => key === "type"),
      ) &&
      simpleUnionTypes.includes("null");
    if (Array.isArray(node.enum)) constraints.set(`${path}#enum`, JSON.stringify(node.enum));
    if (node.const !== undefined) constraints.set(`${path}#const`, JSON.stringify(node.const));
    for (const keyword of [
      "default",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "pattern",
      "minItems",
      "maxItems",
      "format",
    ] as const) {
      if (node[keyword] !== undefined) {
        constraints.set(`${path}#${keyword}`, JSON.stringify(node[keyword]));
      }
    }
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
                "default" in dereference(node.properties[field], root)
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
    for (const keyword of ["allOf", "oneOf"] as const) {
      if (Array.isArray(node[keyword])) {
        node[keyword].forEach((branch: JsonObject, index: number) =>
          visit(branch, root, `${path}.${keyword}[${index}]`),
        );
      }
    }
    for (const keyword of ["dependentRequired", "dependentSchemas"] as const) {
      if (node[keyword] !== undefined) {
        constraints.set(`${path}#${keyword}`, JSON.stringify(node[keyword]));
      }
    }
  };
  const normalized = normalizePublishedSchema(schema);
  visit(normalized, normalized, "$input");
  return constraints;
}

function assertRuntimeSemantics(
  runtimeSchemas: RuntimeSchemas,
  tools: ListedTool[],
  referenceTools?: ListedTool[],
): void {
  // T0184 moves these two business-heavy inputs onto protocol-owned canonical
  // adapters first. Other tools retain the pre-existing compact publication
  // until their command/query schemas migrate; missing keywords there are the
  // explicit transition allowlist, while any published value must still match.
  const canonicalAdapterTools = new Set(["atm_begin", "atm_task_create"]);
  for (const tool of tools) {
    // atm_task_patch publishes a compact discriminated union whose per-operation
    // field/required parity is exhaustively guarded by operation-schema.test.ts.
    if (tool.name === "atm_task_patch") continue;
    const runtimeSchema = runtimeSchemas[tool.name];
    if (!runtimeSchema) throw new Error(`MISSING_RUNTIME_SCHEMA:${tool.name}`);
    const runtime = semanticConstraints(z.toJSONSchema(runtimeSchema) as JsonObject, true);
    const published = semanticConstraints(tool.inputSchema, false);
    const reference = referenceTools?.find((candidate) => candidate.name === tool.name);
    const referencePublished = reference
      ? semanticConstraints(reference.inputSchema, false)
      : undefined;
    for (const [path, expected] of runtime) {
      const actual = published.get(path);
      if (
        actual === undefined &&
        !canonicalAdapterTools.has(tool.name) &&
        referencePublished?.has(path) !== true
      ) {
        continue;
      }
      if (actual !== expected) {
        throw new Error(`SCHEMA_SEMANTIC_MISMATCH:${tool.name}:${path}:${actual ?? "missing"}`);
      }
    }
    for (const [path, actual] of published) {
      const expected = runtime.get(path);
      const publicationOnlyContract =
        (tool.name === "atm_task_patch" &&
          (path.startsWith("$input.items[]#dependentSchemas") ||
            path.startsWith("$input.items[].allOf[") ||
            path.startsWith("$input.allOf["))) ||
        (tool.name === "atm_progress_add" && path.startsWith("$input.allOf[")) ||
        (tool.name === "atm_search" &&
          (path.startsWith("$input.anyOf[") || path === "$input#dependentRequired"));
      if (publicationOnlyContract) continue;
      if (actual !== expected) {
        throw new Error(`SCHEMA_SEMANTIC_MISMATCH:${tool.name}:${path}:unexpected:${actual}`);
      }
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
    (["core", "memory", "actions"] as const).map(async (profile) => {
      const service = {} as AyanamiTaskService;
      const registry = createAyanamiToolRegistry(service);
      const server = createAyanamiMcpServer(service, { profile });
      const client = new Client({ name: `schema-truth-${profile}`, version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = (await client.listTools()).tools as ListedTool[];
      return { server, client, registry, tools, profile };
    }),
  );
  const tools = fixtures.flatMap((fixture) => fixture.tools);
  const activeNames = new Set(tools.map((tool) => tool.name));
  const runtimeSchemas = Object.fromEntries(
    fixtures
      .flatMap((fixture) => fixture.registry.definitions(fixture.profile))
      .filter((definition) => activeNames.has(definition.name))
      .map((definition) => [definition.name, definition.inputSchema]),
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
  it("publishes canonical fields and semantics through the SDK public path", async () => {
    const fixture = await listedTools();
    try {
      expect(() => assertPublicSurface(fixture.tools)).not.toThrow();
      expect(() => assertRuntimeSemantics(fixture.runtimeSchemas, fixture.tools)).not.toThrow();
      expect(fixture.tools).toHaveLength(11);
      for (const tool of fixture.tools) {
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }

      const semanticMutations = [
        {
          tool: "atm_begin",
          location: ["properties", "thread_id", "maxLength"],
          semanticPath: "$input.thread_id#maxLength",
        },
        {
          tool: "atm_task_create",
          location: ["properties", "items", "items", "properties", "target_date", "pattern"],
          semanticPath: "$input.items[].target_date#pattern",
        },
        {
          tool: "atm_task_create",
          location: [
            "properties",
            "items",
            "items",
            "properties",
            "acceptance",
            "items",
            "minLength",
          ],
          semanticPath: "$input.items[].acceptance[]#minLength",
        },
        {
          tool: "atm_task_create",
          location: [
            "properties",
            "items",
            "items",
            "properties",
            "checklist",
            "items",
            "properties",
            "title",
            "minLength",
          ],
          semanticPath: "$input.items[].checklist[].title#minLength",
        },
      ] as const;
      for (const mutation of semanticMutations) {
        const mutated = structuredClone(fixture.tools);
        const schema = mutated.find((tool) => tool.name === mutation.tool)!.inputSchema;
        const parent = at(schema, mutation.location.slice(0, -1));
        delete parent[mutation.location.at(-1)!];
        expect(
          () => assertRuntimeSemantics(fixture.runtimeSchemas, mutated, fixture.tools),
          mutation.semanticPath,
        ).toThrow(`SCHEMA_SEMANTIC_MISMATCH:${mutation.tool}:${mutation.semanticPath}`);
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
