import {
  RelayError,
  ackKey,
  deviceKey,
  headKey,
  projectKey,
  type AckDoc,
  type CommandDoc,
  type DeviceDoc,
  type HeadDoc,
  type ProjectDoc,
  type RelayChange,
  type TaskCard,
} from "@ayanami-task/sync-protocol";
import type { ChangeBatch, SyncBackend } from "./backend.js";
import { DEMO_HOST, DEMO_SPACE_ID, demoProjects, type DemoProject } from "./demo-data.js";

/**
 * 演示用的「电脑」：只在 VITE_ATM_DEMO=1 的开发构建里打包。
 * 行为照着电脑端连接器走：收到命令后先写回执、把任务放进项目、按需排队派单，
 * 派单随后变成运行中并逐步涨进度——让界面上的每个状态都能被真实地走到。
 */
export type DemoScenario =
  | "live"
  | "offline"
  | "empty"
  | "dispatch-off"
  | "dispatch-failed"
  | "denied"
  | "host-offline";

const WAIT_MS = 25_000;
const DEMO_DISPATCH_ERROR =
  "Claude Code 未登录或登录已过期：在这台电脑的终端运行 claude auth login 后再交给 Claude";

/** 回执去掉信封字段后的部分（在联合类型上逐支 Omit）。 */
type AckBody = AckDoc extends infer Doc
  ? Doc extends AckDoc
    ? Omit<Doc, "v" | "id" | "at">
    : never
  : never;

