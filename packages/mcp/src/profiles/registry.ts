import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import type { z } from "zod";
import { withMcpErrorDetails } from "../result.js";
import {
  ToolDefinitionRegistry,
  type AyanamiToolProfile,
  type DefineToolConfig,
} from "../tool-registry.js";
import { registerActionTools } from "./actions.js";
import { registerCoreBeginTools, registerCoreEndTool } from "./core-session.js";
import { registerCoreTaskTools } from "./core-tasks.js";
import { registerMemoryReadTools } from "./memory-read.js";
import { registerMemoryWriteTools } from "./memory-write.js";
import type { DefineProfileTool } from "./registrar.js";

export function createAyanamiToolRegistry(service: AyanamiTaskService): ToolDefinitionRegistry {
  const registry = new ToolDefinitionRegistry();
  const defineTool: DefineProfileTool = <Input extends z.ZodType>(
    profile: AyanamiToolProfile,
    name: string,
    config: DefineToolConfig<Input>,
    handler: ToolCallback<Input>,
  ): void => {
    const wrapped = (async (input: z.output<Input>, extra: Parameters<typeof handler>[1]) => {
      const record = input as Record<string, unknown>;
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
    registry.define(profile, name, config, wrapped);
  };

  registerCoreBeginTools(service, defineTool);
  registerCoreTaskTools(service, defineTool);
  registerActionTools(service, defineTool);
  registerMemoryWriteTools(service, defineTool);
  registerMemoryReadTools(service, defineTool);
  registerCoreEndTool(service, defineTool);
  return registry;
}
