import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";

/**
 * 垃圾箱项目的恢复请求（ATM-T-0493）。
 *
 * Agent 在垃圾箱项目的目录里 begin 时不能自己把项目拉回来：「移入垃圾箱」若能被任何 Agent
 * 静默撤销，就等于没有这个动作。它只能留下一条请求，由用户在项目页垃圾箱里授权或拒绝。
 * 同一项目同时只挂一条 PENDING；同一个 Agent 反复撞上来只累加次数，不刷屏。
 */
export type ProjectRestoreRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export type ProjectRestoreRequestView = {
  id: string;
  projectId: string;
  requestedBy: string;
  sourceCwd: string | null;
  status: ProjectRestoreRequestStatus;
  requestCount: number;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

type Row = {
  id: string;
  project_id: string;
  requested_by: string;
  source_cwd: string | null;
  status: ProjectRestoreRequestStatus;
  request_count: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

function view(row: Row): ProjectRestoreRequestView {
  return {
    id: row.id,
    projectId: row.project_id,
    requestedBy: row.requested_by,
    sourceCwd: row.source_cwd,
    status: row.status,
    requestCount: row.request_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export type RestoreRequestEvents = (
  type: "project.restore_requested" | "project.restore_approved" | "project.restore_rejected",
  projectId: string,
  actor: string,
  payload: Record<string, unknown>,
) => void;

export class ProjectRestoreRequests {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly appendEvent: RestoreRequestEvents,
  ) {}

  pendingFor(projectId: string): ProjectRestoreRequestView | null {
    const row = this.sqlite
      .prepare("SELECT * FROM project_restore_requests WHERE project_id = ? AND status = 'PENDING'")
      .get(projectId) as Row | undefined;
    return row ? view(row) : null;
  }

  get(id: string): ProjectRestoreRequestView {
    const row = this.sqlite
      .prepare("SELECT * FROM project_restore_requests WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row)
      throw new AtmError("PROJECT_RESTORE_REQUEST_NOT_FOUND", {
        message: `恢复请求不存在：${id}`,
        details: { request_id: id },
      });
    return view(row);
  }

  /** 登记或续上一条 PENDING 请求。只有第一次登记记事件，重复触发只更新次数和时间。 */
  request(input: {
    projectId: string;
    projectCode: string;
    requestedBy: string;
    sourceCwd: string | null;
  }): ProjectRestoreRequestView {
    return this.sqlite.transaction(() => {
      const now = nowIso();
      const pending = this.pendingFor(input.projectId);
      if (pending) {
        this.sqlite
          .prepare(
            `UPDATE project_restore_requests
             SET request_count = request_count + 1, requested_by = ?, source_cwd = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.requestedBy, input.sourceCwd, now, pending.id);
        return this.get(pending.id);
      }
      const id = createUlid();
      this.sqlite
        .prepare(
          `INSERT INTO project_restore_requests(
             id, project_id, requested_by, source_cwd, status, request_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?)`,
        )
        .run(id, input.projectId, input.requestedBy, input.sourceCwd, now, now);
      this.appendEvent("project.restore_requested", input.projectId, input.requestedBy, {
        code: input.projectCode,
        requestId: id,
        sourceCwd: input.sourceCwd,
      });
      return this.get(id);
    })();
  }

  /**
   * 结掉一条 PENDING 请求。调用方负责在同一事务里改项目生命周期：授权时恢复项目，
   * 拒绝时项目留在垃圾箱。
   */
  decide(
    id: string,
    decision: "APPROVED" | "REJECTED",
    actor: string,
    projectCode: string,
  ): ProjectRestoreRequestView {
    const request = this.get(id);
    if (request.status !== "PENDING")
      throw new AtmError("PROJECT_RESTORE_REQUEST_DECIDED", {
        message: `恢复请求已处理过：${request.status}`,
        details: { request_id: id, status: request.status, decided_by: request.decidedBy },
      });
    const now = nowIso();
    this.sqlite
      .prepare(
        `UPDATE project_restore_requests
         SET status = ?, decided_at = ?, decided_by = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(decision, now, actor, now, id);
    this.appendEvent(
      decision === "APPROVED" ? "project.restore_approved" : "project.restore_rejected",
      request.projectId,
      actor,
      { code: projectCode, requestId: id, requestedBy: request.requestedBy },
    );
    return this.get(id);
  }
}
