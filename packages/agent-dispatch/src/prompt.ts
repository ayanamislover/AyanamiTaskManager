import type { DispatchOrigin } from "./types.js";

export type DispatchPromptInput = {
  run: string;
  projectCode: string;
  projectName: string;
  cwd: string;
  key: string;
  title: string;
  origin: DispatchOrigin;
  requestedBy?: string;
};

/** 去掉控制字符并截断：标题、项目名、设备名都是用户写的，进提示词前只做排版层面的清理。 */
function clean(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  const points = Array.from(flat);
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join("")}…`;
}

/** JSON 字符串字面量：路径里的反斜杠与引号原样转义，Claude 照抄进工具参数不会出错。 */
function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * 派单会话的提示词（从 stdin 写入，不上命令行）。
 * 只放任务定位信息与工作守则，不放任何密钥或令牌：会话经本机已安装的 ATM MCP 接入。
 */
export function renderDispatchPrompt(input: DispatchPromptInput): string {
  const where = input.origin === "mobile" ? "手机端" : "桌面端";
  const who = input.requestedBy ? `（${clean(input.requestedBy, 60)}）` : "";
  const cwd = literal(input.cwd);
  const code = literal(input.projectCode);
  const key = input.key;
  return [
    "这是 AyanamiTaskManager（ATM）「交给 Claude」派单自动唤起的无头 Claude Code 会话，终端前没有人实时看着。",
    `用户在 ATM ${where}${who}点名把下面这个任务交给你：`,
    "",
    `- 项目：${clean(input.projectName, 120)}（${input.projectCode}）`,
    `- 任务：${key} ${clean(input.title, 200)}`,
    `- 工作目录：${input.cwd}`,
    `- 派单编号：${input.run}`,
    "",
    "请依次完成：",
    "",
    `1. 开工：调用 atm_begin(cwd=${cwd}, agent_id="claude-code", client_kind="claude-code", project_code=${code})，直接使用返回的 brief，不要紧接着再调 atm_brief。`,
    `2. 领取：用 atm_task_get 读取 ${key}，再用 atm_task_patch 对它依次执行 claim、start。` +
      '如果任务已被其他会话领取，或状态已不允许领取，不要抢占：调用 atm_end(outcome="cancelled") 写明原因后结束。',
    "3. 完善目标：阅读相关代码，并用 atm_search 查该任务相关的 ATM 记录与历史进度，" +
      "然后用 atm_task_patch 的 edit 操作把描述改写成清晰、可执行的目标，并补齐 2～6 条可验证的验收标准；" +
      "任务明显过大时用 atm_task_create 拆成子任务。",
    "4. 开始实现：遵守 ATM 规则，只在有意义的状态变化时用 atm_progress_add 写进度，长期决策、事实与风险用 atm_record 记下。" +
      "验收标准全部满足并已自测后，用 atm_task_patch 的 verify_and_complete（或 complete）关闭任务；做不完就保持进行中，留给交接。",
    "5. 需要用户做决定时（需求不明确、多种方案需要取舍、需要凭据或授权），不要猜：" +
      "用 atm_task_patch 的 wait_user 把任务置为 WAITING_USER，把问题写清楚，然后调用 atm_end 交接结束。",
    "6. 不要做发布、推送（git push）、删除数据、改动线上环境等对外或不可逆的操作，除非任务描述明确要求。",
    "7. 结束前调用 atm_end 交接：写清已完成的内容、还没完成的部分和下一步。",
    "",
  ].join("\n");
}
