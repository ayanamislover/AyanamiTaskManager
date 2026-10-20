import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request as createRequest, test, type Locator, type Page } from "@playwright/test";
import { startRelay, type RunningRelay } from "../../relay/src/server.js";
import {
  DEFAULT_APP_ID,
  DEFAULT_APP_NAME,
  createApp,
  createToken,
} from "../../relay/src/tokens.js";
import {
  RelayClient,
  SpaceStore,
  commandKey,
  decodePairingCode,
  deriveSpaceKeys,
  newCommandId,
  newDeviceId,
  type AckDoc,
  type FetchLike,
} from "../../../packages/sync-protocol/src/index.js";

// 设置页的手机同步与 Claude 自动开工（W7e）：界面经 ui-bridge 走真实的连接器与派单器，没有任何替身。
// 中继是仓库里的 atm-relay，在用例进程里起在 127.0.0.1 上（端口取自真实的 bind）；手机一侧用同一套协议库，
// 拿界面上显示的配对码读写同一个空间。token 只在内存里，不落盘、不打日志；配对码含 token，截图时遮住。
const apiUrl = "http://127.0.0.1:4394/api/v1";
const headers = { authorization: "Bearer e2e-user-token" };
const project = "MOBE2E";
const shots = resolve("output", "playwright");

