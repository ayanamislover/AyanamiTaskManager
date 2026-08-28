import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../src/contracts.js";
import { SettingsPage } from "../src/features/settings.js";

const featurePath = join(process.cwd(), "packages", "ui", "src", "features", "settings.tsx");
const panelsPath = join(process.cwd(), "packages", "ui", "src", "features", "settings-panels.tsx");

function client(): AyanamiClient {
  return {
    status: vi.fn(),
    settings: { list: vi.fn(), put: vi.fn() },
  } as unknown as AyanamiClient;
}

function desktop(): DesktopBridge {
  return {
    getMcpConfigs: vi.fn(),
    getAgentIntegrations: vi.fn(),
    manageAgentIntegration: vi.fn(),
    getAutoLaunch: vi.fn(),
    setAutoLaunch: vi.fn(),
    getMemoryProfile: vi.fn(),
    setMemoryProfile: vi.fn(),
    getUpdateStatus: vi.fn(),
    checkForUpdates: vi.fn(),
    copyText: vi.fn(),
  } as unknown as DesktopBridge;
}

function renderSettings() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["status"], {
    ok: true,
    projectCount: 3,
    sqlite: { fts5: true, trigram: true, wal: true, sqliteVersion: "3.50.0" },
    projectionSummary: { healthy: 3, deferred: 0, failed: 0 },
    projectionFailures: [],
  });
  queryClient.setQueryData(
    ["settings"],
    [
      { key: "backup.policy", value: { enabled: true, dailyKeep: 7, weeklyKeep: 4 }, version: 1 },
      { key: "notification.mode", value: "ALL", version: 1 },
      { key: "notification.enabled", value: true, version: 1 },
    ],
  );
  queryClient.setQueryData(["mcp-configs"], {
    streamableHttp: "{}",
    stdio: "{}",
    generic: "{}",
    agentRule: "ATM",
  });
  queryClient.setQueryData(
    ["agent-integrations"],
    [
      {
        client: "CODEX",
        mcpInstalled: true,
        sharesRuleAndSkillsWith: null,
        cliAvailable: true,
        rule: { state: "INSTALLED", version: 1, path: "C:/Users/test/.codex/AGENTS.md" },
        skills: {
          state: "INSTALLED",
          skills: [
            { name: "atm-plan", state: "INSTALLED", version: 1 },
            { name: "atm-task", state: "INSTALLED", version: 1 },
          ],
        },
      },
    ],
  );
  queryClient.setQueryData(["desktop-update-status"], {
    outcome: "ERROR",
    message: "package checksum mismatch",
    action: "更新包校验失败",
    at: "2026-08-28T00:00:00.000Z",
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SettingsPage, { client: client(), desktop: desktop() }),
    ),
  );
}

function settingsSource() {
  return `${readFileSync(featurePath, "utf8")}\n${readFileSync(panelsPath, "utf8")}`;
}

function missingSettingsContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["status"]',
    'queryKey: ["settings"]',
    'queryKey: ["mcp-configs"]',
    'queryKey: ["agent-integrations"]',
    'queryKey: ["desktop-update-status"]',
    "refetchInterval: 30_000",
    '"backup.policy"',
    '"notification.mode"',
    '"notification.enabled"',
    "getAutoLaunch",
    "setAutoLaunch",
    "getMemoryProfile",
    "setMemoryProfile",
    "checkForUpdates",
    'role="radiogroup"',
    'role="radio"',
    "全部通知",
    "仅严重事件",
    "不通知",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Settings feature", () => {
  it("保持服务、Agent/Skill、维护、三档通知和更新诊断 DOM", () => {
    const markup = renderSettings();

    for (const text of [
      "服务与数据库",
      "Agent 接入",
      "atm-plan",
      "atm-task",
      "维护与 Windows",
      "每日备份保留数",
      "全部通知",
      "仅严重事件",
      "不通知",
      "自动更新",
      "package checksum mismatch",
      "更新包校验失败",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('class="atm-settings-grid"');
    expect(markup).toContain('role="radiogroup" aria-label="系统通知级别"');
    expect(markup.match(/role="radio"/gu)).toHaveLength(3);
    expect(markup).not.toMatch(/<select(?:\s|>)/u);
  });

  it("保持 Settings 查询、Mutation、30 秒刷新与 DesktopBridge 契约", () => {
    const source = settingsSource();
    expect(missingSettingsContracts(source)).toEqual([]);
    expect(source).not.toMatch(/<select(?:\s|>)/u);
    expect(source).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(readFileSync(featurePath, "utf8").split(/\r?\n/u).length).toBeLessThan(600);
    expect(readFileSync(panelsPath, "utf8").split(/\r?\n/u).length).toBeLessThan(600);
  });

  it("关键 Settings 契约有阳性变异红灯", () => {
    const source = settingsSource();
    for (const contract of [
      'queryKey: ["settings"]',
      "refetchInterval: 30_000",
      '"notification.mode"',
      "setAutoLaunch",
      "setMemoryProfile",
      "仅严重事件",
    ]) {
      expect(missingSettingsContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});
