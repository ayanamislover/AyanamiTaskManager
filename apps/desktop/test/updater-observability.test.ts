import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, createUpdateDiagnostics, sanitizeUpdateDetail } from "../src/updater.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "atm-update-diagnostics-"));
  temporary.push(directory);
  return directory;
}

describe("自动更新持久诊断", () => {
  it("持久保存最近结果，重启后仍可查询", () => {
    const dataDir = fixture();
    const diagnostics = createUpdateDiagnostics(dataDir, {
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    diagnostics.record({
      phase: "CHECK",
      outcome: "ERROR",
      code: "CHECK_FAILED",
      detail: "更新清单不可读",
    });

    expect(createUpdateDiagnostics(dataDir).read()).toEqual({
      phase: "CHECK",
      outcome: "ERROR",
      code: "CHECK_FAILED",
      message: "更新清单不可读",
      action: "请检查本地更新目录中的安装包清单（atm-*.json）与安装包是否完整。",
      at: "2026-08-26T12:00:00.000Z",
      version: null,
    });
  });

  it("清洗令牌、认证头、URL 查询密钥和本机绝对路径", () => {
    const unsafe =
      "Authorization: Bearer top.secret token=my-token " +
      "https://updates.test/feed?access_token=url-secret&channel=stable " +
      "C:\\Users\\ayanami\\AppData\\Local\\AyanamiTaskManager\\updates\\RELEASES";
    const safe = sanitizeUpdateDetail(unsafe);

    expect(safe).not.toContain("top.secret");
    expect(safe).not.toContain("my-token");
    expect(safe).not.toContain("url-secret");
    expect(safe).not.toContain("C:\\Users");
    expect(safe).toContain("<redacted>");
    expect(safe).toContain("<local-path>");
  });

  it("日志达到上限后轮转，文件数量和单文件大小均有界", () => {
    const dataDir = fixture();
    const diagnostics = createUpdateDiagnostics(dataDir, {
      maxLogBytes: 420,
      maxLogFiles: 2,
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 12; index += 1) {
      diagnostics.record({
        phase: "DOWNLOAD",
        outcome: "ERROR",
        code: "DOWNLOAD_FAILED",
        detail: `第 ${index} 次下载失败 ${"x".repeat(80)}`,
      });
    }

    const logsDir = join(dataDir, "logs");
    const logFiles = readdirSync(logsDir).filter((name) =>
      /^updater(?:\.\d+)?\.ndjson$/u.test(name),
    );
    expect(logFiles).toHaveLength(2);
    for (const name of logFiles) {
      expect(Buffer.byteLength(readFileSync(join(logsDir, name)))).toBeLessThanOrEqual(420);
    }
    expect(existsSync(join(logsDir, "update-status.json"))).toBe(true);
  });

  it("诊断目录不可写时不影响应用主流程", () => {
    const dataDir = fixture();
    const fileInsteadOfDirectory = join(dataDir, "occupied");
    writeFileSync(fileInsteadOfDirectory, "not a directory", "utf8");
    const diagnostics = createUpdateDiagnostics(fileInsteadOfDirectory);

    expect(() =>
      diagnostics.record({
        phase: "INSTALL",
        outcome: "ERROR",
        code: "INSTALL_FAILED",
        detail: "无法写入",
      }),
    ).not.toThrow();
    expect(diagnostics.read()).toBeNull();
  });

  it("版本号逐段比数字，段数不同时缺的段按 0 算", () => {
    expect(compareVersions("1.1.0", "1.0.27")).toBe(1);
    expect(compareVersions("1.0.9", "1.0.10")).toBe(-1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
  });
});
