import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, _electron as electron } from "@playwright/test";

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");
const dataDir = join(localAppData, "AyanamiTaskManager");
const screenshot = resolve(join(root, "output", "playwright", "default-history-restored.png"));
if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
await mkdir(join(root, "output", "playwright"), { recursive: true });

const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM_PACKAGED_SMOKE"].includes(entry[0]),
  ),
);
const application = await electron.launch({ executablePath: executable, env: environment });
try {
  const page = await application.firstWindow();
  await page.waitForSelector(".atm-shell");
  await expect(
    page.getByRole("button", { name: /AyanamiTaskManager 自举验收/u }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /AyanamiTaskManager 自举验收/u })
    .first()
    .click();
  await expect(page.getByRole("region", { name: "项目管理摘要" })).toBeVisible();
  await page.getByRole("button", { name: "记录", exact: true }).click();
  await expect(page.getByText("完成版 GitHub 与云端 CI 全绿", { exact: true })).toBeVisible();
  await expect(page.getByText("无边框本地 EXE 全链路实测通过", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshot });

  const runtime = JSON.parse(await readFile(join(dataDir, "runtime", "daemon.json"), "utf8")) as {
    endpoint: string;
    token: string;
  };
  const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  const status = (await response.json()) as { ok?: boolean; projectCount?: number };
  if (!response.ok || status.ok !== true || status.projectCount !== 1)
    throw new Error(`正式数据历史验收失败：${JSON.stringify(status)}`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, dataDir, projectCount: status.projectCount, screenshot })}\n`,
  );
} finally {
  await application.close();
}
