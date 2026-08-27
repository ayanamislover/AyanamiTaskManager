import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export type AyanamiToolProfile = "core" | "memory" | "actions";
export type AyanamiServerProfile = AyanamiToolProfile | "legacy";

export type CompleteToolAnnotations = ToolAnnotations & {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
};

export type ToolDefinition<Input extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly profile: AyanamiToolProfile;
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType;
  readonly annotations: CompleteToolAnnotations;
  readonly protocolMeta?: Record<string, unknown>;
  readonly handler: ToolCallback<Input>;
};

export type DefineToolConfig<Input extends z.ZodType> = {
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType;
  readonly annotations: CompleteToolAnnotations;
  readonly _meta?: Record<string, unknown>;
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
    if (!/^\S[^\r\n]*$/u.test(config.description)) {
      throw new Error(`INVALID_TOOL_DESCRIPTION:${name}`);
    }
    this.#definitions.set(
      name,
      Object.freeze({
        name,
        profile,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        annotations: Object.freeze({ ...config.annotations }),
        ...(config._meta === undefined ? {} : { protocolMeta: config._meta }),
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
}
