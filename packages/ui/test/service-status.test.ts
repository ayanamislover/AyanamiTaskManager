import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceStatus } from "../src/shell/service-status.js";

const render = (error: unknown, loading: boolean) =>
  renderToStaticMarkup(createElement(ServiceStatus, { error, loading }));

describe("侧栏服务状态灯", () => {
  it("看得见的只有灯和两个字：正常 / 连接中 / 异常，读屏带「本地服务」前缀", () => {
    expect(render(null, true)).toContain('data-state="connecting"');
    expect(render(null, true)).toContain("本地服务</span>连接中<");
    expect(render(null, false)).toContain("本地服务</span>正常<");
    expect(render(null, false)).not.toContain("服务正常");
    const failed = render(new Error("connect ECONNREFUSED 127.0.0.1:4394"), false);
    expect(failed).toContain("本地服务</span>异常<");
    expect(failed).toContain('data-state="error"');
    expect(failed).toContain('title="无法读取项目列表：connect ECONNREFUSED 127.0.0.1:4394"');
    for (const markup of [render(null, true), render(null, false), failed]) {
      expect(markup).toContain('class="atm-service-status"');
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain("活动");
      expect(markup).not.toContain("MIGRATION_FAILED");
    }
  });

  it("状态灯放在侧栏设置那一行，不再放在顶栏", () => {
    const shell = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "shell", "app-shell.tsx"),
      "utf8",
    );
    const sidebar = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "shell", "sidebar.tsx"),
      "utf8",
    );
    expect(shell).toContain("footerStatus={statusSlot}");
    expect(shell.slice(shell.indexOf('className="atm-top-actions"'))).not.toContain("{statusSlot}");
    expect(sidebar).toMatch(/<span>设置<\/span>\s*<\/button>\s*\{footerStatus\}/u);
  });

  it("应用顶栏接的是服务状态组件，不是任务状态徽标", () => {
    const app = readFileSync(join(process.cwd(), "packages", "ui", "src", "app.tsx"), "utf8");
    expect(app).toContain(
      "statusSlot={<ServiceStatus error={projects.error} loading={projects.isPending} />}",
    );
    expect(app).not.toMatch(/statusSlot=\{<Status\b/u);
  });
});
