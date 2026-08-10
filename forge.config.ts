import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  .version as string;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "AyanamiTaskManager",
    name: "AyanamiTaskManager",
    icon: "logo.ico",
    extraResource: [
      "logo.png",
      "ATM_AGENT_GUIDE.md",
      "docs",
      "integrations",
      "apps/desktop/resources/mcp-stdio.cjs",
    ],
    ignore: [
      /^\/.git(?:\/|$)/,
      /^\/.ayanami-task(?:\/|$)/,
      /^\/.playwright-cli(?:\/|$)/,
      /^\/docs(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/output(?:\/|$)/,
      /^\/playwright-report(?:\/|$)/,
      /^\/test-results(?:\/|$)/,
      /^\/plans(?:\/|$)/,
      /^\/apps\/desktop\/e2e(?:\/|$)/,
      /^\/AyanamiTaskManager_Development_Spec_CN_v2\.md$/,
      /^\/agents_task\.md$/,
    ],
  },
  // better-sqlite3 13 ships a Node-API prebuild that is verified under the
  // bundled Electron runtime; rebuilding it needlessly requires a compiler.
  rebuildConfig: { onlyModules: [] },
  makers: [
    new MakerSquirrel({
      name: "AyanamiTaskManagerDesktop",
      setupExe: `AyanamiTaskManager-Setup-${packageVersion}-win-x64.exe`,
      setupIcon: "logo.ico",
      iconUrl:
        "https://raw.githubusercontent.com/ayanamislover/AyanamiTaskManager/refs/heads/ayanamislover/complete-implementation/logo.ico",
    }),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
};

export default config;
