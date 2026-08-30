/**
 * composite 任务操作的文档契约。
 *
 * docs/generated/work-item-operations.md 由 `WorkItemOperations` 生成，只覆盖 11 个状态操作；
 * `TaskPatchOperations` 里另外 5 个 composite 操作此前没有任何生成物，agent 查不到条目字段形状，
 * 只能对着 `atm_task_patch` 试错。这里补上，并且：
 *
 * - 操作清单从 registry 派生，新增 composite 操作不会漏文档；
 * - 示例手写（形状推不出可复制的例子），但由用例拿真实 published schema 校验，漂了就红。
 */
import { TASK_PATCH_OPERATION_NAMES, TaskPatchOperations } from "@ayanami-task/protocol";

export const TASK_PATCH_COMPOSITE_DOCUMENTATION_BEGIN = "<!-- TASK_PATCH_COMPOSITE:BEGIN -->";
export const TASK_PATCH_COMPOSITE_DOCUMENTATION_END = "<!-- TASK_PATCH_COMPOSITE:END -->";

export type CompositeOperationDoc = {
  readonly operation: string;
  readonly purpose: string;
  readonly example: Record<string, unknown>;
};

/**
 * 每条 example 都是可直接放进 `atm_task_patch.items` 的单个条目。
 *
 * `expected_version` 的语义**按操作而异**，不要从字段名推断：
 * - checklist_single 落到 `updateChecklist`，比的是 `checklist_items.version`；
 * - checklist_batch 落到 `updateChecklistBatch`，比的是任务版本；
 * - 其余操作都比任务版本。
 *
 * single 与 batch 共用同一套 identity shape，字段名和类型完全一样，只有追到 handler
 * 才看得出分派去了不同的比较器——这里被写错过一次，所以由运行时用例钉住，schema 用例拦不住。
 */
export const TASK_PATCH_COMPOSITE_DOCS: readonly CompositeOperationDoc[] = Object.freeze([
  {
    operation: "verify_and_complete",
    purpose: "一次调用完成 verify 与 complete，省掉中间那次版本读取。",
    example: { operation: "verify_and_complete", task_key: "ATM-T-0001", expected_version: 7 },
  },
  {
    operation: "checklist_single",
    purpose:
      '改一条检查项。`checklist_items` 必须恰好一个元素，不是把 id 放到条目顶层。**`expected_version` 是检查项自己的版本，不是任务版本**（`atm_task_get(view="full")` 的 `checklist[].version`）。`task_key` 会校验归属，检查项不属于它就报 `CHECKLIST_TASK_MISMATCH`。',
    example: {
      operation: "checklist_single",
      task_key: "ATM-T-0001",
      expected_version: 0,
      checklist_items: [
        {
          id: "01M0W8440REDVKEFXQ9TW54HQX",
          status: "DONE",
          evidence: [{ kind: "test_result", value: "186 passed", note: "聚焦回归" }],
        },
      ],
    },
  },
  {
    operation: "checklist_batch",
    purpose:
      "整批改检查项，任一条失败则整批回滚。`expected_version` 是**任务**的版本，并会校验每条检查项确实属于该任务，否则报 `TASK_MISMATCH`。",
    example: {
      operation: "checklist_batch",
      task_key: "ATM-T-0001",
      expected_version: 7,
      checklist_items: [
        { id: "01M0W8440REDVKEFXQ9TW54HQX", status: "DONE", evidence: ["docs/report.md"] },
        { id: "01M0W8440REDVKEFXQ9TW54HQY", status: "SKIPPED" },
      ],
    },
  },
  {
    operation: "review_request",
    purpose: "对 REVIEW 任务发起复核请求，并钉住候选哈希。",
    example: {
      operation: "review_request",
      task_key: "ATM-T-0002",
      expected_version: 3,
      parent_checklist_id: "01M0W8440REDVKEFXQ9TW54HQX",
      expected_parent_checklist_version: 0,
      candidate_hashes: { source: "695feabb8d32f02c" },
    },
  },
  {
    operation: "review_submit",
    purpose: "提交复核结论；`evidence` 至少一条。",
    example: {
      operation: "review_submit",
      task_key: "ATM-T-0002",
      expected_version: 4,
      request_key: "ATM-RR-0001",
      verdict: "APPROVED",
      candidate_hashes: { source: "695feabb8d32f02c" },
      evidence: [{ kind: "git_sha", value: "695feabb8d32f02c", note: "复核基线" }],
    },
  },
]);

export function compositeTaskPatchOperationNames(): readonly string[] {
  return TASK_PATCH_OPERATION_NAMES.filter(
    (operation) => !TaskPatchOperations[operation].batchable,
  );
}

export function generateCompositeTaskPatchDocumentation(): string {
  const documented = new Set(TASK_PATCH_COMPOSITE_DOCS.map((entry) => entry.operation));
  const missing = compositeTaskPatchOperationNames().filter((name) => !documented.has(name));
  if (missing.length > 0) throw new Error(`COMPOSITE_OPERATION_DOC_MISSING:${missing.join(",")}`);

  const sections = TASK_PATCH_COMPOSITE_DOCS.flatMap((entry) => [
    `#### \`${entry.operation}\``,
    "",
    entry.purpose,
    "",
    "```json",
    JSON.stringify(entry.example, null, 2),
    "```",
    "",
  ]);

  return [
    TASK_PATCH_COMPOSITE_DOCUMENTATION_BEGIN,
    "### composite 任务操作（自动生成）",
    "",
    "上一张表只列状态机操作。`atm_task_patch` 还接受下列 composite 操作，它们**不可与其他操作同批**：",
    "`items` 只允许一个元素。",
    "",
    "所有条目共用 `task_key` + `expected_version` 骨架。**`expected_version` 的语义按操作而异**：",
    "`checklist_single` 比的是那条检查项自己的版本，其余操作都比任务版本。字段名相同不代表语义相同。",
    "",
    ...sections,
    TASK_PATCH_COMPOSITE_DOCUMENTATION_END,
  ].join("\n");
}
