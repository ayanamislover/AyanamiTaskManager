import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { AyanamiToolProfile, DefineToolConfig } from "../tool-registry.js";

export type DefineProfileTool = <Input extends z.ZodType>(
  profile: AyanamiToolProfile,
  name: string,
  config: DefineToolConfig<Input>,
  handler: ToolCallback<Input>,
) => void;
