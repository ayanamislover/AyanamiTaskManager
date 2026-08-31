import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiToolRegistry } from "./profiles/registry.js";
import { registerPublishedToolHandlers } from "./tool-publication.js";
import { MCP_SURFACE_VERSION, type AyanamiMcpProfile } from "./surface.js";

const profileInstructions: Readonly<Record<AyanamiMcpProfile, string>> = Object.freeze({
  legacy:
    "MCP surface v4 · legacy 兼容入口为尚未重启的旧 Agent 会话保留冻结的 11 工具。请重启 Agent 客户端以重新加载已自动迁移的 core / memory / actions 三 Profile 配置；若仍只看到本入口，请在 ATM 设置中重新安装对应 Agent 集成。",
  core: "MCP surface v4 · core profile。开工调用一次 atm_begin 并直接使用返回的 brief；不要紧接 atm_brief。仅在上下文压缩、长时间离开或明确恢复 working set 时调用 atm_brief。task_list/task_get 按需，结束调用 atm_end。",
  memory:
    "MCP surface v4 · memory profile。Session 由 core profile 建立；本 profile 负责进度、长期记录、本机反馈、搜索与增量读取。",
  actions:
    "MCP surface v4 · actions profile。Session 由 core profile 建立；本 profile 只负责 atm_task_patch 的 16 类规范化任务操作。",
});

export function createAyanamiMcpServer(
  service: AyanamiTaskService,
  options: { profile?: AyanamiMcpProfile } = {},
): Server {
  const profile = options.profile ?? "core";
  const server = new Server(
    { name: "ayanami-task-manager", version: "1.0.25" },
    { capabilities: { tools: {} }, instructions: profileInstructions[profile] },
  );
  registerPublishedToolHandlers(
    server,
    createAyanamiToolRegistry(service),
    profile,
    MCP_SURFACE_VERSION,
  );
  return server;
}
