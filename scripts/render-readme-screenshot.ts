/**
 * 生成 README 里的产品截图。
 *
 * 截图必须是"用起来的样子"，空项目页说明不了任何事。但真实项目不能直接放出去，
 * 所以这里起一个隔离的 daemon + 前端，喂一份脱敏的示例数据再截图：
 * 结构（阶段、状态分布、阻塞、交接、记录类型）取自真实项目，字面内容全部重写。
 *
 * 数据落在 output/ 下（已 gitignore），不碰用户本机的 ATM 数据根。
 *
 *   pnpm exec tsx scripts/render-readme-screenshot.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const DAEMON_PORT = 4396;
const UI_PORT = 9997;
const TOKEN = "readme-shot-token";
const API = `http://127.0.0.1:${DAEMON_PORT}/api/v1`;
const UI = `http://127.0.0.1:${UI_PORT}`;
const PROJECT = "MAPX";
const PROJECT_NAME = "移动端地图重构";

const workspace = resolve(process.cwd());
const dataDir = resolve(workspace, "output", "readme-shot", "data");
if (!dataDir.toLowerCase().startsWith(`${workspace.toLowerCase()}${sep}`)) {
  throw new Error(`READMESHOT_DATA_OUTSIDE_WORKSPACE: ${dataDir}`);
}

const children: ChildProcess[] = [];

function launch(args: string[], env: Record<string, string>): void {
  children.push(
    spawn(process.execPath, args, {
      cwd: workspace,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...env },
    }),
  );
}

async function waitFor(url: string, label: string, init?: RequestInit): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
    } catch {
      // 服务还没起来，继续轮询。
    }
    if (Date.now() > deadline) throw new Error(`TIMEOUT_WAITING_FOR: ${label}`);
    await new Promise((done) => setTimeout(done, 400));
  }
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
  return response.json();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * 状态分布刻意铺满：进行中、受阻、等待用户、待验收、可开始都要有，面板才不是空的。
 *
 * 在途状态不直接建出来，而是由 drive 里的真实操作驱动：直接建成 BLOCKED 的条目
 * 没有领取归属、也没有阻塞原因，界面上会显示成「等待条件未说明」。
 */
const WORK_ITEMS = [
  {
    ref: "epic",
    type: "EPIC",
    priority: "CRITICAL",
    title: "地图手势与场景质量整改",
    status: "READY",
    drive: ["codex", "claim", "start"],
  },
  {
    ref: "baseline",
    type: "TASK",
    priority: "HIGH",
    title: "建立工程基线、架构契约与构建链",
    status: "DONE",
  },
  {
    ref: "scene",
    type: "TASK",
    priority: "HIGH",
    title: "实现场景控制器与按需渲染",
    status: "DONE",
  },
  {
    ref: "shots",
    type: "REVIEW",
    priority: "HIGH",
    title: "三档分辨率截图与视觉验收",
    status: "DONE",
  },
  {
    ref: "overlay",
    type: "SUBTASK",
    priority: "NORMAL",
    title: "补齐性能 Overlay 的帧率采样",
    status: "DONE",
  },
  {
    ref: "backend",
    type: "RESEARCH",
    priority: "NORMAL",
    title: "评估三种渲染后端的取舍",
    status: "DONE",
  },
  {
    ref: "camera",
    type: "TASK",
    priority: "HIGH",
    title: "重写等轴相机的拖拽与选中判定",
    status: "READY",
    drive: ["codex", "claim", "start"],
  },
  {
    ref: "bottombar",
    type: "BUG",
    priority: "CRITICAL",
    title: "底栏按钮在窄屏被压扁",
    status: "READY",
    drive: ["claude", "claim", "start"],
  },
  {
    ref: "material",
    type: "TASK",
    priority: "HIGH",
    title: "升级家具模组的轮廓与材质",
    status: "READY",
    drive: ["codex", "claim", "start", "verify"],
  },
  {
    ref: "device",
    type: "TASK",
    priority: "HIGH",
    title: "真机安装与离线验收",
    status: "READY",
    drive: ["cli", "claim", "start", "block"],
  },
  {
    ref: "channel",
    type: "TASK",
    priority: "NORMAL",
    title: "确认发布渠道与应用包名",
    status: "READY",
    drive: ["cli", "claim", "start", "wait_user"],
  },
  { ref: "icon", type: "TASK", priority: "NORMAL", title: "替换启动图标与启动屏", status: "READY" },
  { ref: "backkey", type: "BUG", priority: "HIGH", title: "返回键二次确认退出", status: "READY" },
  { ref: "i18n", type: "TASK", priority: "LOW", title: "抽取多语言文案", status: "BACKLOG" },
] as const;

