import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export type AyanamiToolProfile = "core" | "memory";
export type AyanamiServerProfile = AyanamiToolProfile | "legacy";

export type ToolDefinitionMetadata = {
  /** Reserved for the generated metadata pass (T0186). */
  readonly surfaceVersion?: number;
  /** Reserved for the generated metadata pass (T0186). */
  readonly schemaHash?: string;
};

export type ToolDefinition<Input extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly profile: AyanamiToolProfile;
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType;
  readonly annotations?: ToolAnnotations;
  readonly protocolMeta?: Record<string, unknown>;
  readonly generatedMeta?: ToolDefinitionMetadata;
  readonly handler: ToolCallback<Input>;
};

export type DefineToolConfig<Input extends z.ZodType> = {
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
  readonly generatedMeta?: ToolDefinitionMetadata;
};

/**
 * The single source of truth for tool names, profiles, schemas and handlers.
 * Definitions are immutable after insertion; profile filtering happens before
 * the public SDK registration call, never by mutating SDK-owned state.
 */
export class ToolDefinitionRegistry {
  readonly #definitions = new Map<string, ToolDefinition>();

  define<Input extends z.ZodType>(
    profile: AyanamiToolProfile,
    name: string,
    config: DefineToolConfig<Input>,
    handler: ToolCallback<Input>,
  ): void {
    if (this.#definitions.has(name)) throw new Error(`DUPLICATE_TOOL_DEFINITION:${name}`);
    this.#definitions.set(
      name,
      Object.freeze({
        name,
        profile,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        ...(config.annotations === undefined ? {} : { annotations: config.annotations }),
        ...(config._meta === undefined ? {} : { protocolMeta: config._meta }),
        ...(config.generatedMeta === undefined ? {} : { generatedMeta: config.generatedMeta }),
        handler,
      }),
    );
  }

  definitions(profile: AyanamiServerProfile = "legacy"): readonly ToolDefinition[] {
    return Object.freeze(
      [...this.#definitions.values()].filter(
        (definition) => profile === "legacy" || definition.profile === profile,
      ),
    );
  }

  register(server: McpServer, profile: AyanamiServerProfile): void {
    for (const definition of this.definitions(profile)) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema,
          outputSchema: definition.outputSchema,
          ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
          ...(definition.protocolMeta === undefined ? {} : { _meta: definition.protocolMeta }),
        },
        definition.handler,
      );
    }
  }
}
