import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiTaskService } from "../src/index.js";
import { trackProjectActivity } from "../src/runtime/project-activity.js";
import { ApplicationServiceRuntime } from "../src/runtime/service-runtime.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openService() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-project-activity-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({ dataDir, migrationsRoot: resolve("migrations") });
  services.push(service);
  return service;
}

/** 一个跨 await 用着缓存连接的请求：先取 repository，再等外部（Git、子进程）回来。 */
class SlowRequest {
  acquired = 0;
  constructor(
    readonly runtime: ApplicationServiceRuntime,
    readonly databases = runtime.databases,
  ) {}
  async use(projectCode: string, external: Promise<void>): Promise<boolean> {
    const repository = await this.runtime.repository(projectCode);
    this.acquired += 1;
    await external;
    return repository.database.sqlite.open;
  }
  /** 连接由下层方法取用，上层拿着它跨 await 再用。 */
  async useNested(projectCode: string, external: Promise<void>): Promise<boolean> {
    const repository = await this.acquire(projectCode);
    this.acquired += 1;
    await external;
    return repository.database.sqlite.open;
  }
  async acquire(projectCode: string) {
    return this.runtime.repository(projectCode);
  }
}
trackProjectActivity(SlowRequest.prototype, (request) => request.databases);

/** 一次挨个遍历很多项目的操作（启动维护、首屏概览），每个项目经由下层方法取用。 */
class Sweep {
  readonly opened: Array<{ sqlite: { open: boolean } }> = [];
  maxOpen = 0;
  constructor(
    readonly runtime: ApplicationServiceRuntime,
    readonly databases = runtime.databases,
  ) {}
  async all(codes: string[]): Promise<void> {
    for (const code of codes) {
      await this.one(code);
      this.maxOpen = Math.max(
        this.maxOpen,
        this.opened.filter((database) => database.sqlite.open).length,
      );
    }
  }
  async one(code: string): Promise<void> {
    this.opened.push((await this.runtime.repository(code)).database);
  }
}
trackProjectActivity(Sweep.prototype, (sweep) => sweep.databases);