const BLOCK_REASON = "唯一一台同分辨率测试机已借出，归还前无法复现底栏压扁，也无法验证修复。";
const WAIT_REASON = "需要确认上架渠道与最终应用包名，签名配置随之确定。";

const RECORDS = [
  {
    kind: "DECISION",
    importance: "HIGH",
    title: "渲染后端选定按需重绘而非常驻渲染循环",
    summary:
      "常驻渲染循环在中端机上稳定占用一个大核，静止场景也不掉负载；改为按需重绘后静止态 CPU 回到个位数。",
  },
  {
    kind: "CONSTRAINT",
    importance: "HIGH",
    title: "场景编辑的坐标换算只允许有一处实现",
    summary:
      "拖拽、选中判定、吸附三条路径各自换算过一次，导致同一手势在三处得到不同结果。统一到单一换算入口。",
  },
  {
    kind: "RISK",
    importance: "CRITICAL",
    title: "真机验收依赖唯一一台测试机",
    summary: "该机型是目前唯一能复现底栏压扁的设备，归还前无法验证修复。需要补一台同分辨率替代机。",
  },
  {
    kind: "LESSON",
    importance: "NORMAL",
    title: "视觉回归必须看渲染截图，用例绿不算验收",
    summary: "底栏压扁在三档分辨率用例里全绿——用例只断言了元素存在，没有断言可见尺寸。",
  },
  {
    kind: "FACT",
    importance: "NORMAL",
    title: "静止场景 CPU 占用从 26% 降到 4%",
    summary:
      "同一台中端机、同一场景、同一采样窗口下的对比数据，来自性能 Overlay 的帧率与占用采样。",
  },
] as const;

async function seed(): Promise<void> {
  await post("/projects", {
    name: PROJECT_NAME,
    sourcePath: null,
    code: PROJECT,
    description: "示例数据：结构取自真实项目，字面内容已全部重写。",
  });
  // 侧栏只有一个项目会显得像玩具；ATM 的常态是同时挂着好几个仓库。
  for (const extra of [
    { code: "SEARCH", name: "本地语义检索" },
    { code: "RELAY", name: "跨 Agent 协作中继" },
  ]) {
    await post("/projects", {
      name: extra.name,
      sourcePath: null,
      code: extra.code,
      description: "示例数据。",
    });
  }

  const objective = await post(`/projects/${PROJECT}/ui/objectives`, {
    opId: "seed-objective",
    title: "交付新版地图与场景编辑",
    description: "",
    definitionOfDone: ["三档分辨率视觉验收通过", "真机离线验收通过", "静止态 CPU 占用低于 10%"],
  });
  const objectiveId = objective.id as string;

  await post(`/projects/${PROJECT}/ui/milestones`, {
    opId: "seed-milestone-1",
    objectiveId,
    title: "M1 渲染与交互闭环",
    description: "",
    targetDate: null,
  });
  const milestone = await post(`/projects/${PROJECT}/ui/milestones`, {
    opId: "seed-milestone-2",
    objectiveId,
    title: "M2 真机验收与发布",
    description: "",
    targetDate: null,
  });

  await post(`/projects/${PROJECT}/ui/work-items`, {
    opId: "seed-work-items",
    items: WORK_ITEMS.map((item) => ({
      clientRef: item.ref,
      objectiveId,
      milestoneId: milestone.id as string,
      title: item.title,
      type: item.type,
      priority: item.priority,
      status: item.status,
      acceptance: [],
      checklist: [],
    })),
  });
  // 创建响应的形状随批量接口变动过；按标题回查 key 更稳，反正标题在这份种子里唯一。
  const listed = (await get(`/projects/${PROJECT}/ui/work-items?limit=100`)) as {
    items: Array<{ key: string; title: string }>;
  };
  const keyByTitle = new Map(listed.items.map((item) => [item.title, item.key]));
  const keyByRef = new Map(
    WORK_ITEMS.map((item) => [item.ref, keyByTitle.get(item.title) ?? ""] as const),
  );

  // 三个不同 client 的 session，让「Agent 与领取」面板反映真实的多端协作形态。
  const sessions = await Promise.all(
    [
      {
        agentId: "codex-scene",
        displayName: "Codex 场景渲染",
        clientKind: "codex",
        role: "PRIMARY",
      },
      {
        agentId: "claude-ui-review",
        displayName: "Claude 视觉复核",
        clientKind: "claude-code",
        role: "REVIEWER",
      },
      { agentId: "release-cli", displayName: "发布流水线", clientKind: "cli", role: "SUBAGENT" },
    ].map((agent, index) =>
      post("/sessions", {
        operationId: `seed-session-${index}`,
        projectCode: PROJECT,
        mode: "project",
        agentId: agent.agentId,
        displayName: agent.displayName,
        clientKind: agent.clientKind,
        role: agent.role,
      }),
    ),
  );
  const sessionId = sessions[0]?.session as string;
  const sessionByAgent = new Map([
    ["codex", sessionId],
    ["claude", sessions[1]?.session as string],
    ["cli", sessions[2]?.session as string],
  ]);

  for (const item of WORK_ITEMS) {
    if (!("drive" in item)) continue;
    const [agent, ...operations] = item.drive;
    const taskKey = keyByRef.get(item.ref) ?? "";
    for (const operation of operations) {
      const current = (await get(`/projects/${PROJECT}/ui/work-items/${taskKey}`)) as {
        version: number;
      };
      await post(`/projects/${PROJECT}/work-items/patch`, {
        session: sessionByAgent.get(agent),
        opId: `seed-${item.ref}-${operation}`,
        items: [
          {
            taskKey,
            expectedVersion: current.version,
            operation,
            ...(operation === "block" ? { blockedReason: BLOCK_REASON } : {}),
            ...(operation === "wait_user" ? { waitingFor: WAIT_REASON } : {}),
          },
        ],
      });
    }
  }

  await post(`/projects/${PROJECT}/progress-updates`, {
    session: sessionId,
    opId: "seed-progress-project",
    scope: "project",
    summary: "渲染与交互闭环收口，转入真机验收；底栏压扁与相机判定两条并行推进。",
    completed: ["按需重绘替换常驻渲染循环", "三档分辨率视觉验收通过"],
    next: ["合并坐标换算入口", "补一台同分辨率替代测试机"],
    health: "AT_RISK",
    evidence: [],
  });

  const taskProgress = [
    {
      ref: "camera",
      percent: 60,
      summary: "拖拽与选中判定已合并到单一坐标换算入口，吸附路径待迁移。",
      next: ["迁移吸附路径", "补一组换算一致性用例"],
    },
    {
      ref: "bottombar",
      percent: 35,
      summary: "已在窄屏复现压扁，定位到底栏用了固定高度而非最小高度。",
      next: ["改为最小高度并补可见尺寸断言"],
    },
    {
      ref: "material",
      percent: 100,
      summary: "轮廓与材质已全量替换，三档分辨率截图已产出，等待视觉复核。",
      next: ["等待复核结论"],
    },
    {
      ref: "epic",
      percent: 45,
      summary: "渲染与交互两条子线收口，真机验收受测试机可用性制约。",
      next: ["解除测试机阻塞后重排真机验收"],
    },
  ] as const;
  for (const update of taskProgress) {
    await post(`/projects/${PROJECT}/progress-updates`, {
      session: sessionId,
      opId: `seed-progress-${update.ref}`,
      scope: "task",
      taskKey: keyByRef.get(update.ref),
      percent: update.percent,
      summary: update.summary,
      completed: [],
      next: [...update.next],
      evidence: [],
    });
  }

  for (const record of RECORDS) {
    await post(`/projects/${PROJECT}/ui/records`, {
      opId: `seed-record-${record.title.slice(0, 8)}`,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      detail: "",
      importance: record.importance,
      scope: "PROJECT",
    });
  }
}

