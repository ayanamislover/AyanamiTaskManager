import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("same-thread resume handoff", () => {
  it.each(
    (["paused", "retired"] as const).flatMap((outcome) =>
      [false, true].flatMap((resume) =>
        [false, true].map((releaseClaims) => ({ outcome, resume, releaseClaims })),
      ),
    ),
  )(
    "$outcome resume=$resume release=$releaseClaims preserves checkpoint",
    async ({ outcome, resume, releaseClaims }) => {
      const dataDir = await mkdtemp(join(tmpdir(), "atm-session-resume-handoff-"));
      roots.push(dataDir);
      const service = await AyanamiTaskService.open({
        dataDir,
        migrationsRoot: join(process.cwd(), "migrations"),
      });
      services.push(service);
      const project = await service.createProject({
        name: "Resume handoff",
        sourcePath: null,
        code: "RHAND",
      });
      const objective = await service.createObjectiveAsUser(project.code, "resume-objective", {
        title: "Resume handoff",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser(project.code, "resume-task", [
        {
          clientRef: "resume-task",
          objectiveId: objective.id,
          title: "Continue from checkpoint",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: ["resume the exact task"],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const task = created.items[0]!;
      const profiles = await connectProfiledClients(service, "session-resume-handoff");

      try {
        const first = await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "resume-agent",
            client_kind: "test",
            thread_id: "same-thread",
            brief: "none",
          },
        });
        expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
        const firstBody = first.structuredContent as { session: string };

        const claimed = await profiles.actionsClient.callTool({
          name: "atm_task_patch",
          arguments: {
            project: project.code,
            session: firstBody.session,
            op_id: "resume-claim",
            items: [
              {
                task_key: task.key,
                expected_version: task.version,
                operation: "claim",
              },
            ],
          },
        });
        expect(claimed.isError, JSON.stringify(claimed.content)).not.toBe(true);

        const ended = await profiles.coreClient.callTool({
          name: "atm_end",
          arguments: {
            project: project.code,
            session: firstBody.session,
            op_id: "resume-paused-end",
            outcome,
            summary: "checkpoint summary",
            next: ["continue from checkpoint"],
            release_claims: releaseClaims,
          },
        });
        expect(ended.isError, JSON.stringify(ended.content)).not.toBe(true);
        const before = await service.getWorkItem(project.code, task.key);

        const resumed = await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "resume-agent",
            client_kind: "test",
            thread_id: "same-thread",
            ...(resume ? { resume: true } : {}),
            brief: "minimal",
            max_chars: 1200,
          },
        });
        expect(resumed.isError, JSON.stringify(resumed.content)).not.toBe(true);
        const body = resumed.structuredContent as {
          session: string;
          currentTask?: { key: string; claim?: { session: string } | null } | null;
          handoff?: { summary: string; nextAction: string } | null;
        };

        expect(body.session).not.toBe(firstBody.session);
        expect(body.currentTask).toMatchObject({
          key: task.key,
          claim: releaseClaims ? null : { session: firstBody.session },
        });
        expect(body.handoff).toMatchObject({
          summary: "checkpoint summary",
          nextAction: "continue from checkpoint",
        });
        expect(await service.getWorkItem(project.code, task.key)).toEqual(before);
        const database = await service.databases.openProject(project.code);
        const row = database.sqlite
          .prepare("SELECT to_session_id, acknowledged_at FROM handoffs WHERE from_session_id = ?")
          .get(firstBody.session) as {
          to_session_id: string | null;
          acknowledged_at: string | null;
        };
        expect(row.to_session_id).toBe(resume ? body.session : null);
        expect(row.acknowledged_at === null).toBe(!resume);
      } finally {
        await profiles.close();
      }
    },
  );

  it("returns actionable ambiguity when two same-thread predecessors have pending handoffs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-session-resume-ambiguous-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    services.push(service);
    const project = await service.createProject({
      name: "Ambiguous resume handoff",
      sourcePath: null,
      code: "RAMBG",
    });
    const objective = await service.createObjectiveAsUser(project.code, "ambiguous-objective", {
      title: "Ambiguous resume handoff",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItemsAsUser(project.code, "ambiguous-tasks", [
      {
        clientRef: "ambiguous-one",
        objectiveId: objective.id,
        title: "First predecessor task",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
      {
        clientRef: "ambiguous-two",
        objectiveId: objective.id,
        title: "Second predecessor task",
        type: "TASK",
        priority: "HIGH",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
    ]);
    const firstTask = created.items[0]!;
    const secondTask = created.items[1]!;
    const profiles = await connectProfiledClients(service, "session-resume-ambiguous");

    try {
      const begin = async () =>
        profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "ambiguous-agent",
            client_kind: "test",
            thread_id: "same-thread",
            brief: "none",
          },
        });
      const first = await begin();
      const second = await begin();
      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      expect(second.isError, JSON.stringify(second.content)).not.toBe(true);
      const firstSession = (first.structuredContent as { session: string }).session;
      const secondSession = (second.structuredContent as { session: string }).session;

      for (const [session, task] of [
        [firstSession, firstTask],
        [secondSession, secondTask],
      ] as const) {
        const claimed = await profiles.actionsClient.callTool({
          name: "atm_task_patch",
          arguments: {
            project: project.code,
            session,
            op_id: `ambiguous-claim-${task.key}`,
            items: [
              {
                task_key: task.key,
                expected_version: task.version,
                operation: "claim",
              },
            ],
          },
        });
        expect(claimed.isError, JSON.stringify(claimed.content)).not.toBe(true);
        const ended = await profiles.coreClient.callTool({
          name: "atm_end",
          arguments: {
            project: project.code,
            session,
            op_id: `ambiguous-end-${task.key}`,
            outcome: "paused",
            summary: `checkpoint for ${task.key}`,
            next: [`continue ${task.key}`],
            release_claims: false,
          },
        });
        expect(ended.isError, JSON.stringify(ended.content)).not.toBe(true);
      }

      const defaultBegin = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "ambiguous-agent",
          client_kind: "test",
          thread_id: "same-thread",
          brief: "minimal",
        },
      });
      expect(defaultBegin.isError, JSON.stringify(defaultBegin.content)).not.toBe(true);
      const defaultBody = defaultBegin.structuredContent as { session: string; handoff: unknown };
      expect(defaultBody.handoff).toBeNull();
      const defaultEnd = await profiles.coreClient.callTool({
        name: "atm_end",
        arguments: {
          project: project.code,
          session: defaultBody.session,
          op_id: "ambiguous-default-end",
          outcome: "completed",
          summary: "read only",
          release_claims: false,
        },
      });
      expect(defaultEnd.isError, JSON.stringify(defaultEnd.content)).not.toBe(true);
      const resumed = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "ambiguous-agent",
          client_kind: "test",
          thread_id: "same-thread",
          resume: true,
          brief: "minimal",
          max_chars: 1200,
        },
      });
      expect(resumed.isError, JSON.stringify(resumed.content)).toBe(true);
      expect(resumed.structuredContent).toMatchObject({
        code: "SESSION_SUCCESSOR_AMBIGUOUS",
        details: {
          candidates: expect.arrayContaining([firstSession, secondSession]),
          resolution: "predecessor_session_id",
          pending_handoff: true,
        },
      });
      expect(String((resumed.content[0] as { text?: unknown } | undefined)?.text ?? "")).toContain(
        "predecessor_session_id",
      );

      const database = await service.databases.openProject(project.code);
      const handoffs = database.sqlite
        .prepare(
          `SELECT from_session_id, to_session_id, acknowledged_at
           FROM handoffs ORDER BY created_at`,
        )
        .all() as Array<{
        from_session_id: string;
        to_session_id: string | null;
        acknowledged_at: string | null;
      }>;
      expect(handoffs).toHaveLength(2);
      expect(handoffs.map((handoff) => handoff.from_session_id)).toEqual(
        expect.arrayContaining([firstSession, secondSession]),
      );
      expect(handoffs.every((handoff) => handoff.to_session_id === null)).toBe(true);
      expect(handoffs.every((handoff) => handoff.acknowledged_at === null)).toBe(true);
      expect(database.sqlite.prepare("SELECT count(*) AS count FROM agent_sessions").get()).toEqual(
        // Two closed predecessors plus the explicit read-only default begin;
        // the rejected resume must not create a fourth Session.
        { count: 3 },
      );
      expect((await service.getWorkItem(project.code, firstTask.key)).claimedBySessionId).toBe(
        firstSession,
      );
      expect((await service.getWorkItem(project.code, secondTask.key)).claimedBySessionId).toBe(
        secondSession,
      );

      const explicit = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "ambiguous-agent",
          client_kind: "test",
          thread_id: "same-thread",
          resume: true,
          predecessor_session_id: firstSession,
          brief: "minimal",
          max_chars: 1200,
        },
      });
      expect(explicit.isError, JSON.stringify(explicit.content)).not.toBe(true);
      const explicitBody = explicit.structuredContent as {
        session: string;
        handoff?: { summary: string; nextAction: string } | null;
      };
      expect(explicitBody.session).not.toBe(firstSession);
      expect(explicitBody.handoff).toMatchObject({
        summary: `checkpoint for ${firstTask.key}`,
        nextAction: `continue ${firstTask.key}`,
      });
    } finally {
      await profiles.close();
    }
  });

  it.each(
    [false, true].flatMap((resume) =>
      (["thread", "cwd", "role", "agent"] as const).map((mismatch) => ({ resume, mismatch })),
    ),
  )(
    "does not expose $mismatch mismatch handoff with resume=$resume",
    async ({ resume, mismatch }) => {
      const dataDir = await mkdtemp(join(tmpdir(), "atm-session-resume-thread-"));
      roots.push(dataDir);
      const service = await AyanamiTaskService.open({
        dataDir,
        migrationsRoot: join(process.cwd(), "migrations"),
      });
      services.push(service);
      const project = await service.createProject({
        name: "Thread-isolated resume handoff",
        sourcePath: null,
        code: "RTHRD",
      });
      const objective = await service.createObjectiveAsUser(project.code, "thread-objective", {
        title: "Thread-isolated resume handoff",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser(project.code, "thread-task", [
        {
          clientRef: "thread-task",
          objectiveId: objective.id,
          title: "Thread-isolated task",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const task = created.items[0]!;
      const profiles = await connectProfiledClients(service, "session-resume-thread");

      try {
        const first = await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: "thread-agent",
            client_kind: "test",
            thread_id: "source-thread",
            cwd: dataDir,
            brief: "none",
          },
        });
        expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
        const firstSession = (first.structuredContent as { session: string }).session;
        const claimed = await profiles.actionsClient.callTool({
          name: "atm_task_patch",
          arguments: {
            project: project.code,
            session: firstSession,
            op_id: "thread-claim",
            items: [{ task_key: task.key, expected_version: task.version, operation: "claim" }],
          },
        });
        expect(claimed.isError, JSON.stringify(claimed.content)).not.toBe(true);
        const ended = await profiles.coreClient.callTool({
          name: "atm_end",
          arguments: {
            project: project.code,
            session: firstSession,
            op_id: "thread-end",
            outcome: "paused",
            summary: "source-thread checkpoint",
            next: ["continue source-thread"],
            release_claims: false,
          },
        });
        expect(ended.isError, JSON.stringify(ended.content)).not.toBe(true);

        const resumed = await profiles.coreClient.callTool({
          name: "atm_begin",
          arguments: {
            project_code: project.code,
            mode: "project",
            agent_id: mismatch === "agent" ? "other-agent" : "thread-agent",
            client_kind: "test",
            thread_id: mismatch === "thread" ? "other-thread" : "source-thread",
            cwd: mismatch === "cwd" ? tmpdir() : dataDir,
            role: mismatch === "role" ? "REVIEWER" : "PRIMARY",
            ...(resume ? { resume: true } : {}),
            brief: "minimal",
            max_chars: 1200,
          },
        });
        expect(resumed.isError, JSON.stringify(resumed.content)).not.toBe(true);
        const body = resumed.structuredContent as {
          handoff?: unknown;
        };
        expect(body.handoff).toBeNull();
        const database = await service.databases.openProject(project.code);
        expect(
          database.sqlite
            .prepare("SELECT to_session_id FROM handoffs WHERE from_session_id = ?")
            .get(firstSession),
        ).toEqual({ to_session_id: null });
        expect((await service.getWorkItem(project.code, task.key)).claimedBySessionId).toBe(
          firstSession,
        );
      } finally {
        await profiles.close();
      }
    },
  );
});
