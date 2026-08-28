import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmBeginTool } from "../tools/core/begin.js";
import { createAtmBriefTool } from "../tools/core/brief.js";
import { createAtmEndTool } from "../tools/core/end.js";
import { createAtmTaskCreateTool } from "../tools/core/task-create.js";
import { createAtmTaskGetTool } from "../tools/core/task-get.js";
import { createAtmTaskListTool } from "../tools/core/task-list.js";

export function coreToolDefinitions(service: AyanamiTaskService) {
  return [
    createAtmBeginTool(service),
    createAtmBriefTool(service),
    createAtmTaskListTool(service),
    createAtmTaskGetTool(service),
    createAtmTaskCreateTool(service),
    createAtmEndTool(service),
  ] as const;
}
