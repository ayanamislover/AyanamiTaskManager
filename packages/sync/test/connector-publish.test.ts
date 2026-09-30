import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpaceStore,
  deriveSpaceKeys,
  generateSpace,
  headKey,
  projectKey,
} from "@ayanami-task/sync-protocol";
import { buildProjectSnapshot, syncConfigPath } from "../src/index.js";
import {
  cleanupFixtures,
  connect,
  fakeDispatch,
  openFixture,
  phoneFor,
  seedProject,
  seedTask,
  waitFor,
} from "./support/fixture.js";

afterEach(cleanupFixtures);

describe("快照发布", () => {
  it("首次连上把活动项目与任务加密发布，head 列出项目摘要", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA", { name: "阿尔法" }))!;
      const task = await seedTask(fixture.service, "ALPHA", objective, {
        title: "写同步连接器",
        description: "把任务同步到手机",
        acceptance: ["快照去重", "命令幂等"],
      });
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);

      const head = await phone.store.readHead();
      expect(head?.host).toMatchObject({ name: "测试电脑", app: "1.3.0-test" });
      expect(head?.projects.map((project) => project.code)).toEqual(["ALPHA"]);
      const entry = head!.projects[0]!;
      expect(entry.counts).toMatchObject({ active: 1, ready: 1 });
      const doc = await phone.store.readProject(entry.h);
      expect(doc?.name).toBe("阿尔法");
      expect(doc?.tasks).toEqual([
        expect.objectContaining({
          key: task.key,
          title: "写同步连接器",
          status: "READY",
          desc: "把任务同步到手机",
          acceptance: ["快照去重", "命令幂等"],
        }),
      ]);
      // 中继上只有密文：项目名与任务标题都搜不到。
      const stored = JSON.stringify([...fixture.relay.docs.values()]);
      expect(stored).not.toContain("阿尔法");
      expect(stored).not.toContain("写同步连接器");
      expect(stored).not.toContain("ALPHA");
    } finally {
      await fixture.close();
    }
  });

  it("改一个项目的任务只重写该项目与 head；什么都没变就一个字节也不写", async () => {
    const fixture = await openFixture();
    try {
      const alpha = (await seedProject(fixture.service, "ALPHA"))!;
      const beta = (await seedProject(fixture.service, "BETA"))!;
      await seedTask(fixture.service, "ALPHA", alpha, { title: "阿尔法任务" });
      await seedTask(fixture.service, "BETA", beta, { title: "贝塔任务" });
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const space = pairing.spaceId;
      const alphaKey = projectKey(space, await phone.store.projectHash("ALPHA"));
      const betaKey = projectKey(space, await phone.store.projectHash("BETA"));

      // 没有任何变化：同步一次，一个 PUT 都没有。
      let mark = fixture.relay.requests.length;
      await connector.syncNow();
      expect(fixture.relay.putsSince(mark)).toEqual([]);

      // 只触发项目事件、内容不变：重建但摘要相同，也不写。
      mark = fixture.relay.requests.length;
      await fixture.service.reconcileProjection("ALPHA");
      await connector.syncNow();
      expect(fixture.relay.putsSince(mark)).toEqual([]);

      mark = fixture.relay.requests.length;
      await seedTask(fixture.service, "ALPHA", alpha, { title: "阿尔法第二个任务" });
      await waitFor(
        () => fixture.relay.putsSince(mark).includes(headKey(space)),
        "发布阿尔法的变化",
      );
      await connector.syncNow();
      const puts = fixture.relay.putsSince(mark);
      expect(puts).toContain(alphaKey);
      expect(puts).not.toContain(betaKey);
      expect(puts.at(-1)).toBe(headKey(space));
      const head = await phone.store.readHead();
      expect(head?.projects.find((project) => project.code === "ALPHA")?.counts.active).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("项目归档后从 head 移除并删掉项目文档", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      await seedProject(fixture.service, "GONE");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const goneKey = projectKey(pairing.spaceId, await phone.store.projectHash("GONE"));
      expect(fixture.relay.docs.has(goneKey)).toBe(true);

      await fixture.service.archiveProject("GONE");
      await waitFor(() => !fixture.relay.docs.has(goneKey), "删除归档项目的文档");
      await connector.syncNow();
      const head = await phone.store.readHead();
      expect(head?.projects.map((project) => project.code)).toEqual(["ALPHA"]);
    } finally {
      await fixture.close();
    }
  });

  it("任务卡片带派单状态；派单变化会触发重发", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA"))!;
      const task = await seedTask(fixture.service, "ALPHA", objective, { title: "交给 Claude" });
      const dispatch = fakeDispatch();
      const connector = fixture.connector({ dispatch: dispatch.port });
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      await dispatch.port.enqueue({ project: "ALPHA", key: task.key });
      await waitFor(async () => {
        const head = await phone.store.readHead();
        const doc = head ? await phone.store.readProject(head.projects[0]!.h) : null;
        return doc?.tasks[0]?.dispatch?.state === "queued";
      }, "派单状态出现在卡片上");
      const head = await phone.store.readHead();
      expect(head?.dispatch).toEqual({ enabled: true, mode: "auto", running: 0 });
    } finally {
      await fixture.close();
    }
  });

  it("已关闭任务只带 14 天内的，且不带详情字段", async () => {
    const fixture = await openFixture();
    try {
      const objective = (await seedProject(fixture.service, "ALPHA"))!;
      const open = await seedTask(fixture.service, "ALPHA", objective, {
        title: "还开着",
        description: "有详情",
      });
      const closed = await seedTask(fixture.service, "ALPHA", objective, {
        title: "取消掉",
        description: "不该出现",
      });
      await fixture.service.patchWorkItemsAsUser("ALPHA", "cancel-closed", [
        {
          taskKey: closed.key,
          expectedVersion: closed.version,
          operation: "cancel",
          cancelReason: "测试",
        } as never,
      ]);
      const project = { code: "ALPHA", name: "项目 ALPHA" };
      const now = await buildProjectSnapshot(fixture.service, project, null, new Date());
      expect(now.body.tasks.map((card) => card.key)).toEqual([open.key, closed.key]);
      const closedCard = now.body.tasks[1]!;
      expect(closedCard.status).toBe("CANCELLED");
      expect(closedCard.desc).toBeUndefined();
      expect(now.counts).toMatchObject({ active: 1, doneRecent: 0 });

      const later = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      const stale = await buildProjectSnapshot(fixture.service, project, null, later);
      expect(stale.body.tasks.map((card) => card.key)).toEqual([open.key]);
      // 摘要只看内容：同样的内容同样的摘要。
      const again = await buildProjectSnapshot(fixture.service, project, null, new Date());
      expect(again.digest).toBe(now.digest);
    } finally {
      await fixture.close();
    }
  });

  it("配置文件里有 deviceId 与已发布摘要，但没有 token 与空间密钥", async () => {
    const fixture = await openFixture();
    try {
      await seedProject(fixture.service, "ALPHA");
      const connector = fixture.connector();
      const pairing = await connect(connector, fixture.relay);
      const phone = await phoneFor(fixture.relay, pairing.pairingCode);
      const config = readFileSync(syncConfigPath(fixture.dataDir), "utf8");
      expect(JSON.parse(config)).toMatchObject({ enabled: true, spaceId: pairing.spaceId });
      expect(config).not.toContain(fixture.relay.token);
      expect(config).not.toContain(phone.payload.k);
      // 另一把错误的密钥读不了（AAD 与 kid 都绑着空间密钥）。
      const stranger = new SpaceStore({
        client: phone.client,
        keys: await deriveSpaceKeys(generateSpace().secret),
        spaceId: pairing.spaceId,
      });
      await expect(stranger.readHead()).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    } finally {
      await fixture.close();
    }
  });
});
