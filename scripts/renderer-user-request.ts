import type { Page } from "@playwright/test";

export type RendererResponse<T> = { status: number; body: T };

/**
 * 以用户身份调用已打包应用的 REST（ATM-T-0503 / 0509）。
 *
 * runtime/daemon.json 里只有 Agent 凭证，用户专属路由（`/ui/*`、备份、知识写入……）对它返回 403。
 * 界面走的是 renderer → preload 的 runtimeRequest → 主进程代为注入内存里的用户凭证；
 * 验收脚本也走这一条，用户凭证始终不离开主进程，脚本拿不到、也不需要它。
 */
export async function rendererRequest<T = any>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<RendererResponse<T>> {
  await page.waitForFunction(
    () => typeof (window as any).ayanamiDesktop?.runtimeRequest === "function",
    undefined,
    { timeout: 30_000 },
  );
  const output = (await page.evaluate(
    ({ method: verb, path: target, body: payload }) =>
      (window as any).ayanamiDesktop.runtimeRequest({
        method: verb,
        path: target,
        ...(payload === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: payload }),
      }),
    { method, path, body: body === undefined ? undefined : JSON.stringify(body) },
  )) as { status: number; body: string };
  return {
    status: output.status,
    body: output.body ? (JSON.parse(output.body) as T) : (null as T),
  };
}

/** 验收脚本搭数据用：非 2xx 直接抛错，带上响应片段便于定位。 */
export async function rendererPost<T = any>(page: Page, path: string, body: unknown): Promise<T> {
  const response = await rendererRequest<T>(page, "POST", path, body);
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `${path} 以用户身份写入失败：${response.status} ${JSON.stringify(response.body).slice(0, 500)}`,
    );
  return response.body;
}
