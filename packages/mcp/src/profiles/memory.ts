import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmDeltaTool } from "../tools/memory/delta.js";
import { createAtmFeedbackTool } from "../tools/memory/feedback.js";
import { createAtmKnowledgeGetTool } from "../tools/memory/knowledge-get.js";
import { createAtmKnowledgeSearchTool } from "../tools/memory/knowledge-search.js";
import { createAtmProgressAddTool } from "../tools/memory/progress-add.js";
import { createAtmRecordTool } from "../tools/memory/record.js";
import { createAtmSearchTool } from "../tools/memory/search.js";

export function memoryToolDefinitions(service: AyanamiTaskService) {
  return [
    createAtmProgressAddTool(service),
    createAtmRecordTool(service),
    createAtmFeedbackTool(service),
    createAtmSearchTool(service),
    createAtmDeltaTool(service),
    createAtmKnowledgeSearchTool(service),
    createAtmKnowledgeGetTool(service),
  ] as const;
}
