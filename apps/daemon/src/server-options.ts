import type { AyanamiTaskService } from "@ayanami-task/application";

export type AyanamiServerOptions = {
  service: AyanamiTaskService;
  /** Agent 凭证：写进 runtime/daemon.json，MCP bridge、CLI 与按指南直调 REST 的 Agent 都用它。 */
  token: string;
  /**
   * 用户凭证（ATM-T-0503）。只由桌面主进程在内存里生成、经 renderer IPC 注入，从不落盘。
   * 配置后，标了 USER_ONLY 的路由只认它；不配置时退回单 token 模式（独立 daemon、单元测试），
   * 此时唯一的 token 同时代表用户。
   */
  userToken?: string;
  /**
   * 本次启动的时间（ISO 8601）。项目进度条的「已完成」只算这之后完成的任务。
   * 不传时取构建服务器的那一刻：桌面端在启动时进程内构建，正好就是「本次 ATM 启动」。
   */
  startedAt?: string;
};
