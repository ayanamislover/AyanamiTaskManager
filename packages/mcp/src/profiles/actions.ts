import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAtmTaskPatchTool } from "../tools/actions/task-patch.js";

export function actionToolDefinitions(service: AyanamiTaskService) {
  return [createAtmTaskPatchTool(service)] as const;
}
