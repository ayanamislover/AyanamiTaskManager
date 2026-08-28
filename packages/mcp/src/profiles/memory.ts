import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmDeltaTool } from "../tools/memory/delta.js";
import { createAtmProgressAddTool } from "../tools/memory/progress-add.js";
import { createAtmRecordTool } from "../tools/memory/record.js";
import { createAtmSearchTool } from "../tools/memory/search.js";

export function memoryToolDefinitions(service: AyanamiTaskService) {
  return [
    createAtmProgressAddTool(service),
    createAtmRecordTool(service),
    createAtmSearchTool(service),
    createAtmDeltaTool(service),
  ] as const;
}
