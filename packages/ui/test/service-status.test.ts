import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceStatus } from "../src/shell/service-status.js";

const render = (error: unknown, loading: boolean) =>
  renderToStaticMarkup(createElement(ServiceStatus, { error, loading }));

describe("顶栏服务状态", () => {
  it("只说服务连不连得上：连接中、服务正常、服务异常，不借用任务状态词", () => {
    expect(render(null, true)).toContain(">连接中<");
    expect(render(null, false)).toContain(">服务正常<");
    const failed = render(new Error("connect ECONNREFUSED 127.0.0.1:4394"), false);
    expect(failed).toContain(">服务异常<");
    expect(failed).toContain('class="atm-badge atm-service-status danger"');
    expect(failed).toContain('title="无法读取项目列表：connect ECONNREFUSED 127.0.0.1:4394"');
    for (const markup of [render(null, true), render(null, false), failed]) {
      expect(markup).toContain("atm-service-status");
      expect(markup).not.toContain("活动");
      expect(markup).not.toContain("MIGRATION_FAILED");
    }
  });

  it("应用顶栏接的是服务状态组件，不是任务状态徽标", () => {
    const app = readFileSync(join(process.cwd(), "packages", "ui", "src", "app.tsx"), "utf8");
    expect(app).toContain(
      "statusSlot={<ServiceStatus error={projects.error} loading={projects.isPending} />}",
    );
    expect(app).not.toMatch(/statusSlot=\{<Status\b/u);
  });
});
