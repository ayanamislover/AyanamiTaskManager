import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "AyanamiTaskManager",
    name: "AyanamiTaskManager",
    extraResource: ["docs/portable-usage.md", "apps/desktop/resources/mcp-stdio.cjs"],
    ignore: [
      /^\/.git(?:\/|$)/,
      /^\/docs(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
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
      setupExe: "AyanamiTaskManager-Setup-1.0.0-win-x64.exe",
    }),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
};

export default config;
