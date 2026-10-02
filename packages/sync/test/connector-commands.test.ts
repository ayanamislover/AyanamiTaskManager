import { afterEach, describe, expect, it } from "vitest";
import { commandKey, type CommandDoc } from "@ayanami-task/sync-protocol";
import { loadSyncConfig, saveSyncConfig, validateCommand } from "../src/index.js";
import {
  cleanupFixtures,
  connect,
  fakeDispatch,
  openFixture,
  phoneFor,
  seedProject,
  seedTask,
  waitFor,
  type Fixture,
} from "./support/fixture.js";

afterEach(cleanupFixtures);

const DAY = 24 * 60 * 60 * 1000;

async function taskKeys(fixture: Fixture, code: string): Promise<string[]> {
  const items = await fixture.service.listWorkItemsForUi(code, {});
  return items.map((item) => item.key);
}

describe("手机命令", () => {
  it("task.create 以 USER 身份建 READY 任务，挂到第一个 ACTIVE 目标，先回执再删命令", async () => {
    const fixture = await openFixture();
    try {
      const objective = await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: {
          project: "ALPHA",
          title: "  手机建的任务 ",
          description: "路上想到的",
          priority: "HIGH",
        },
      });
      const ack = await phone.awaitAck(sent.id);
      expect(ack).toMatchObject({ ok: true, result: { project: "ALPHA" } });
      const key = ack.ok ? ack.result.key : "";
      const task = await fixture.service.getWorkItemForUi("ALPHA", key);
      expect(task).toMatchObject({
        title: "手机建的任务",
        description: "路上想到的",
        priority: "HIGH",
        status: "READY",
        objectiveId: objective,
      });
      await waitFor(
        () => !fixture.relay.docs.has(commandKey(pairing.spaceId, sent.id)),
        "命令被删掉",
      );
      // 回执先于删命令写入。
      const order = fixture.relay.requests
        .filter((request) => request.key?.endsWith(sent.id))
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${request.key!.split("/")[2]}`);
      expect(order.indexOf("PUT ack")).toBeLessThan(order.indexOf("DELETE cmd"));
      // 新任务随后出现在手机快照里。
      await waitFor(async () => {
        const head = await phone.store.readHead();
        const doc = head ? await phone.store.readProject(head.projects[0]!.h) : null;
        return doc?.tasks.some((card) => card.key === key) ?? false;
      }, "新任务进入快照");
    } finally {
      await fixture.close();
    }
  });

  it("同一条命令重放不会建第二个任务：已处理集合与 op_id 两道都挡得住", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "只该有一个" },
      });
      const first = await phone.awaitAck(sent.id);
      const key = first.ok ? first.result.key : "";
      const replay = (doc: CommandDoc) =>
        phone.store.writeObject(commandKey(pairing.spaceId, doc.id), doc, { fresh: true });

      // 第一道：本地已处理集合。重放的命令只被删掉，不再执行（连回执都不重写）。
      const mark = fixture.relay.requests.length;
      await replay(sent);
      await waitFor(
        () => !fixture.relay.docs.has(commandKey(pairing.spaceId, sent.id)),
        "重放命令被删掉",
      );
      expect(await taskKeys(fixture, "ALPHA")).toEqual([key]);
      const ackPuts = fixture.relay.putsSince(mark).filter((put) => put.includes("/ack/"));
      expect(ackPuts).toEqual([]);

      // 第二道：忘掉已处理集合、删掉旧回执，再重放——ATM 的 op_id 幂等返回同一个任务。
      await connector.stop();
      const config = loadSyncConfig(fixture.dataDir);
      saveSyncConfig(fixture.dataDir, { ...config, processed: [] });
      await phone.store.deleteAck(sent.id);
      await replay(sent);
      const restarted = fixture.connector();
      await restarted.start();
      const second = await phone.awaitAck(sent.id);
      expect(second).toMatchObject({ ok: true, result: { key } });
      expect(await taskKeys(fixture, "ALPHA")).toEqual([key]);
    } finally {
      await fixture.close();
    }
  });

  it("过期命令与伪造时间的命令被拒绝，不建任务", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const stale = await phone.store.sendCommand(
        phone.device,
        { type: "task.create", body: { project: "ALPHA", title: "八天前发的" } },
        new Date(Date.now() - 8 * DAY),
      );
      expect(await phone.awaitAck(stale.id)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_EXPIRED" },
      });
      expect(await taskKeys(fixture, "ALPHA")).toEqual([]);

      // 命令 ID 里的时间是现在，明文 at 却写成八天前：ID 与时间对不上。
      const fresh = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "改了时间" },
      });
      const forged = { ...fresh, at: new Date(Date.now() - 8 * DAY).toISOString() };
      expect(() => validateCommand(forged, fresh.id, new Date())).toThrow(
        expect.objectContaining({ code: "COMMAND_INVALID" }),
      );
      const foreign = { ...fresh, device: { id: "m-000000000000", name: "别人" } };
      expect(() => validateCommand(foreign, fresh.id, new Date())).toThrow(
        expect.objectContaining({ code: "COMMAND_INVALID" }),
      );
      expect(() => validateCommand(fresh, fresh.id, new Date())).not.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("项目没有 ACTIVE 目标时补建一个（标题可辨）再建任务；项目不存在时回失败回执", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "BARE", { objective: false });
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const bare = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "BARE", title: "新项目的第一个任务" },
      });
      const bareAck = await phone.awaitAck(bare.id);
      expect(bareAck).toMatchObject({ ok: true, result: { project: "BARE" } });
      const objectives = (await fixture.service.listObjectives("BARE")) as Array<{
        id: string;
        title: string;
        status: string;
      }>;
      expect(objectives).toHaveLength(1);
      expect(objectives[0]?.title).toContain("自动补建");
      expect(await taskKeys(fixture, "BARE")).toEqual([bareAck.ok ? bareAck.result.key : ""]);
      const missing = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "NOPE", title: "没有这个项目" },
      });
      expect(await phone.awaitAck(missing.id)).toMatchObject({
        ok: false,
        error: { code: "PROJECT_NOT_FOUND" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("dispatch:true 调用派单端口；派单被拒时任务照建、回执带 dispatchError", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const accepted = fakeDispatch();
      const connector = fixture.connector({ dispatch: accepted.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "交给 Claude", dispatch: true },
      });
      const ack = await phone.awaitAck(sent.id);
      expect(ack).toMatchObject({
        ok: true,
        result: { dispatch: { run: "run-1", state: "queued" } },
      });
      const key = ack.ok ? ack.result.key : "";
      // 命令 ID 作 requestId 交给派单层，派单按它持久幂等（重放、回执失败后重做都不会再起会话）。
      expect(accepted.calls).toEqual([
        { project: "ALPHA", key, requestedBy: "测试手机", requestId: sent.id },
      ]);
      await connector.stop();

      const rejected = fakeDispatch({
        reject: { code: "DISPATCH_DISABLED", message: "派单未开启" },
      });
      const second = fixture.connector({ dispatch: rejected.port });
      await second.start();
      const again = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "派不出去", dispatch: true },
      });
      const refused = await phone.awaitAck(again.id);
      expect(refused).toMatchObject({
        ok: true,
        result: { dispatchError: { code: "DISPATCH_DISABLED", message: "派单未开启" } },
      });
      expect(refused.ok && refused.result.dispatch).toBeFalsy();
      expect(await taskKeys(fixture, "ALPHA")).toHaveLength(2);

      // task.dispatch 被拒就是整条命令失败，错误码照实透传。
      const dispatchOnly = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key },
      });
      expect(await phone.awaitAck(dispatchOnly.id)).toMatchObject({
        ok: false,
        error: { code: "DISPATCH_DISABLED" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("没有派单端口：task.create 回 DISPATCH_UNAVAILABLE，task.dispatch 失败", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA"))!;
      const existing = await seedTask(fixture.service, "ALPHA", objective, { title: "已有任务" });
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "想派单", dispatch: true },
      });
      expect(await phone.awaitAck(sent.id)).toMatchObject({
        ok: true,
        result: { dispatchError: { code: "DISPATCH_UNAVAILABLE" } },
      });
      const dispatch = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key: existing.key },
      });
      expect(await phone.awaitAck(dispatch.id)).toMatchObject({
        ok: false,
        error: { code: "DISPATCH_UNAVAILABLE" },
      });
      const unknown = await phone.store.sendCommand(phone.device, {
        type: "task.dispatch",
        body: { project: "ALPHA", key: "ALPHA-T-9999" },
      });
      expect(await phone.awaitAck(unknown.id)).toMatchObject({
        ok: false,
        error: { code: "TASK_NOT_FOUND" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("停机期间发来的命令，启动时从 cmd 列表兜底处理", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      await connector.stop();
      const sent = await phone.store.sendCommand(phone.device, {
        type: "task.create",
        body: { project: "ALPHA", title: "电脑关着时发的" },
      });
      // 清空中继的变更记录：连接器看不到这条命令的变更，只能靠启动时列 cmd 兜底。
      fixture.relay.changes = [];
      const restarted = fixture.connector();
      await restarted.start();
      expect(await phone.awaitAck(sent.id)).toMatchObject({ ok: true });
    } finally {
      await fixture.close();
    }
  });
});
