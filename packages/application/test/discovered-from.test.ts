import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DISCOVERED_FROM 任务关系", () => {
  it("支持同批前向引用、双向读取与搜索，并且不影响 ready queue", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-discovered-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "发现关系测试",
        sourcePath: null,
        code: "DISC",
      });
      const begun = await service.begin({ projectCode: project.code, agentId: "codex" });
      const objective = await service.createObjective(project.code, begun.session, {
        title: "交付审计修复",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItems(project.code, begun.session, "discover-batch", [
        {
          clientRef: "follow-up",
          objectiveId: objective.id,
          discoveredFromRef: "origin",
          title: "跟进异常索引",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
        {
          clientRef: "origin",
          objectiveId: objective.id,
          title: "完成首轮审计",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]);
      const followUp = created.items[0]!;
      const origin = created.items[1]!;

      expect(await service.getWorkItem(project.code, followUp.key, "full")).toMatchObject({
        relations: [{ direction: "OUTGOING", taskKey: origin.key, type: "DISCOVERED_FROM" }],
      });
      expect(await service.getWorkItem(project.code, origin.key, "full")).toMatchObject({
        relations: [{ direction: "INCOMING", taskKey: followUp.key, type: "DISCOVERED_FROM" }],
      });
      expect(
        (await service.listWorkItems(project.code, { readyOnly: true })).map((item) => item.key),
      ).toEqual(expect.arrayContaining([followUp.key, origin.key]));
      expect(
        (await service.search(project.code, "跟进异常索引")).hits.map((item) => item.entityKey),
      ).toEqual([followUp.key]);

      const exported = await service.exportProject(project.code, "json");
      const snapshot = JSON.parse(readFileSync(exported.path, "utf8")) as {
        data: {
          events: Array<{ aggregate_id: string; type: string; payload_json: string }>;
          work_item_relations: Array<{
            source_id: string;
            target_id: string;
            relation_type: string;
          }>;
        };
      };
      const createdEvent = snapshot.data.events.find(
        (event) => event.type === "work.created" && event.aggregate_id === followUp.id,
      );
      expect(JSON.parse(createdEvent!.payload_json)).toMatchObject({ discoveredFrom: origin.key });
      expect(snapshot.data.work_item_relations).toContainEqual(
        expect.objectContaining({
          source_id: followUp.id,
          target_id: origin.id,
          relation_type: "DISCOVERED_FROM",
        }),
      );
    } finally {
      service.close();
    }
  });
});
