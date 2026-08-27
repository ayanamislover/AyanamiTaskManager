import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AyanamiTaskService } from "../packages/application/src/index.js";
import { createAyanamiToolRegistry, MCP_SURFACE_VERSION } from "../packages/mcp/src/index.js";
import { generateMcpToolContractMarkdown } from "../packages/mcp/src/tool-publication.js";

const outputPath = join(process.cwd(), "docs", "generated", "mcp-tool-contracts.md");
const registry = createAyanamiToolRegistry({} as AyanamiTaskService);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, generateMcpToolContractMarkdown(registry, MCP_SURFACE_VERSION), "utf8");
process.stdout.write(`${outputPath}\n`);
