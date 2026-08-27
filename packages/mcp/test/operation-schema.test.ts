import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

type JsonSchema = Record<string, any>;

function dereference(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (typeof schema.$ref !== "string") return schema;
  const path = schema.$ref.replace(/^#\//u, "").split("/");
  return path.reduce<JsonSchema>((value, segment) => value?.[segment], root);
}

function operationVariants(schema: JsonSchema): Map<string, JsonSchema> {
  const found = new Map<string, JsonSchema>();
  const visited = new Set<JsonSchema>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const resolved = dereference(candidate as JsonSchema, schema);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const rootProperties = resolved.properties ?? {};
    const rootRequired = Array.isArray(resolved.required) ? resolved.required : [];
    const union = Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : Array.isArray(resolved.anyOf)
        ? resolved.anyOf
        : [];
    for (const candidateBranch of union) {
      const branch = dereference(candidateBranch, schema);
      const branchProperties = branch.properties ?? {};
      const operation = dereference(branchProperties.operation ?? {}, schema);
      const operationNames =
        typeof operation.const === "string"
          ? [operation.const]
          : Array.isArray(operation.enum)
            ? operation.enum.filter((value: unknown): value is string => typeof value === "string")
            : [];
      const effective = {
        type: "object",
        properties: { ...rootProperties, ...branchProperties },
        required: [
          ...new Set([...rootRequired, ...(Array.isArray(branch.required) ? branch.required : [])]),
        ],
        additionalProperties:
          resolved.unevaluatedProperties === false || resolved.additionalProperties === false
            ? false
            : undefined,
      };
      for (const operationName of operationNames) found.set(operationName, effective);
    }
    for (const value of Object.values(resolved)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(schema);
  return found;
}

const common = ["task_key", "expected_version", "operation", "takeover_stale"] as const;
const contracts: Record<string, { fields: readonly string[]; required: readonly string[] }> = {
  claim: { fields: common, required: common.slice(0, 3) },
  start: { fields: common, required: common.slice(0, 3) },
  release: { fields: common, required: common.slice(0, 3) },
  block: {
    fields: [...common, "blocked_reason"],
    required: [...common.slice(0, 3), "blocked_reason"],
  },
  wait_user: {
    fields: [...common, "waiting_for"],
    required: [...common.slice(0, 3), "waiting_for"],
  },
  wait_agent: {
    fields: [...common, "waiting_for"],
    required: [...common.slice(0, 3), "waiting_for"],
  },
  verify: { fields: common, required: common.slice(0, 3) },
  complete: { fields: common, required: common.slice(0, 3) },
  cancel: {
    fields: [...common, "cancel_reason", "duplicate_of", "superseded_by"],
    required: common.slice(0, 3),
  },
  reopen: { fields: common, required: common.slice(0, 3) },
  edit: {
    fields: [
      ...common,
      "expected_fields",
      "title",
      "description",
      "acceptance",
      "assignee_agent_id",
      "target_date",
      "parent_key",
    ],
    required: common.slice(0, 3),
  },
  verify_and_complete: { fields: common, required: common.slice(0, 3) },
  review_request: {
    fields: [
      ...common,
      "parent_checklist_id",
      "expected_parent_checklist_version",
      "candidate_hashes",
    ],
    required: [
      ...common.slice(0, 3),
      "parent_checklist_id",
      "expected_parent_checklist_version",
      "candidate_hashes",
    ],
  },
  review_submit: {
    fields: [...common, "request_key", "verdict", "candidate_hashes", "evidence"],
    required: [...common.slice(0, 3), "request_key", "verdict", "candidate_hashes", "evidence"],
  },
  checklist_single: {
    fields: [...common, "checklist_items"],
    required: [...common.slice(0, 3), "checklist_items"],
  },
  checklist_batch: {
    fields: [...common, "checklist_items"],
    required: [...common.slice(0, 3), "checklist_items"],
  },
};

describe("atm_task_patch operation schema", () => {
  it("publishes all 16 operation-specific required and allowed fields", async () => {
    const server = createAyanamiMcpServer({} as AyanamiTaskService, { profile: "actions" });
    const client = new Client({ name: "operation-schema", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "atm_task_patch",
      )!;
      const variants = operationVariants(tool.inputSchema as JsonSchema);
      expect([...variants.keys()].sort()).toEqual(Object.keys(contracts).sort());
      for (const [operation, contract] of Object.entries(contracts)) {
        const variant = variants.get(operation)!;
        expect(Object.keys(variant.properties ?? {}).sort(), operation).toEqual(
          [...contract.fields].sort(),
        );
        expect([...(variant.required ?? [])].sort(), operation).toEqual(
          [...contract.required].sort(),
        );
        expect(variant.additionalProperties, operation).toBe(false);
      }
      expect(
        dereference(variants.get("checklist_single")!.properties.checklist_items, tool.inputSchema),
      ).toMatchObject({
        minItems: 1,
        maxItems: 1,
      });
      expect(
        dereference(variants.get("checklist_batch")!.properties.checklist_items, tool.inputSchema),
      ).toMatchObject({
        minItems: 1,
        maxItems: 100,
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
