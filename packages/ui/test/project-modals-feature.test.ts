import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import type { Notify } from "../src/contracts.js";
import { CreateRecordModal } from "../src/features/create-record-modal.js";
import { CreateTaskModal } from "../src/features/create-task-modal.js";
import { ProjectDataModal } from "../src/features/project-data-modal.js";
import { ProjectUpdateModal } from "../src/features/project-update-modal.js";

const featureRoot = join(process.cwd(), "packages", "ui", "src", "features");
const featureNames = [
  "create-task-modal",
  "create-record-modal",
  "project-update-modal",
  "project-data-modal",
] as const;

type ModalProps = {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
};

function client(): AyanamiClient {
  return {
    tasks: { createAsUser: vi.fn() },
    projects: {
      objectives: vi.fn(),
      updates: vi.fn(),
      draftUpdate: vi.fn(),
      publishUpdate: vi.fn(),
    },
    recordAsUser: vi.fn(),
    backups: { list: vi.fn(), create: vi.fn(), restore: vi.fn() },
    data: { exportProject: vi.fn(), previewAgentTask: vi.fn(), applyAgentTask: vi.fn() },
  } as unknown as AyanamiClient;
}

function renderModal(Component: ComponentType<ModalProps>) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["objectives", "ATM"], [{ id: "objective-1", status: "ACTIVE" }]);
  queryClient.setQueryData(["project-updates", "ATM"], []);
  queryClient.setQueryData(["backups", "ATM"], []);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Component, {
        client: client(),
        project: "ATM",
        close: vi.fn(),
        notify: vi.fn(),
      }),
    ),
  );
}

function featureSource(name: (typeof featureNames)[number]) {
  return readFileSync(join(featureRoot, `${name}.tsx`), "utf8");
}

function missingContracts(source: string, contracts: readonly string[]) {
  return contracts.filter((contract) => !source.includes(contract));
}

describe("project modal features", () => {
  it("四类 Modal 保持原有 dialog DOM、自绘控件与文案", () => {
    const cases: Array<[ComponentType<ModalProps>, readonly string[]]> = [
      [CreateTaskModal, ["新建任务", "标题", "说明", "优先级", "验收标准", "创建任务"]],
      [CreateRecordModal, ["新建项目记录", "类型", "重要性", "摘要", "详细内容", "保存记录"]],
      [ProjectUpdateModal, ["发布项目更新", "生成确定性草稿", "生成更新草稿", "取消"]],
      [ProjectDataModal, ["备份、恢复与数据交换", "项目备份", "导出项目", "导入旧 agenttask.md"]],
    ];

    for (const [Component, texts] of cases) {
      const markup = renderModal(Component);
      expect(markup).toContain('role="dialog"');
      expect(markup).toContain('aria-modal="true"');
      expect(markup).toContain('aria-label="关闭"');
      expect(markup).not.toMatch(/<select(?:\s|>)/u);
      for (const text of texts) expect(markup).toContain(text);
    }
  });

  it("保持四类 Modal 的查询、写入、失效与焦点契约", () => {
    const contracts = new Map<(typeof featureNames)[number], readonly string[]>([
      [
        "create-task-modal",
        [
          'queryKey: ["objectives", project]',
          "client.tasks.createAsUser",
          'queryKey: ["tasks", project]',
          'queryKey: ["reconciliation", project]',
          'queryKey: ["brief", project]',
          'queryKey: ["overview"]',
          "useDialogAccessibility(close)",
          "data-dialog-autofocus",
        ],
      ],
      [
        "create-record-modal",
        [
          "client.recordAsUser",
          "recordDraftToUserInput",
          'queryKey: ["records", project]',
          'queryKey: ["overview"]',
          "useDialogAccessibility(close)",
          "data-dialog-autofocus",
        ],
      ],
      [
        "project-update-modal",
        [
          'queryKey: ["project-updates", project]',
          "client.projects.draftUpdate",
          "client.projects.publishUpdate",
          'queryKey: ["brief", project]',
          'queryKey: ["overview"]',
          "useDialogAccessibility(close)",
        ],
      ],
      [
        "project-data-modal",
        [
          'queryKey: ["backups", project]',
          "client.backups.create",
          "client.backups.restore",
          "client.data.exportProject",
          "client.data.previewAgentTask",
          "client.data.applyAgentTask",
          "queryClient.invalidateQueries()",
          "window.confirm(",
          "useDialogAccessibility(close)",
        ],
      ],
    ]);

    for (const name of featureNames) {
      const source = featureSource(name);
      expect(missingContracts(source, contracts.get(name)!)).toEqual([]);
      expect(source).not.toMatch(/<select(?:\s|>)/u);
      expect(source).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
      expect(source.split(/\r?\n/u).length).toBeLessThan(600);
    }
  });

  it("四个 feature 彼此无横向依赖，且关键契约逐项变异会验红", () => {
    for (const name of featureNames) {
      const source = featureSource(name);
      for (const peer of featureNames.filter((candidate) => candidate !== name)) {
        expect(source).not.toContain(`./${peer}.js`);
      }
    }

    const taskSource = featureSource("create-task-modal");
    for (const contract of [
      'queryKey: ["objectives", project]',
      "client.tasks.createAsUser",
      "useDialogAccessibility(close)",
      "data-dialog-autofocus",
    ]) {
      expect(missingContracts(taskSource.replaceAll(contract, "MUTATED"), [contract])).toEqual([
        contract,
      ]);
    }
  });
});
