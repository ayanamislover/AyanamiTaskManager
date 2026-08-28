import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import type { z } from "zod";
import { withMcpErrorDetails } from "../result.js";
import { ToolDefinitionRegistry, type ToolDefinition } from "../tool-registry.js";
import { actionToolDefinitions } from "./actions.js";
import { coreToolDefinitions } from "./core.js";
import { memoryToolDefinitions } from "./memory.js";

function installDefinition<Input extends z.ZodType>(
  registry: ToolDefinitionRegistry,
  service: AyanamiTaskService,
  definition: ToolDefinition<Input>,
): void {
  const handler = definition.handler;
  const wrapped = (async (input: z.output<Input>, extra: Parameters<typeof handler>[1]) => {
    const record = input as unknown as Record<string, unknown>;
    const project =
      typeof record.project === "string"
        ? record.project
        : typeof record.project_code === "string"
          ? record.project_code
          : undefined;
    return await withMcpErrorDetails(
      service,
      project === undefined ? {} : { project },
      async () => await handler(input, extra),
    );
  }) as ToolCallback<Input>;
  registry.define(
    definition.profile,
    definition.name,
    {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
      ...(definition.protocolMeta === undefined ? {} : { _meta: definition.protocolMeta }),
    },
    wrapped,
  );
}

export function createAyanamiToolRegistry(service: AyanamiTaskService): ToolDefinitionRegistry {
  const registry = new ToolDefinitionRegistry();
  const [begin, brief, taskList, taskGet, taskCreate, end] = coreToolDefinitions(service);
  const [taskPatch] = actionToolDefinitions(service);
  const [progressAdd, record, search, delta] = memoryToolDefinitions(service);
  installDefinition(registry, service, begin);
  installDefinition(registry, service, brief);
  installDefinition(registry, service, taskList);
  installDefinition(registry, service, taskGet);
  installDefinition(registry, service, taskCreate);
  installDefinition(registry, service, taskPatch);
  installDefinition(registry, service, progressAdd);
  installDefinition(registry, service, record);
  installDefinition(registry, service, search);
  installDefinition(registry, service, delta);
  installDefinition(registry, service, end);
  return registry;
}
