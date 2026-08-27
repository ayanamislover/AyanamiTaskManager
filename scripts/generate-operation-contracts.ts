import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateWorkItemOperationTable,
  WORK_ITEM_OPERATION_TABLE_BEGIN,
  WORK_ITEM_OPERATION_TABLE_END,
} from "../packages/protocol/src/index.js";

const root = process.cwd();
const guidePath = join(root, "ATM_AGENT_GUIDE.md");
const generatedPath = join(root, "docs", "generated", "work-item-operations.md");
const table = generateWorkItemOperationTable();

const guide = await readFile(guidePath, "utf8");
const start = guide.indexOf(WORK_ITEM_OPERATION_TABLE_BEGIN);
const end = guide.indexOf(WORK_ITEM_OPERATION_TABLE_END);
if (start < 0 || end < start) throw new Error("WORK_ITEM_OPERATION_MARKERS_MISSING");
const nextGuide = `${guide.slice(0, start)}${table}${guide.slice(
  end + WORK_ITEM_OPERATION_TABLE_END.length,
)}`;
await Promise.all([
  writeFile(guidePath, nextGuide, "utf8"),
  writeFile(
    generatedPath,
    `# WorkItem Operation Contracts\n\n> Generated from \`WorkItemOperations\`; do not edit by hand.\n\n${table}\n`,
    "utf8",
  ),
]);
