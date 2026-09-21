import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AyanamiTaskService } from "../packages/application/src/index.js";
import { createAyanamiToolRegistry, MCP_SURFACE_VERSION } from "../packages/mcp/src/index.js";
import {
  generateMcpToolStatsDocumentation,
  MCP_TOOL_STATS_DOCUMENTATION_BEGIN,
  MCP_TOOL_STATS_DOCUMENTATION_END,
} from "../packages/mcp/src/publication/mcp-documentation.js";
import { generateMcpToolContractMarkdown } from "../packages/mcp/src/tool-publication.js";

const outputPath = join(process.cwd(), "docs", "generated", "mcp-tool-contracts.md");
const readmePath = join(process.cwd(), "README.md");
const registry = createAyanamiToolRegistry({} as AyanamiTaskService);
await mkdir(dirname(outputPath), { recursive: true });
const readme = await readFile(readmePath, "utf8");
const start = readme.indexOf(MCP_TOOL_STATS_DOCUMENTATION_BEGIN);
const finish = readme.indexOf(MCP_TOOL_STATS_DOCUMENTATION_END);
if (start < 0 || finish < start) throw new Error("README_MCP_TOOL_STATS_MARKERS_MISSING");
const generatedStats = generateMcpToolStatsDocumentation(registry, MCP_SURFACE_VERSION);
const nextReadme = `${readme.slice(0, start)}${generatedStats}${readme.slice(
  finish + MCP_TOOL_STATS_DOCUMENTATION_END.length,
)}`;
await Promise.all([
  writeFile(outputPath, generateMcpToolContractMarkdown(registry, MCP_SURFACE_VERSION), "utf8"),
  writeFile(readmePath, nextReadme, "utf8"),
]);
process.stdout.write(`${outputPath}\n`);
