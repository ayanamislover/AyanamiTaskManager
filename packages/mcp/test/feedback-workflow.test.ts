import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

it("acknowledges blocker transitions and reclassifies waiting without starting or taking a claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "atm-feedback-flow-"));
  const service = await AyanamiTaskService.open({
    dataDir: root,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const profiles = await connectProfiledClients(service, "feedback-flow");
  try {
    await service.createProject({ code: "FLOW", name: "flow", sourcePath: null });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await profiles.client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent as Record<string, any>;
    };
    const begun = await call("atm_begin", { agent_id: "owner", project_code: "FLOW" });
    const session = begun.session;
    await service.createObjective("FLOW", session, {
      title: "flow",
      description: "",
      definitionOfDone: [],
    });
    const created = await call("atm_task_create", {
      project: "FLOW",
      session,
      op_id: "create",
      items: [{ client_ref: "t", title: "task", status: "READY", verification_required: false }],
    });
    const key = created.entities[0].key;
    let version = created.entities[0].version;
    const patch = async (operation: string, extra = {}) => {
      const ack = await call("atm_task_patch", {
        project: "FLOW",
        session,
        op_id: `${operation}-${version}`,
        items: [{ operation, task_key: key, expected_version: version, ...extra }],
      });
      const item = ack.entities.find((each: any) => each.key === key);
      version = item.version;
      return item;
    };
    const started = await patch("start");
    expect(started).toMatchObject({ status: "IN_PROGRESS", claimed_by_session_id: session });
    await patch("wait_agent", { waiting_for: "peer" });
    const progress = await call("atm_progress_add", {
      project: "FLOW",
      session,
      op_id: "block",
      scope: "task",
      task_key: key,
      summary: "cannot contact peer",
      blocker: "channel unavailable",
    });
    const blocked = progress.entities.find((each: any) => each.key === key);
    expect(blocked).toMatchObject({
      status: "BLOCKED",
      waiting_on: null,
      claimed_by_session_id: session,
    });
    version = blocked.version;
    const before = await service.getWorkItem("FLOW", key);
    const waiting = await patch("wait_agent", { waiting_for: "peer review" });
    expect(waiting).toMatchObject({
      status: "WAITING_AGENT",
      waiting_on: "AGENT",
      claimed_by_session_id: session,
      claim_lease_until: blocked.claim_lease_until,
    });
    const detail = await call("atm_task_get", { project: "FLOW", task_key: key, view: "full" });
    expect(detail).toMatchObject({
      claimed_by_session_id: session,
      claim_lease_until: blocked.claim_lease_until,
      blocked_reason: null,
    });
    expect((await service.getWorkItem("FLOW", key)).lastStartedAt).toBe(before.lastStartedAt);
    await patch("verify");
    const done = await patch("verify_and_complete");
    expect(done.status).toBe("DONE");
    const reopened = await patch("reopen");
    expect(reopened).toMatchObject({ status: "IN_PROGRESS", claimed_by_session_id: session });
    // A replay reports the original event state rather than a fresh task query.
    const replay = await call("atm_progress_add", {
      project: "FLOW",
      session,
      op_id: "block",
      scope: "task",
      task_key: key,
      summary: "cannot contact peer",
      blocker: "channel unavailable",
    });
    expect(replay.entities).toEqual(progress.entities);
  } finally {
    await profiles.close();
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
