import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { packagePortable, portableZipName } from "../../../scripts/package-native.js";

// 便携目录随用户解压、改名，宿主（install-state `product_version`）从 portable 标记读版本；
// 标记是空的，生产便携版就自报 dev（W8d distribution-smoke 实测）。
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("便携 zip", () => {
  it("portable 标记里写着版本号，其余文件逐字节是版本目录", () => {
    const dir = mkdtempSync(join(process.cwd(), "output", "portable-zip-test-"));
    temporary.push(dir);
    const appDir = join(dir, "app-8.1.2");
    mkdirSync(join(appDir, "resources"), { recursive: true });
    writeFileSync(join(appDir, "AyanamiTaskManager.exe"), "host");
    writeFileSync(join(appDir, "resources", "atm.exe"), "cli");
    const zip = packagePortable({
      version: "8.1.2",
      dir,
      appDir,
      zip: join(dir, "unused.zip"),
      manifest: join(dir, "unused.json"),
      setup: join(dir, "unused.exe"),
    });
    expect(zip).toBe(join(dir, portableZipName("8.1.2")));
    const entries = unzipSync(readFileSync(zip));
    const text = (name: string) => new TextDecoder().decode(entries[name]);
    expect(Object.keys(entries).sort()).toEqual([
      "AyanamiTaskManager-8.1.2/AyanamiTaskManager.exe",
      "AyanamiTaskManager-8.1.2/portable",
      "AyanamiTaskManager-8.1.2/resources/atm.exe",
    ]);
    expect(text("AyanamiTaskManager-8.1.2/portable")).toBe("8.1.2");
    expect(text("AyanamiTaskManager-8.1.2/resources/atm.exe")).toBe("cli");
  });
});
