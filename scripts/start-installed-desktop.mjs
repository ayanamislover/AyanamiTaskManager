// Use this for local deployment/wake-up, not Start-Process or detached spawn.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA unavailable");
const dataDir = process.env.ATM_DATA_DIR ?? join(process.env.LOCALAPPDATA, "AyanamiTaskManager");
const execPath = join(dataDir, "current", "AyanamiTaskManager.exe");
const bridgePath = join(dataDir, "current", "resources", "mcp-stdio.cjs");
if (!existsSync(execPath) || !existsSync(bridgePath))
  throw new Error("Installed ATM entry not found");
const { wakeDesktop } = createRequire(bridgePath)(bridgePath);
const receipt = await wakeDesktop({ execPath, dataDir });
console.log(JSON.stringify({ requested: true, ...receipt }));
