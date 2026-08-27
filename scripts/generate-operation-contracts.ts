import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "prettier";
import {
  generateWorkItemOperationTable,
  WORK_ITEM_OPERATION_TABLE_BEGIN,
  WORK_ITEM_OPERATION_TABLE_END,
} from "../packages/protocol/src/index.js";
import {
  generateMutationAcknowledgementDocumentation,
  MUTATION_ACK_DOCUMENTATION_BEGIN,
  MUTATION_ACK_DOCUMENTATION_END,
} from "../packages/mcp/src/mutation-ack-contract.js";

const root = process.cwd();
const guidePath = join(root, "ATM_AGENT_GUIDE.md");
const agentIntegrationPath = join(root, "docs", "agent-integration.md");
const generatedPath = join(root, "docs", "generated", "work-item-operations.md");
const generatedMutationAckPath = join(root, "docs", "generated", "mutation-acknowledgement.md");
const table = generateWorkItemOperationTable();
const mutationAcknowledgement = (
  await format(generateMutationAcknowledgementDocumentation(), { parser: "markdown" })
).trim();

function replaceMarkedSection(
  content: string,
  begin: string,
  end: string,
  replacement: string,
  missingCode: string,
): string {
  const start = content.indexOf(begin);
  const finish = content.indexOf(end);
  if (start < 0 || finish < start) throw new Error(missingCode);
  return `${content.slice(0, start)}${replacement}${content.slice(finish + end.length)}`;
}

const [guide, agentIntegration] = await Promise.all([
  readFile(guidePath, "utf8"),
  readFile(agentIntegrationPath, "utf8"),
]);
const nextGuide = replaceMarkedSection(
  replaceMarkedSection(
    guide,
    WORK_ITEM_OPERATION_TABLE_BEGIN,
    WORK_ITEM_OPERATION_TABLE_END,
    table,
    "WORK_ITEM_OPERATION_MARKERS_MISSING",
  ),
  MUTATION_ACK_DOCUMENTATION_BEGIN,
  MUTATION_ACK_DOCUMENTATION_END,
  mutationAcknowledgement,
  "GUIDE_MUTATION_ACK_MARKERS_MISSING",
);
const nextAgentIntegration = replaceMarkedSection(
  agentIntegration,
  MUTATION_ACK_DOCUMENTATION_BEGIN,
  MUTATION_ACK_DOCUMENTATION_END,
  mutationAcknowledgement,
  "AGENT_INTEGRATION_MUTATION_ACK_MARKERS_MISSING",
);
await Promise.all([
  writeFile(guidePath, nextGuide, "utf8"),
  writeFile(agentIntegrationPath, nextAgentIntegration, "utf8"),
  writeFile(
    generatedPath,
    `# WorkItem Operation Contracts\n\n> Generated from \`WorkItemOperations\`; do not edit by hand.\n\n${table}\n`,
    "utf8",
  ),
  writeFile(
    generatedMutationAckPath,
    `# Mutation Acknowledgement Contract\n\n> Generated from \`MUTATION_ACK_CONTRACT\`; do not edit by hand.\n\n${mutationAcknowledgement}\n`,
    "utf8",
  ),
]);
