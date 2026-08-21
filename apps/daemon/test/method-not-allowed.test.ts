import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("方法用错不能伪装成路径不存在", () => {
  // checklist 的入口是 PATCH。有人用 POST 试，Fastify 回 404，于是判定「这个端点
  // 不存在」，转去猜 checklist-items / checklist/patch，最后放弃改走绕路方案。
  // 两种情况必须分得开，否则错误信息把人指向错误的方向。
  it("已知路径的错误方法回 405 并列出可用方法，未知路径才回 404", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-405-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-secret" });
    const headers = { authorization: "Bearer local-secret" };
    try {
      const wrongMethod = await app.inject({
        method: "POST",
        url: "/api/v1/projects/ATM/checklist/01ABC",
        headers,
        payload: {},
      });
      expect(wrongMethod.statusCode).toBe(405);
      expect(wrongMethod.headers.allow).toContain("PATCH");
      const body = wrongMethod.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
      expect(body.error.message).toContain("PATCH");
      expect(body.error.message).toContain("POST");

      // 阳性对照：真正不存在的路径仍然是 404，别把两者一起抹平。
      const missing = await app.inject({
        method: "PATCH",
        url: "/api/v1/projects/ATM/checklist-items/01ABC",
        headers,
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

      // 正常路径不受影响。
      const ok = await app.inject({ method: "GET", url: "/api/v1/system/status", headers });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
      service.close();
    }
  }, 60_000);
});
