import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

// 同一笔写有两道幂等闸门，读写的是 idempotency_keys 里同一行：
//   - session 侧 executeSessionMutation → #resolveMutationActorInternal，只读不写
//   - kernel 侧 mutate → mutateWithReplay，读且写
// 两侧必须对同一份输入取指纹。只要哪个操作在命令层额外改写了 request（evidence 归一化
// 就是），而 session 侧看到的还是原样，同一笔请求重试就会在 session 闸门先炸
// IDEMPOTENCY_CONFLICT——明明是合法重放。
//
// 这里照 application 层 addProgress 的调法复现：executeSessionMutation 收原始 input，
// 里面的 action 调 repository.addProgress，后者自己归一化 evidence 再进 kernel。

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 8 });
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-fingerprint-parity-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  const project = await manager.createProject({ name: "Fingerprint", sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.code));
  const session = repository.createSession({
    agentId: "parity-agent",
    displayName: "Parity Agent",
    clientKind: "test",
    role: "PRIMARY",
  });
  const actor = { type: "AGENT" as const, id: "parity-agent", sessionId: session.id };
  const objective = repository.createObjective(actor, {
    title: "Parity",
    description: "",
    definitionOfDone: [],
  });
  const taskKey = repository.createWorkItems(actor, "parity-task", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "任务",
      type: "TASK",
      priority: "NORMAL",
      status: "READY",
    },
  ]).items[0]!.key;
  return { repository, session, taskKey };
}

/** 照 application 层 addProgress 的调法：session 闸门收原始 input。 */
function addProgress(
  repository: ProjectRepository,
  sessionId: string,
  opId: string,
  input: Parameters<ProjectRepository["addProgress"]>[2],
) {
  return repository.executeSessionMutation(sessionId, opId, "work.progress", input, (actor) =>
    repository.addProgress(actor, opId, input),
  );
}

describe("两道幂等闸门的指纹口径", () => {
  it("evidence 会被归一化改写时，同一笔请求仍可重放", async () => {
    const { repository, session, taskKey } = await fixture("PQB");
    // PQB-T-1 是非补零写法，rowForTaskKey 接受它，归一化会改写成 PQB-T-0001。
    const loose = taskKey.replace(/-0*(\d+)$/u, "-$1");
    expect(loose).not.toBe(taskKey);

    const input = {
      taskKey,
      summary: "带证据的进度",
      completed: [],
      next: [],
      evidence: [{ kind: "atm_task", value: loose }],
    };

    const first = addProgress(repository, session.id, "evidence-replay", input);
    expect(first.result.ok).toBe(1);

    // 同一个 op_id、同一份请求重试：这是合法重放，不该是冲突。
    const replay = addProgress(repository, session.id, "evidence-replay", input);
    expect(replay.result.progressId).toBe(first.result.progressId);
    expect(replay.result.seq).toBe(first.result.seq);

    // 阳性对照：换成真正不同的请求，同一个 op_id 仍然必须炸。
    expect(() =>
      addProgress(repository, session.id, "evidence-replay", {
        ...input,
        summary: "换了内容",
      }),
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("不带 evidence 的请求重放照旧正常", async () => {
    const { repository, session, taskKey } = await fixture("PQC");
    const input = { taskKey, summary: "无证据", completed: [], next: [] };
    const first = addProgress(repository, session.id, "plain-replay", input);
    const replay = addProgress(repository, session.id, "plain-replay", input);
    expect(replay.result.progressId).toBe(first.result.progressId);
  });
});
