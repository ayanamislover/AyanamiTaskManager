import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-record-fields-"));
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const app = await buildAyanamiServer({ service, token: "record-fields-token" });
  cleanup.push(async () => {
    await app.close();
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const project = await service.createProject({ name: "Record fields", sourcePath: null, code });
  const begun = await service.begin({
    projectCode: project.code,
    mode: "project",
    agentId: "record-fields-agent",
    role: "PRIMARY",
    signals: {},
  });
  return { app, project, session: String(begun.session) };
}

const auth = { authorization: "Bearer record-fields-token" };

describe("Record topic/subjectKey REST 写入链", () => {
  it("agent REST 精确保存 camelCase topic/subjectKey 并从 record readback 返回", async () => {
    const { app, project, session } = await fixture("RAGENT");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.code}/records`,
      headers: auth,
      payload: {
        session,
        opId: "agent-record-topic",
        kind: "FACT",
        title: "Agent record topic",
        summary: "Agent REST must not strip topic metadata.",
        topic: "  release/1.0.16  ",
        subjectKey: "  candidate:future-v99  ",
      },
    });

    expect(created.statusCode).toBe(201);
    const recordKey = String(created.json().key);
    const readback = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.code}/records/${recordKey}`,
      headers: auth,
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toMatchObject({
      key: recordKey,
      topic: "release/1.0.16",
      subjectKey: "candidate:future-v99",
    });
  });

  it("UI REST 保存 topic/subjectKey，并在重复 topic 回执中返回活动关联 key", async () => {
    const { app, project } = await fixture("RUI");
    const create = (opId: string, title: string, subjectKey: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/ui/records`,
        headers: auth,
        payload: {
          opId,
          kind: "FACT",
          title,
          summary: `${title} summary`,
          topic: "release/duplicate-topic",
          subjectKey,
        },
      });

    const first = await create("ui-record-topic-first", "UI topic first", "artifact:first");
    expect(first.statusCode).toBe(201);
    const second = await create("ui-record-topic-second", "UI topic second", "artifact:second");
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ relatedRecords: [first.json().key] });

    const readback = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.code}/records/${second.json().key}`,
      headers: auth,
    });
    expect(readback.json()).toMatchObject({
      topic: "release/duplicate-topic",
      subjectKey: "artifact:second",
      relatedRecords: [first.json().key],
    });

    const replacement = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.code}/ui/records`,
      headers: auth,
      payload: {
        opId: "ui-record-topic-replacement",
        kind: "FACT",
        title: "UI topic replacement",
        summary: "Superseded records must leave relatedRecords.",
        topic: "release/duplicate-topic",
        subjectKey: "artifact:replacement",
        supersedes: first.json().key,
      },
    });
    expect(replacement.statusCode).toBe(201);
    expect(replacement.json()).toMatchObject({ relatedRecords: [second.json().key] });

    const afterSupersede = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.code}/records/${second.json().key}`,
      headers: auth,
    });
    expect(afterSupersede.json()).toMatchObject({ relatedRecords: [replacement.json().key] });
  });

  it("空白、超长或非法 subjectKey 返回结构化 INVALID_ARGUMENT 且整批零落账", async () => {
    const { app, project } = await fixture("RINVALID");
    const invalidValues = ["   ", `a${"b".repeat(200)}`, "candidate future"];

    for (const [index, subjectKey] of invalidValues.entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.code}/ui/records`,
        headers: auth,
        payload: {
          opId: `ui-invalid-subject-${index}`,
          kind: "FACT",
          title: "Invalid subject key",
          summary: "Invalid input must not create a record.",
          subjectKey,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            issues: expect.arrayContaining([expect.objectContaining({ path: "subjectKey" })]),
          },
        },
      });
    }

    const records = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.code}/records`,
      headers: auth,
    });
    expect(records.statusCode).toBe(200);
    expect(records.json()).toEqual([]);
  });
});