let relay: RunningRelay | null = null;
let relayToken = "";

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  const dataDir = resolve("output", "e2e", "relay");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  relay = await startRelay({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootstrap: false,
    accessLog: false,
  });
  createApp(relay.db, DEFAULT_APP_ID, DEFAULT_APP_NAME);
  relayToken = createToken(relay.db, DEFAULT_APP_ID, "e2e").plaintext;

  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  await expect
    .poll(
      async () => {
        try {
          return (await api.get(`${apiUrl}/system/status`)).status();
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  const projects = (await (await api.get(`${apiUrl}/projects`)).json()) as Array<{ code: string }>;
  if (!projects.some((p) => p.code === project)) {
    const created = await api.post(`${apiUrl}/projects`, {
      data: { name: "Mobile E2E", sourcePath: null, code: project, description: "手机同步 e2e" },
    });
    expect(created.ok()).toBeTruthy();
  }
  await api.dispose();
});

test.afterAll(async () => {
  await relay?.close();
  relay = null;
});

async function openSettings(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto("/#settings");
  await page.evaluate((value) => {
    window.localStorage.setItem("atm.theme", value);
    window.localStorage.setItem("atm.workspace.expanded", "false");
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
}

async function shoot(section: Locator, name: string, mask: Locator[] = []): Promise<void> {
  await section.scrollIntoViewIfNeeded();
  // 等入场与状态切换的过渡结束再拍。
  await section.page().waitForTimeout(400);
  await section.screenshot({ path: resolve(shots, name), animations: "disabled", mask });
}

/** 手机一侧：用配对码里的中继地址、token 与密钥读写同一个空间。 */
async function phoneFor(code: string) {
  const pairing = decodePairingCode(code);
  const client = new RelayClient({
    baseUrl: pairing.u,
    appId: pairing.a,
    token: pairing.t,
    fetchImpl: fetch as unknown as FetchLike,
  });
  const store = new SpaceStore({
    client,
    keys: await deriveSpaceKeys(pairing.k),
    spaceId: pairing.s,
  });
  return { space: pairing.s, store };
}

test("设置页的手机同步经真实连接器启用、配对并处理手机命令", async ({ page }) => {
  test.setTimeout(120_000);
  await openSettings(page, "light");
  const sync = page.locator("section.atm-settings-sync");
  await expect(sync.getByRole("heading", { name: "手机同步" })).toBeVisible();
  // 真实的连接器：默认关闭，不是「宿主没有启用手机同步」。
  await expect(sync.locator(".atm-sync-lamp")).toHaveText("未启用");
  await expect(sync.getByText("这个 ATM 宿主没有启用手机同步")).toHaveCount(0);

  await sync.getByLabel("中继地址").fill(relay!.url);
  await sync.getByLabel("中继 token").fill(relayToken);
  await sync.getByLabel("本机名称").fill("E2E 电脑");
  await sync.getByRole("button", { name: "测试连接" }).click();
  await expect(sync.getByRole("status")).toContainText("连接正常");
  await expect(sync.getByRole("status")).toContainText("支持长轮询");
  await sync.getByRole("button", { name: "保存并启用" }).click();
  await expect(page.getByText("手机同步已启用").first()).toBeVisible();
  await expect(sync.locator(".atm-sync-lamp")).toHaveText("正常", { timeout: 30_000 });
  await expect(sync.locator(".atm-sync-facts")).toContainText(new URL(relay!.url).host);

  // 添加手机：真实的配对码。
  await sync.getByRole("button", { name: "添加手机" }).click();
  const dialog = page.getByRole("dialog", { name: "添加手机" });
  const codeBox = dialog.getByRole("group", { name: "配对码" });
  await expect(codeBox).toBeVisible();
  const code = (await codeBox.locator("code").textContent())!.trim();
  await shoot(dialog, "w7e-sync-pairing-light.png", [codeBox, dialog.locator(".atm-qr-tile")]);
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toHaveCount(0);

  // 手机上线并发一条建任务的命令：电脑处理、写回执，设置页列出这台手机。
  const phone = await phoneFor(code);
  const device = newDeviceId("m");
  await phone.store.writeDevice({
    v: 1,
    id: device,
    name: "E2E 手机",
    kind: "android",
    role: "client",
    app: "atm-mobile",
    at: new Date().toISOString(),
    state: "online",
  });
  const id = newCommandId(device);
  const title = `手机建的任务 ${Date.now().toString(36)}`;
  await phone.store.writeObject(
    commandKey(phone.space, id),
    {
      v: 1,
      id,
      device: { id: device, name: "E2E 手机" },
      at: new Date().toISOString(),
      type: "task.create",
      body: { project, title },
    },
    { fresh: true },
  );
  let ack: AckDoc | null = null;
  await expect
    .poll(
      async () => {
        ack = await phone.store.readAck(id);
        return ack !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(ack!.ok, JSON.stringify(ack)).toBe(true);
  const key = (ack as unknown as { result: { key: string } }).result.key;
  const api = await createRequest.newContext({ extraHTTPHeaders: headers });
  const item = await api.get(`${apiUrl}/projects/${project}/work-items/${key}`);
  expect(item.ok()).toBeTruthy();
  expect(JSON.stringify(await item.json())).toContain(title);
  await api.dispose();

  const devices = sync.locator(".atm-sync-devices");
  await expect(devices.getByText("E2E 手机")).toBeVisible({ timeout: 30_000 });
  await expect(devices.locator(".atm-badge.success")).toHaveText("在线");
  await shoot(sync, "w7e-sync-enabled-light.png");

  await openSettings(page, "dark");
  await expect(sync.locator(".atm-sync-lamp")).toHaveText("正常", { timeout: 30_000 });
  await expect(devices.getByText("E2E 手机")).toBeVisible();
  await shoot(sync, "w7e-sync-enabled-dark.png");

  // 停用：回到未启用的表单。
  await sync.getByRole("button", { name: "停用同步" }).click();
  await expect(page.getByText("手机同步已停用").first()).toBeVisible();
  await expect(sync.locator(".atm-sync-lamp")).toHaveText("未启用");
  await expect(sync.getByRole("button", { name: "保存并启用" })).toBeVisible();
  await shoot(sync, "w7e-sync-disabled-dark.png");
  await openSettings(page, "light");
  await shoot(sync, "w7e-sync-disabled-light.png");
});

test("设置页的 Claude 自动开工经真实派单器开关并保存", async ({ page }) => {
  await openSettings(page, "light");
  const dispatch = page.locator("section.atm-settings-dispatch");
  await expect(dispatch.getByRole("heading", { name: "Claude 自动开工" })).toBeVisible();
  // 真实的探测：e2e 给的是假 claude（9.9.9，已登录）。
  const claudeRow = dispatch.locator(".atm-row").filter({ hasText: "Claude Code" });
  await expect(claudeRow).toContainText("9.9.9", { timeout: 30_000 });

  const toggle = dispatch.getByRole("button", { name: /^(已开启|已关闭)$/ });
  await expect(toggle).toHaveText("已关闭");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await shoot(dispatch, "w7e-dispatch-off-light.png");
  await toggle.click();
  await expect(page.getByText("Claude 自动开工已开启").first()).toBeVisible();
  await expect(toggle).toHaveText("已开启");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // 写进了派单器的配置：重新载入仍是开着的。
  await openSettings(page, "dark");
  await expect(toggle).toHaveText("已开启");
  await expect(claudeRow).toContainText("9.9.9", { timeout: 30_000 });
  await shoot(dispatch, "w7e-dispatch-on-dark.png");
  await openSettings(page, "light");
  await shoot(dispatch, "w7e-dispatch-on-light.png");

  await toggle.click();
  await expect(page.getByText("Claude 自动开工已关闭").first()).toBeVisible();
  await expect(toggle).toHaveText("已关闭");
  await openSettings(page, "dark");
  await expect(toggle).toHaveText("已关闭");
  await shoot(dispatch, "w7e-dispatch-off-dark.png");
});
