import { describe, expect, it } from "vitest";
import type { HeadDoc, ProjectDoc, ProjectHead, TaskCard } from "@ayanami-task/sync-protocol";
import {
  applyHead,
  applyProject,
  dropProjectByHash,
  emptySnapshot,
  groupTasks,
  projectSegments,
  projectsToFetch,
  snapshotScope,
  sortProjects,
} from "../src/data/snapshot.js";

const SPACE = "0123456789abcdef01234567";

function projectHead(code: string, d: string, overrides: Partial<ProjectHead> = {}): ProjectHead {
  return {
    code,
    name: `${code} 项目`,
    h: `${code.toLowerCase().padEnd(4, "0")}${"0".repeat(16)}`.slice(0, 20),
    d,
    counts: { active: 0, ready: 0, inProgress: 0, blocked: 0, waitingUser: 0, doneRecent: 0 },
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function head(projects: ProjectHead[]): HeadDoc {
  return {
    v: 1,
    host: { id: "pc-0123456789ab", name: "AYANAMI-PC", app: "atm/1.3.0" },
    at: "2026-09-30T10:00:00.000Z",
    dispatch: { enabled: true, mode: "auto", running: 0 },
    projects,
  };
}

function projectDoc(code: string, tasks: TaskCard[] = []): ProjectDoc {
  return { v: 1, code, name: `${code} 项目`, at: "2026-09-30T10:00:00.000Z", tasks };
}

let serial = 1;
function task(status: TaskCard["status"], overrides: Partial<TaskCard> = {}): TaskCard {
  serial += 1;
  return {
    key: `ATM-T-${String(serial).padStart(4, "0")}`,
    title: `任务 ${serial}`,
    type: "TASK",
    status,
    priority: "NORMAL",
    progress: 0,
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("快照合并", () => {
  it("只重读摘要变化或本地没有的项目，头部去掉的项目随之丢弃", () => {
    const atm = projectHead("ATM", "d1");
    const cloud = projectHead("CLOUD", "c1");
    let snapshot = applyHead(
      emptySnapshot(SPACE, `https://relay.example.com|atm|${SPACE}`),
      head([atm, cloud]),
    );
    expect(projectsToFetch(snapshot).map((p) => p.code)).toEqual(["ATM", "CLOUD"]);

    snapshot = applyProject(snapshot, atm, projectDoc("ATM"));
    snapshot = applyProject(snapshot, cloud, projectDoc("CLOUD"));
    expect(projectsToFetch(snapshot)).toEqual([]);

    const atmChanged = projectHead("ATM", "d2");
    snapshot = applyHead(snapshot, head([atmChanged]));
    expect(Object.keys(snapshot.projects)).toEqual(["ATM"]);
    expect(projectsToFetch(snapshot).map((p) => p.code)).toEqual(["ATM"]);
  });

  it("项目文档与头部项目码不一致时不采纳；按哈希删除", () => {
    const atm = projectHead("ATM", "d1");
    let snapshot = applyHead(
      emptySnapshot(SPACE, `https://relay.example.com|atm|${SPACE}`),
      head([atm]),
    );
    expect(applyProject(snapshot, atm, projectDoc("OTHER"))).toBe(snapshot);
    snapshot = applyProject(snapshot, atm, projectDoc("ATM"));
    expect(dropProjectByHash(snapshot, "f".repeat(20))).toBe(snapshot);
    expect(dropProjectByHash(snapshot, atm.h).projects).toEqual({});
  });
});

describe("任务分组与排序", () => {
  it("按四组归类，组顺序固定，空组也保留", () => {
    const groups = groupTasks([task("READY"), task("DONE")]);
    expect(groups.map((g) => [g.label, g.tasks.length])).toEqual([
      ["进行中", 0],
      ["待领取", 1],
      ["等待与阻塞", 0],
      ["最近完成", 1],
    ]);
  });

  it("组内排序：进行中按状态再按更新；待领取按优先级；等待里等你处理最前", () => {
    const claimed = task("CLAIMED", { updatedAt: "2026-09-30T12:00:00.000Z" });
    const oldProgress = task("IN_PROGRESS", { updatedAt: "2026-09-29T12:00:00.000Z" });
    const newProgress = task("IN_PROGRESS", { updatedAt: "2026-09-30T11:00:00.000Z" });
    const verifying = task("VERIFYING");
    const low = task("READY", { priority: "LOW", updatedAt: "2026-09-30T12:00:00.000Z" });
    const critical = task("BACKLOG", { priority: "CRITICAL" });
    const high = task("READY", { priority: "HIGH" });
    const blocked = task("BLOCKED", { priority: "CRITICAL" });
    const waitingAgent = task("WAITING_AGENT");
    const waitingUser = task("WAITING_USER", { priority: "LOW" });
    const doneOld = task("DONE", { updatedAt: "2026-09-28T10:00:00.000Z" });
    const cancelled = task("CANCELLED", { updatedAt: "2026-09-30T09:00:00.000Z" });

    const groups = groupTasks([
      claimed,
      oldProgress,
      newProgress,
      verifying,
      low,
      critical,
      high,
      blocked,
      waitingAgent,
      waitingUser,
      doneOld,
      cancelled,
    ]);
    const keys = (index: number) => groups[index]!.tasks.map((t) => t.key);
    expect(keys(0)).toEqual([newProgress.key, oldProgress.key, verifying.key, claimed.key]);
    expect(keys(1)).toEqual([critical.key, high.key, low.key]);
    expect(keys(2)).toEqual([waitingUser.key, blocked.key, waitingAgent.key]);
    expect(keys(3)).toEqual([cancelled.key, doneOld.key]);
  });
});

describe("项目卡片", () => {
  it("比例条只保留非零段，等你与受阻合并", () => {
    const p = projectHead("ATM", "d", {
      counts: { active: 9, ready: 4, inProgress: 3, blocked: 1, waitingUser: 2, doneRecent: 0 },
    });
    expect(projectSegments(p)).toEqual([
      { id: "active", value: 3 },
      { id: "waiting", value: 3 },
      { id: "ready", value: 4 },
    ]);
  });

  it("有事等你处理的项目排前面，其余按最近更新", () => {
    const quiet = projectHead("AAA", "d", { updatedAt: "2026-09-30T12:00:00.000Z" });
    const older = projectHead("BBB", "d", { updatedAt: "2026-09-29T12:00:00.000Z" });
    const needsYou = projectHead("CCC", "d", {
      updatedAt: "2026-09-01T00:00:00.000Z",
      counts: { active: 1, ready: 0, inProgress: 0, blocked: 0, waitingUser: 1, doneRecent: 0 },
    });
    expect(sortProjects([older, quiet, needsYou]).map((p) => p.code)).toEqual([
      "CCC",
      "AAA",
      "BBB",
    ]);
  });
});

describe("snapshotScope：换中继、应用、空间任何一项，缓存的快照与游标都不能再用", () => {
  const base = { u: "https://relay.example.com", a: "atm", s: "0123456789abcdef01234567" };
  it("三项都相同才算同一份数据", () => {
    expect(snapshotScope({ ...base })).toBe(snapshotScope(base));
  });
  it.each([
    ["中继地址", { u: "https://cloud.example.com" }],
    ["应用", { a: "atm2" }],
    ["空间", { s: "fedcba9876543210fedcba98" }],
  ])("%s变了就是另一份数据", (_name, change) => {
    expect(snapshotScope({ ...base, ...change })).not.toBe(snapshotScope(base));
  });
  it("三段拼接不会因为分隔符撞在一起", () => {
    expect(snapshotScope({ u: "a|b", a: "c", s: "d" })).not.toBe(
      snapshotScope({ u: "a", a: "b|c", s: "d" }),
    );
  });
});