describe("在途操作期间取用的项目库连接", () => {
  // Codex R7-P2-1：缓存了五分钟以上的 repository，请求拿到后去等 Git，此时每小时维护按空闲
  // 阈值回收，请求回来得到 "database connection is not open"。
  it("缓存连接被在途请求取用后，空闲回收与容量淘汰都不关它；请求结束后照常回收", async () => {
    const service = await openService();
    const project = await service.createProject({ name: "Slow", sourcePath: null, code: "SLOW" });
    const runtime = new ApplicationServiceRuntime(service.databases);
    const request = new SlowRequest(runtime);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(await request.use(project.code, Promise.resolve())).toBe(true);

    now += 3_600_000;
    let resume!: () => void;
    const pending = request.use(
      project.code,
      new Promise<void>((done) => {
        resume = done;
      }),
    );
    await vi.waitFor(() => expect(request.acquired).toBe(2));
    expect(service.databases.closeIdleProjects(5 * 60_000, now + 3_600_000)).toBe(0);
    // 容量淘汰：再开满 8 个别的库，它最旧也不淘汰。
    for (let index = 0; index < 8; index += 1) {
      const other = await service.createProject({
        name: `Other ${index}`,
        sourcePath: null,
        code: `SOT${index}`,
      });
      await service.databases.openProject(other.id);
    }
    resume();
    expect(await pending).toBe(true);
    // 结束后不再在用，照常按空闲回收。
    expect(service.databases.closeIdleProjects(0, now + 7_200_000)).toBeGreaterThanOrEqual(1);
  });

  it("没登记在途的取用照旧可被回收（阳性对照：守卫认得出回收）", async () => {
    const service = await openService();
    const project = await service.createProject({ name: "Bare", sourcePath: null, code: "BARE" });
    const runtime = new ApplicationServiceRuntime(service.databases);
    const repository = await runtime.repository(project.code);
    expect(service.databases.closeIdleProjects(0, Date.now() + 3_600_000)).toBe(1);
    expect(repository.database.sqlite.open).toBe(false);
  });

  it("服务方法与知识库方法都登记在途，结束（含抛错）后注销", async () => {
    const service = await openService();
    const begin = vi.spyOn(service.databases, "runActivity");
    await service.doctor();
    await service.knowledge.search({});
    await expect(service.getSession("NOPE", "missing")).rejects.toThrow();
    expect(begin).toHaveBeenCalledTimes(3);
    const project = await service.createProject({ name: "Done", sourcePath: null, code: "DONE" });
    await service.databases.openProject(project.id);
    // 取用之后才失败（等 Git 报错）的操作同样注销。
    const failing = new SlowRequest(new ApplicationServiceRuntime(service.databases));
    await expect(
      failing.use(project.code, Promise.reject(new Error("git failed"))),
    ).rejects.toThrow("git failed");
    // 都已结束：没有残留的在途登记挡着回收。
    expect(service.databases.closeIdleProjects(0, Date.now() + 3_600_000)).toBe(1);
  });

  // 只挡别的操作：一次遍历自己挨个取用 12 个项目，照旧按 LRU 淘汰自己先前取的，池子不涨到
  // 项目总数（启动维护遍历 100 个项目时，常驻内存曾因此多出约 85 MiB）。
  it("同一调用链挨个遍历项目时照旧按 LRU 淘汰，连接数不超过上限", async () => {
    const service = await openService();
    const codes = [];
    for (let index = 0; index < 12; index += 1)
      codes.push(
        (
          await service.createProject({
            name: `Sweep ${index}`,
            sourcePath: null,
            code: `SW${index}`,
          })
        ).code,
      );
    const sweep = new Sweep(new ApplicationServiceRuntime(service.databases));
    await sweep.all(codes);
    expect(sweep.opened).toHaveLength(12);
    expect(sweep.maxOpen).toBeLessThanOrEqual(8);
    expect(sweep.opened.filter((database) => database.sqlite.open).length).toBe(8);
  });

  it("全被别的在途操作占着时暂时超出上限，它们结束后收回到上限", async () => {
    const service = await openService();
    const runtime = new ApplicationServiceRuntime(service.databases);
    const requests = [];
    let resume!: () => void;
    const external = new Promise<void>((done) => {
      resume = done;
    });
    for (let index = 0; index < 8; index += 1) {
      const project = await service.createProject({
        name: `Busy ${index}`,
        sourcePath: null,
        code: `BUSY${index}`,
      });
      const request = new SlowRequest(runtime);
      requests.push({ request, pending: request.use(project.code, external) });
      await vi.waitFor(() => expect(request.acquired).toBe(1));
    }
    const extra = await service.createProject({ name: "Extra", sourcePath: null, code: "EXTRA" });
    // 8 个都被在途请求占着：第 9 个只能暂时超出上限。
    const extraDatabase = await service.databases.openProject(extra.id);
    expect(extraDatabase.sqlite.open).toBe(true);
    resume();
    for (const { pending } of requests) expect(await pending).toBe(true);
    // 都结束后收回到上限：池里只剩 8 个开着（关掉的个数就是开着的个数）。
    expect(service.databases.closeIdleProjects(0, Date.now() + 3_600_000)).toBe(8);
  });

  it("下层方法取用、上层跨 await 再用：下层结束后连接仍受上层保护", async () => {
    const service = await openService();
    const project = await service.createProject({ name: "Nest", sourcePath: null, code: "NEST" });
    const request = new SlowRequest(new ApplicationServiceRuntime(service.databases));
    let resume!: () => void;
    const pending = request.useNested(
      project.code,
      new Promise<void>((done) => {
        resume = done;
      }),
    );
    await vi.waitFor(() => expect(request.acquired).toBe(1));
    expect(service.databases.closeIdleProjects(0, Date.now() + 3_600_000)).toBe(0);
    resume();
    expect(await pending).toBe(true);
    expect(service.databases.closeIdleProjects(0, Date.now() + 3_600_000)).toBe(1);
  });
});