async function shoot(): Promise<void> {
  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"] as const) {
      // 主题必须在页面脚本跑之前写进 localStorage，否则首帧是另一套配色。
      // 每种主题用独立 context 直接落到目标路由：hash 变更不会触发重新路由。
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      await context.addInitScript(`window.localStorage.setItem("atm.theme", "${theme}")`);
      const page = await context.newPage();
      await page.goto(`${UI}/#overview`);
      await page.waitForSelector(".atm-sidebar");
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: resolve(workspace, "docs", "assets", `screenshot-overview-${theme}.png`),
      });
      // 走用户的真实路径：点侧栏。直接改 hash 不会重新路由。
      await page.locator(".atm-sidebar").getByRole("button", { name: PROJECT_NAME }).click();
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: resolve(workspace, "docs", "assets", `screenshot-project-${theme}.png`),
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resolve(workspace, "docs", "assets"), { recursive: true });

  launch(["node_modules/tsx/dist/cli.mjs", "apps/daemon/src/main.ts"], {
    ATM_DATA_DIR: dataDir,
    AYANAMI_TASK_TOKEN: TOKEN,
    AYANAMI_TASK_PORT: String(DAEMON_PORT),
  });
  launch(
    [
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/desktop/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(UI_PORT),
      "--strictPort",
    ],
    { VITE_ATM_ENDPOINT: `http://127.0.0.1:${DAEMON_PORT}`, VITE_ATM_TOKEN: TOKEN },
  );

  await waitFor(`${API}/system/status`, "daemon", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  await waitFor(UI, "vite");
  await seed();
  await shoot();
  process.stdout.write("wrote screenshot-project-light.png and screenshot-project-dark.png\n");
} finally {
  for (const child of children) if (!child.killed) child.kill();
}
