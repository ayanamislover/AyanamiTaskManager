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
    // app.asar is a runtime image, not a repository archive. Keep only the
    // compiled desktop entry, migrations, production dependencies, package
    // metadata and the project license. Guide/docs/integrations are copied as
    // explicit extra resources so they remain available without duplication.
    ignore: [
      /^\/(?!apps(?:\/|$)|migrations(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE$).+/,
      /^\/apps\/(?!desktop(?:\/|$)).+/,
      /^\/apps\/desktop\/(?!dist(?:\/|$)).+/,
      /^\/node_modules\/(?:\.cache(?:\/|$)|\.modules\.yaml$|\.package-map\.json$)/,
      /^\/node_modules\/(?:\.pnpm\/better-sqlite3@[^/]+\/node_modules\/)?better-sqlite3\/build\/(?!(?:Release(?:\/better_sqlite3\.node)?$)).+/,
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
        "https://raw.githubusercontent.com/ayanamislover/AyanamiTaskManager/refs/heads/main/logo.ico",
    }),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
};

export default config;