function hashOf(code: string): string {
  let a = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 20; round += 1) {
    for (const char of `${code}:${round}`) a = Math.imul(a ^ char.charCodeAt(0), 0x01000193) >>> 0;
    out += a.toString(16).padStart(8, "0");
  }
  return out.slice(0, 20);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class DemoBackend implements SyncBackend {
  readonly spaceId = DEMO_SPACE_ID;
  #scenario: DemoScenario = "live";
  #projects: DemoProject[];
  #acks = new Map<string, AckDoc>();
  #queue: RelayChange[] = [];
  #seq = 1;
  #waiters = new Set<() => void>();
  #revision = new Map<string, number>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #headAt = Date.now() - 40_000;
  #deviceAt = Date.now() - 90_000;

  constructor(scenario: DemoScenario = "live") {
    this.#projects = demoProjects(Date.now());
    this.setScenario(scenario);
  }

  setScenario(scenario: DemoScenario): void {
    this.#scenario = scenario;
    this.#headAt =
      scenario === "host-offline" ? Date.now() - 3 * 3_600_000 - 12 * 60_000 : Date.now() - 40_000;
    this.#deviceAt = this.#headAt - 30_000;
    this.#emit(headKey(this.spaceId));
    this.#emit(deviceKey(this.spaceId, DEMO_HOST.id));
  }

  #failIfNeeded(): void {
    if (this.#scenario === "offline") throw new RelayError(0, "NETWORK", "连不上中继：演示离线");
    if (this.#scenario === "denied") throw new RelayError(401, "UNAUTHORIZED", "token 已被吊销");
  }

  async connect(): Promise<{ longPoll: boolean }> {
    await this.#latency();
    this.#failIfNeeded();
    return { longPoll: true };
  }

  async readHead(): Promise<HeadDoc | null> {
    await this.#latency();
    this.#failIfNeeded();
    const projects = this.#scenario === "empty" ? [] : this.#projects;
    return {
      v: 1,
      host: { id: DEMO_HOST.id, name: DEMO_HOST.name, app: "atm/2.0.0" },
      at: iso(this.#headAt),
      dispatch: {
        enabled: this.#scenario !== "dispatch-off",
        mode: "auto",
        running: this.#projects
          .flatMap((p) => p.tasks)
          .filter((t) => t.dispatch?.state === "running").length,
      },
      projects: projects.map((project) => ({
        code: project.code,
        name: project.name,
        h: hashOf(project.code),
        d: `${project.code}-${this.#revision.get(project.code) ?? 0}`,
        counts: {
          active: project.tasks.filter((t) => !["DONE", "CANCELLED"].includes(t.status)).length,
          ready: project.tasks.filter((t) => ["READY", "BACKLOG"].includes(t.status)).length,
          inProgress: project.tasks.filter((t) =>
            ["IN_PROGRESS", "CLAIMED", "VERIFYING"].includes(t.status),
          ).length,
          blocked: project.tasks.filter((t) => t.status === "BLOCKED").length,
          waitingUser: project.tasks.filter((t) => t.status === "WAITING_USER").length,
          doneRecent: project.tasks.filter((t) => t.status === "DONE").length,
        },
        updatedAt: project.tasks.reduce(
          (latest, t) => (t.updatedAt > latest ? t.updatedAt : latest),
          "",
        ),
      })),
    };
  }

  async readProject(hash: string): Promise<ProjectDoc | null> {
    await this.#latency();
    this.#failIfNeeded();
    const project = this.#projects.find((p) => hashOf(p.code) === hash);
    if (!project) return null;
    return {
      v: 1,
      code: project.code,
      name: project.name,
      at: iso(this.#headAt),
      tasks: project.tasks,
    };
  }

  async readDevice(id: string): Promise<DeviceDoc | null> {
    await this.#latency();
    this.#failIfNeeded();
    if (id !== DEMO_HOST.id) return null;
    return {
      v: 1,
      id,
      name: DEMO_HOST.name,
      kind: "windows",
      role: "host",
      app: "atm/2.0.0",
      at: iso(this.#deviceAt),
      state: this.#scenario === "host-offline" ? "offline" : "online",
    };
  }

  async writeCommand(doc: CommandDoc): Promise<void> {
    await this.#latency();
    this.#failIfNeeded();
    if (this.#acks.has(doc.id)) return;
    this.#later(1_400, () => this.#handle(doc));
  }

  async readAck(id: string): Promise<AckDoc | null> {
    await this.#latency();
    this.#failIfNeeded();
    return this.#acks.get(id) ?? null;
  }

  async deleteAck(id: string): Promise<void> {
    this.#acks.delete(id);
  }

  async writeDevice(): Promise<void> {
    this.#failIfNeeded();
  }

  async nextChanges(signal: AbortSignal): Promise<ChangeBatch> {
    this.#failIfNeeded();
    if (this.#queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          wake();
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        };
        const timer = setTimeout(wake, WAIT_MS);
        this.#waiters.add(wake);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.#failIfNeeded();
    const changes = this.#queue.splice(0);
    return { changes, cursor: String(this.#seq), reset: false };
  }

  poke(): void {
    for (const wake of [...this.#waiters]) wake();
  }

  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  // ─── 模拟电脑端的处理 ───

  #latency(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));
  }

  #later(ms: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      action();
    }, ms);
    this.#timers.add(timer);
  }

  #emit(key: string): void {
    this.#queue.push({
      seq: this.#seq++,
      key,
      revision: this.#seq,
      op: "put",
      deviceId: DEMO_HOST.id,
      at: iso(Date.now()),
    });
    this.poke();
  }

  #touch(project: DemoProject): void {
    this.#revision.set(project.code, (this.#revision.get(project.code) ?? 0) + 1);
    this.#headAt = Date.now();
    this.#emit(projectKey(this.spaceId, hashOf(project.code)));
    this.#emit(headKey(this.spaceId));
  }

  #ack(doc: CommandDoc, ack: AckBody): void {
    this.#acks.set(doc.id, { v: 1, id: doc.id, at: iso(Date.now()), ...ack } as AckDoc);
    this.#emit(ackKey(this.spaceId, doc.id));
  }

  #handle(doc: CommandDoc): void {
    const dispatchEnabled = this.#scenario !== "dispatch-off";
    const project = this.#projects.find((p) => p.code === doc.body.project);
    if (!project) {
      this.#ack(doc, {
        ok: false,
        error: { code: "PROJECT_NOT_FOUND", message: "电脑上没有这个项目" },
      });
      return;
    }
    if (doc.type === "task.create") {
      const next =
        Math.max(
          ...this.#projects.flatMap((p) => p.tasks).map((t) => Number(t.key.split("-T-")[1])),
        ) + 1;
      const key = `${project.code}-T-${String(next).padStart(4, "0")}`;
      const card: TaskCard = {
        key,
        title: doc.body.title,
        type: "TASK",
        status: "READY",
        priority: doc.body.priority ?? "NORMAL",
        progress: 0,
        updatedAt: iso(Date.now()),
        ...(doc.body.description ? { desc: doc.body.description } : {}),
        acceptance: [],
      };
      project.tasks.unshift(card);
      const dispatch = doc.body.dispatch && dispatchEnabled;
      if (dispatch) card.dispatch = { state: "queued", at: iso(Date.now()), run: `run-${next}-1` };
      this.#touch(project);
      this.#ack(doc, {
        ok: true,
        result: {
          project: project.code,
          key,
          ...(dispatch ? { dispatch: { run: `run-${next}-1`, state: "queued" as const } } : {}),
          ...(doc.body.dispatch && !dispatchEnabled
            ? { dispatchError: { code: "DISPATCH_DISABLED", message: "电脑端未开启 Claude 派单" } }
            : {}),
        },
      });
      if (dispatch) this.#runDispatch(project, key);
      return;
    }
    const task = project.tasks.find((t) => t.key === doc.body.key);
    if (!task) {
      this.#ack(doc, {
        ok: false,
        error: { code: "TASK_NOT_FOUND", message: "电脑上找不到这个任务" },
      });
      return;
    }
    if (!dispatchEnabled) {
      this.#ack(doc, {
        ok: false,
        error: { code: "DISPATCH_DISABLED", message: "电脑端未开启 Claude 派单" },
      });
      return;
    }
    // 每次派单一个新 run：手机据此判断快照是否已经跟上这一次（重试失败的派单时要用到）。
    const run = `run-${task.key}-${Date.now().toString(36)}`;
    task.dispatch = { state: "queued", at: iso(Date.now()), run };
    this.#touch(project);
    this.#ack(doc, {
      ok: true,
      result: { project: project.code, key: task.key, dispatch: { run, state: "queued" } },
    });
    this.#runDispatch(project, task.key);
  }

  #runDispatch(project: DemoProject, key: string): void {
    this.#later(3_000, () => {
      const task = project.tasks.find((t) => t.key === key);
      if (!task?.dispatch) return;
      if (this.#scenario === "dispatch-failed") {
        // 照电脑端真实报错：Claude Code 没登录，派单拉起即失败，任务仍待领取。
        task.dispatch = {
          ...task.dispatch,
          state: "failed",
          at: iso(Date.now()),
          error: DEMO_DISPATCH_ERROR,
        };
        this.#touch(project);
        return;
      }
      task.dispatch = { ...task.dispatch, state: "running", at: iso(Date.now()) };
      task.status = "IN_PROGRESS";
      task.claim = { agent: "claude-code · 派单", since: iso(Date.now()) };
      task.recent = [
        { at: iso(Date.now()), summary: "已领取任务，正在读代码与 ATM 记录", percent: 5 },
      ];
      task.progress = 5;
      task.updatedAt = iso(Date.now());
      this.#touch(project);
    });
  }
}
