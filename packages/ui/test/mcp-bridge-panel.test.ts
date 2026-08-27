import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  McpBridgeObservationView,
  McpBridgePanel,
  type McpBridgeObservation,
} from "../src/mcp-bridge-panel.js";

const observation: McpBridgeObservation = {
  sampledAt: "2026-08-27T03:02:03.000Z",
  metric: "PRIVATE_BYTES",
  totalPrivateBytes: 64 * 1024 * 1024,
  bridges: [
    {
      pid: 4101,
      ownerPid: 101,
      ownerName: "codex",
      startedAt: "2026-08-27T02:00:00.000Z",
      privateBytes: 31 * 1024 * 1024,
    },
    {
      pid: 4102,
      ownerPid: 202,
      ownerName: "claude",
      startedAt: "2026-08-27T02:01:00.000Z",
      privateBytes: 33 * 1024 * 1024,
    },
  ],
};

describe("McpBridgePanel", () => {
  it("默认折叠且服务端渲染不触发系统观测", () => {
    const load = vi.fn(async () => observation);
    const markup = renderToStaticMarkup(createElement(McpBridgePanel, { load }));

    expect(markup).toContain('aria-label="展开 MCP bridge 观测"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="mcp-bridge-observation-content" hidden=""');
    expect(markup).not.toContain("刷新观测");
    expect(load).not.toHaveBeenCalled();
  });

  it("逐条展示连接归属并明确累计口径", () => {
    const markup = renderToStaticMarkup(
      createElement(McpBridgeObservationView, {
        observation,
        formatDate: (value: string) => value.slice(11, 19),
      }),
    );

    expect(markup).toContain("2 个连接");
    expect(markup).toContain("2 个客户端进程");
    expect(markup).toContain("64.00 MiB");
    expect(markup).toContain("codex");
    expect(markup).toContain("PID 101");
    expect(markup).toContain("bridge 4101");
    expect(markup).toContain("建立时间");
    expect(markup).toContain("02:00:00");
    expect(markup).toContain("Private Bytes");
    expect(markup).toContain("不把共享映像页重复计入总量");
  });
});
