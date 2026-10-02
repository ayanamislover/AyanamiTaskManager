import type { TaskCard } from "@ayanami-task/sync-protocol";

/** 演示数据：仅开发构建使用。内容仿照真实的 ATM 项目，方便把界面在各种长度、状态下看一遍。 */
export type DemoProject = { code: string; name: string; tasks: TaskCard[] };

export const DEMO_SPACE_ID = "de300000000000000000a7a1";
export const DEMO_HOST = { id: "pc-1a2b3c4d5e6f", name: "AYANAMI-PC" };

const MIN = 60_000;
const HOUR = 60 * MIN;

export function demoProjects(now: number): DemoProject[] {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const task = (
    key: string,
    title: string,
    status: TaskCard["status"],
    extra: Partial<TaskCard> = {},
  ): TaskCard => ({
    key,
    title,
    type: "TASK",
    status,
    priority: "NORMAL",
    progress: status === "DONE" ? 100 : 0,
    updatedAt: ago(2 * HOUR),
    ...extra,
  });

  return [
    {
      code: "ATM",
      name: "AyanamiTaskManager",
      tasks: [
        task("ATM-T-0547", "手机 App（Capacitor 8 + React，Kimi K3 协作设计）", "IN_PROGRESS", {
          priority: "HIGH",
          progress: 45,
          updatedAt: ago(4 * MIN),
          claim: { agent: "claude-code-mobile", since: ago(3 * HOUR) },
          desc:
            "配对 / 总览 / 项目 / 任务详情 / 新任务 / 设置六屏，沿用桌面端的二次元柔彩 token；" +
            "原生 HTTP、Keystore 加密存储、扫码、离线缓存、深浅色与系统栏 inset；release 签名 APK 可重复构建。",
          acceptance: [
            "六屏齐全，触控目标不小于 44px",
            "原生 HTTP、Keystore 加密存储、扫码、离线缓存",
            "深浅色跟随系统，系统栏留边在真机上量过",
            "release 签名 APK 可重复构建",
          ],
          checklist: { done: 3, total: 7 },
          recent: [
            {
              at: ago(4 * MIN),
              summary: "同步引擎接上 sync-protocol，命令队列重启后能继续等回执",
              percent: 45,
            },
            {
              at: ago(55 * MIN),
              summary: "Kimi K3 第一轮高保真稿完成，采纳总览卡片与底部操作栏",
              percent: 30,
            },
            {
              at: ago(2 * HOUR),
              summary: "开工：读 docs/mobile-sync.md 与桌面端设计 token",
              percent: 5,
            },
          ],
        }),
        task("ATM-T-0543", "自建中继 atm-relay：node:sqlite 存储、长轮询与限流", "IN_PROGRESS", {
          progress: 70,
          updatedAt: ago(18 * MIN),
          claim: { agent: "codex", since: ago(5 * HOUR) },
          checklist: { done: 5, total: 7 },
          recent: [
            {
              at: ago(18 * MIN),
              summary: "长轮询每 token 4 个上限与 410 游标过期已覆盖测试",
              percent: 70,
            },
          ],
          dispatch: { state: "running", at: ago(40 * MIN), run: "run-0543" },
        }),
        task("ATM-T-0544", "电脑侧同步连接器：快照发布、命令处理与在线状态", "VERIFYING", {
          progress: 90,
          updatedAt: ago(35 * MIN),
          claim: { agent: "claude-code", since: ago(6 * HOUR) },
          checklist: { done: 8, total: 9 },
        }),
        task("ATM-T-0546", "桌面端「手机同步」设置页与配对二维码", "WAITING_USER", {
          priority: "HIGH",
          progress: 60,
          updatedAt: ago(26 * MIN),
          waiting: "需要你决定：配对码是否允许一键复制到剪贴板（剪贴板可能被其它应用读取）",
          claim: { agent: "claude-code", since: ago(4 * HOUR) },
        }),
        task("ATM-T-0549", "暗色模式下滚动条的对比度不足", "BLOCKED", {
          type: "BUG",
          priority: "LOW",
          updatedAt: ago(3 * HOUR),
          blocked: "等 de-electron 分支合并后再改 packages/ui 的全局样式",
        }),
        task("ATM-T-0545", "Claude Code 无头派单：排队、并发与会话日志", "READY", {
          priority: "HIGH",
          updatedAt: ago(50 * MIN),
          desc: "手机勾选「交给 Claude」或桌面按钮时，电脑自动拉起 Claude Code 会话领取任务、完善目标并开工。",
          acceptance: [
            "默认关闭，只处理用户明确要求的任务",
            "并发上限默认 1",
            "会话 ID 持久化，可 claude -r 接着聊",
          ],
          checklist: { done: 0, total: 5 },
        }),
        task("ATM-T-0550", "README 补上手机同步与自建中继的说明", "READY", {
          type: "SUBTASK",
          priority: "LOW",
          updatedAt: ago(5 * HOUR),
        }),
        task("ATM-T-0548", "发布 2.0 大版本：去 Electron 与手机互联一起合并", "BACKLOG", {
          type: "EPIC",
          updatedAt: ago(9 * HOUR),
        }),
        task("ATM-T-0542", "sync-protocol：加密信封、分片与中继客户端", "DONE", {
          updatedAt: ago(70 * MIN),
        }),
        task("ATM-T-0536", "总览查询补索引，冷启动快 3 倍", "DONE", { updatedAt: ago(26 * HOUR) }),
        task("ATM-T-0535", "侧栏滚动条换成柔彩细条", "DONE", {
          type: "BUG",
          updatedAt: ago(30 * HOUR),
        }),
      ],
    },
    {
      code: "CLOUD",
      name: "AyanamiCloud",
      tasks: [
        task("CLOUD-T-0201", "传输助手：收件回执与对端确认", "IN_PROGRESS", {
          progress: 35,
          updatedAt: ago(2 * HOUR),
          claim: { agent: "codex", since: ago(8 * HOUR) },
        }),
        task("CLOUD-T-0199", "局域网直传接入 LocalSend v2", "READY", {
          priority: "HIGH",
          updatedAt: ago(20 * HOUR),
        }),
        task("CLOUD-T-0203", "剪贴板同步的能力提示", "WAITING_AGENT", {
          updatedAt: ago(7 * HOUR),
          waiting: "等传输助手的回执接口合并",
        }),
        task("CLOUD-T-0198", "消息库与文件流真机验收", "DONE", { updatedAt: ago(28 * HOUR) }),
      ],
    },
    {
      code: "PJSK",
      name: "AyanamiPJSK",
      tasks: [
        task("PJSK-T-0088", "多人房间：OCR 识别目标歌曲", "IN_PROGRESS", {
          progress: 20,
          updatedAt: ago(26 * HOUR),
          claim: { agent: "claude-code", since: ago(30 * HOUR) },
        }),
        task("PJSK-T-0091", "快速回房在断线后不触发", "BLOCKED", {
          type: "BUG",
          priority: "CRITICAL",
          updatedAt: ago(27 * HOUR),
          blocked: "需要真机复现：模拟器上网络切换行为不一致",
        }),
        task("PJSK-T-0090", "打虾模式的体力估算", "READY", { updatedAt: ago(3 * 24 * HOUR) }),
      ],
    },
    {
      code: "NOTES",
      name: "读书笔记",
      tasks: [
        task("NOTES-T-0012", "《设计心理学》第三章摘要", "DONE", { updatedAt: ago(4 * 24 * HOUR) }),
        task("NOTES-T-0013", "整理 9 月读书清单", "READY", {
          priority: "LOW",
          updatedAt: ago(6 * 24 * HOUR),
        }),
      ],
    },
  ];
}
