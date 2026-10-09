/**
 * README 截图那份脱敏的示例数据（结构取自真实项目，字面内容全部重写）与灌数据的步骤。
 *
 * `scripts/render-readme-screenshot.ts`（2.0 daemon）与 `scripts/native-screens.ts`（2.0 与 3.0 两个后端逐页对照）
 * 共用这一份：同一份数据、同一套界面，截出来的差别只来自后端。
 *
 * 路径都相对 `/api/v1`。界面的路由（建项目、`/ui/*`）走 `ui*`，Agent 的路由（session、patch、进度）走 `agent*`：
 * 3.0 的界面路由只在进程内的界面桥上，Agent 令牌够不着它们。
 */

export const PROJECT = "MAPX";
export const PROJECT_NAME = "移动端地图重构";

export type SeedIo = {
  uiGet(path: string): Promise<unknown>;
  uiPost(path: string, body: unknown): Promise<Record<string, unknown>>;
  agentPost(path: string, body: unknown): Promise<Record<string, unknown>>;
};

/**
 * 状态分布刻意铺满：进行中、受阻、等待用户、待验收、可开始都要有，面板才不是空的。
 *
 * 在途状态不直接建出来，而是由 drive 里的真实操作驱动：直接建成 BLOCKED 的条目
 * 没有领取归属、也没有阻塞原因，界面上会显示成「等待条件未说明」。已完成的也一样走完
 * claim → start → verify → complete（3.0 的创建只收 BACKLOG / READY，01 C-17）。
 */
export const WORK_ITEMS = [
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
    status: "READY",
    drive: ["codex", "claim", "start", "verify", "complete"],
  },
  {
    ref: "scene",
    type: "TASK",
    priority: "HIGH",
    title: "实现场景控制器与按需渲染",
    status: "READY",
    drive: ["codex", "claim", "start", "verify", "complete"],
  },
  {
    ref: "shots",
    type: "REVIEW",
    priority: "HIGH",
    title: "三档分辨率截图与视觉验收",
    status: "READY",
    drive: ["codex", "claim", "start", "verify", "complete"],
  },
  {
    ref: "overlay",
    type: "SUBTASK",
    priority: "NORMAL",
    title: "补齐性能 Overlay 的帧率采样",
    status: "READY",
    drive: ["codex", "claim", "start", "verify", "complete"],
  },
  {
    ref: "backend",
    type: "RESEARCH",
    priority: "NORMAL",
    title: "评估三种渲染后端的取舍",
    status: "READY",
    drive: ["codex", "claim", "start", "verify", "complete"],
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

export const BLOCK_REASON =
  "唯一一台同分辨率测试机已借出，归还前无法复现底栏压扁，也无法验证修复。";
export const WAIT_REASON = "需要确认上架渠道与最终应用包名，签名配置随之确定。";

export const RECORDS = [
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

export async function seed(io: SeedIo): Promise<void> {
  await io.uiPost("/projects", {
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
    await io.uiPost("/projects", {
      name: extra.name,
      sourcePath: null,
      code: extra.code,
      description: "示例数据。",
    });
  }

  const objective = await io.uiPost(`/projects/${PROJECT}/ui/objectives`, {
    opId: "seed-objective",
    title: "交付新版地图与场景编辑",
    description: "",
    definitionOfDone: ["三档分辨率视觉验收通过", "真机离线验收通过", "静止态 CPU 占用低于 10%"],
  });
  const objectiveId = objective.id as string;

  await io.uiPost(`/projects/${PROJECT}/ui/milestones`, {
    opId: "seed-milestone-1",
    objectiveId,
    title: "M1 渲染与交互闭环",
    description: "",
    targetDate: null,
  });
  const milestone = await io.uiPost(`/projects/${PROJECT}/ui/milestones`, {
    opId: "seed-milestone-2",
    objectiveId,
    title: "M2 真机验收与发布",
    description: "",
    targetDate: null,
  });

  await io.uiPost(`/projects/${PROJECT}/ui/work-items`, {
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
  const listed = (await io.uiGet(`/projects/${PROJECT}/ui/work-items?limit=100`)) as {
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
      io.agentPost("/sessions", {
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
      const current = (await io.uiGet(`/projects/${PROJECT}/ui/work-items/${taskKey}`)) as {
        version: number;
      };
      await io.agentPost(`/projects/${PROJECT}/work-items/patch`, {
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

  await io.agentPost(`/projects/${PROJECT}/progress-updates`, {
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
  // 任务进度由领着它的那个 session 写（3.0 不许替别的 session 领着的任务报进度）。
  const ownerOf = (ref: string) => {
    const item = WORK_ITEMS.find((candidate) => candidate.ref === ref);
    const agent = item && "drive" in item ? item.drive[0] : "codex";
    return sessionByAgent.get(agent) ?? sessionId;
  };
  for (const update of taskProgress) {
    await io.agentPost(`/projects/${PROJECT}/progress-updates`, {
      session: ownerOf(update.ref),
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
    await io.uiPost(`/projects/${PROJECT}/ui/records`, {
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
