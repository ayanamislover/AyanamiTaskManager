import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { AyanamiClient } from "@ayanami-task/client";
import { createUlid, RecordKindSchema } from "@ayanami-task/protocol";
import { discoverDaemon } from "./runtime.js";

type GlobalOptions = { json?: boolean; compact?: boolean };

function display(value: unknown, options: GlobalOptions, write: (text: string) => void): void {
  if (options.json) {
    write(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return write("没有记录。");
    write(
      value
        .map(
          (row: any) =>
            `${row.code ?? row.key ?? row.entity_key ?? "•"}  ${row.name ?? row.title ?? row.summary ?? ""}`,
        )
        .join("\n"),
    );
    return;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    write(
      Object.entries(row)
        .filter(
          ([, item]) => !options.compact || (item !== null && item !== "" && !Array.isArray(item)),
        )
        .map(
          ([key, item]) =>
            `${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
        )
        .join("\n"),
    );
    return;
  }
  write(String(value));
}

function projectFromTaskKey(key: string): string {
  const match = /^(.+)-T-\d+$/iu.exec(key);
  if (!match) throw new Error(`无效任务键：${key}`);
  return match[1]!.toUpperCase();
}

export function createCliProgram(
  dependencies: {
    client?: AyanamiClient;
    write?: (text: string) => void;
  } = {},
): Command {
  const program = new Command();
  const write = dependencies.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  let clientPromise: Promise<AyanamiClient> | null = null;
  const client = async () => {
    if (dependencies.client) return dependencies.client;
    clientPromise ??= (async () => {
      const runtime = await discoverDaemon();
      return new AyanamiClient(runtime);
    })();
    return clientPromise;
  };
  const show = (value: unknown) => display(value, program.opts<GlobalOptions>(), write);
  const inSession = async <T>(
    project: string,
    title: string,
    action: (session: string) => Promise<T>,
  ) => {
    const api = await client();
    const begun = await api.sessions.begin({
      projectCode: project,
      mode: "project",
      agentId: "atm-cli",
      clientKind: "cli",
      title,
    });
    const session = String(begun.session);
    try {
      const value = await action(session);
      await api.sessions.end(session, {
        project,
        opId: `cli-end-${createUlid()}`,
        outcome: "completed",
        summary: title,
        next: [],
        releaseClaims: true,
      });
      return value;
    } catch (error) {
      await api.sessions
        .end(session, {
          project,
          opId: `cli-end-${createUlid()}`,
          outcome: "error",
          summary: error instanceof Error ? error.message.slice(0, 500) : "CLI 操作失败",
          next: [],
          releaseClaims: true,
        })
        .catch(() => undefined);
      throw error;
    }
  };

  program
    .name("atm")
    .description("AyanamiTaskManager 命令行")
    .option("--json", "输出单行 JSON")
    .option("--compact", "省略说明字段");

  program
    .command("status")
    .description("显示服务状态")
    .action(async () => show(await (await client()).status()));
  program
    .command("doctor")
    .description("运行完整健康检查")
    .action(async () => show(await (await client()).doctor()));

  const project = program.command("project").description("项目管理");
  project.command("list").action(async () => show(await (await client()).projects.list()));
  project
    .command("create <path>")
    .requiredOption("--name <name>", "项目名称")
    .option("--code <code>", "短代码")
    .option("--mode <mode>", "solo/auto/multi", "auto")
    .action(async (path, options) =>
      show(
        await (
          await client()
        ).projects.create({
          name: options.name,
          sourcePath: resolve(path),
          coordinationMode: String(options.mode).toUpperCase() as "SOLO" | "AUTO" | "MULTI",
          ...(options.code ? { code: options.code } : {}),
        }),
      ),
    );
  project
    .command("open <code>")
    .action(async (code) => show(await (await client()).projects.get(code)));
  project
    .command("archive <code>")
    .action(async (code) => show(await (await client()).projects.archive(code)));
  project
    .command("restore <code>")
    .action(async (code) => show(await (await client()).projects.restore(code)));

  const quick = program.command("quick").description("临时任务");
  quick
    .command("add <title>")
    .option("--note <note>", "备注", "")
    .action(async (title, options) =>
      show(await (await client()).quick.create({ title, note: options.note, actor: "CLI" })),
    );
  quick
    .command("list")
    .option("--status <status>")
    .action(async (options) => show(await (await client()).quick.list(options.status)));
  quick
    .command("promote <key>")
    .requiredOption("--project <code>")
    .requiredOption("--version <number>")
    .action(async (key, options) =>
      show(
        await (
          await client()
        ).quick.promote(key, {
          expectedVersion: Number(options.version),
          targetProjectCode: options.project,
          actor: "CLI",
        }),
      ),
    );

  program
    .command("brief <project>")
    .action(async (projectCode) => show(await (await client()).projects.brief(projectCode)));

  const task = program.command("task").description("工作项");
  task
    .command("list <project>")
    .option("--status <status>")
    .option("--owner <owner>")
    .option("--ready", "只列依赖就绪项")
    .option("--limit <number>", "数量", "20")
    .action(async (projectCode, options) =>
      show(
        await (
          await client()
        ).tasks.list(projectCode, {
          status: options.status?.toUpperCase(),
          assignee: options.owner,
          ready: options.ready ? 1 : undefined,
          limit: options.limit,
        }),
      ),
    );
  task
    .command("show <key>")
    .option("--view <view>", "core/context/full", "context")
    .action(async (key, options) =>
      show(await (await client()).tasks.get(projectFromTaskKey(key), key, options.view)),
    );
  task
    .command("create <project>")
    .requiredOption("--file <path>")
    .action(async (projectCode, options) => {
      const plan = JSON.parse(await readFile(resolve(options.file), "utf8")) as {
        items: unknown[];
      };
      show(
        await inSession(projectCode, "CLI 创建计划", (session) =>
          client().then((api) =>
            api.tasks.create(projectCode, {
              session,
              opId: `cli-plan-${createUlid()}`,
              items: plan.items,
            }),
          ),
        ),
      );
    });
  task
    .command("patch <key>")
    .requiredOption("--version <number>")
    .requiredOption("--operation <operation>")
    .option("--reason <reason>")
    .option("--title <title>")
    .action(async (key, options) => {
      const projectCode = projectFromTaskKey(key);
      show(
        await inSession(projectCode, `CLI 更新 ${key}`, (session) =>
          client().then((api) =>
            api.tasks.patch(projectCode, {
              session,
              opId: `cli-patch-${createUlid()}`,
              items: [
                {
                  taskKey: key,
                  expectedVersion: Number(options.version),
                  operation: options.operation,
                  ...(options.reason ? { blockedReason: options.reason } : {}),
                  ...(options.title ? { title: options.title } : {}),
                },
              ],
            }),
          ),
        ),
      );
    });

  program
    .command("progress <key>")
    .requiredOption("--summary <summary>")
    .option("--percent <number>")
    .option("--blocker <text>")
    .action(async (key, options) => {
      const projectCode = projectFromTaskKey(key);
      show(
        await inSession(projectCode, options.summary, (session) =>
          client().then((api) =>
            api.progress(projectCode, {
              session,
              opId: `cli-progress-${createUlid()}`,
              scope: "task",
              taskKey: key,
              summary: options.summary,
              completed: [],
              next: [],
              evidence: [],
              ...(options.percent === undefined ? {} : { percent: Number(options.percent) }),
              ...(options.blocker === undefined ? {} : { blocker: options.blocker }),
            }),
          ),
        ),
      );
    });

  program
    .command("record <project>")
    .requiredOption("--kind <kind>")
    .requiredOption("--summary <summary>")
    .option("--title <title>")
    .option("--detail <detail>", "", "")
    .action(async (projectCode, options) => {
      const kind = RecordKindSchema.parse(String(options.kind).toUpperCase());
      show(
        await inSession(projectCode, options.summary, (session) =>
          client().then((api) =>
            api.record(projectCode, {
              session,
              opId: `cli-record-${createUlid()}`,
              kind,
              title: options.title ?? options.summary,
              summary: options.summary,
              detail: options.detail,
              importance: "NORMAL",
              scope: "PROJECT",
            }),
          ),
        ),
      );
    });

  program
    .command("events <project>")
    .option("--since <number>", "序列号", "0")
    .action(async (projectCode, options) =>
      show(await (await client()).events(projectCode, Number(options.since))),
    );
  program
    .command("search <query>")
    .option("--project <code>")
    .action(async (query, options) => show(await (await client()).search(query, options.project)));

  const backup = program.command("backup").description("备份与恢复");
  backup
    .command("list")
    .option("--project <code>")
    .action(async (options) => show(await (await client()).backups.list(options.project)));
  backup
    .command("create")
    .requiredOption("--project <code>")
    .action(async (options) => show(await (await client()).backups.create(options.project)));
  backup
    .command("restore <id>")
    .action(async (id) => show(await (await client()).backups.restore(id)));

  program
    .command("export <project>")
    .option("--format <format>", "aytproj/json/csv", "aytproj")
    .action(async (projectCode, options) => {
      const format = String(options.format).toLowerCase();
      if (!(["aytproj", "json", "csv"] as string[]).includes(format)) {
        throw new Error("--format 必须是 aytproj、json 或 csv");
      }
      show(
        await (
          await client()
        ).data.exportProject(projectCode, format as "aytproj" | "json" | "csv"),
      );
    });

  program
    .command("import <path>")
    .requiredOption("--project <code>")
    .option("--preview", "仅预览，不写入")
    .action(async (path, options) => {
      const absolute = resolve(path);
      const content = await readFile(absolute, "utf8");
      const input = { project: options.project, content, sourceName: absolute };
      const api = await client();
      const preview = await api.data.previewAgentTask(input);
      show(
        options.preview
          ? preview
          : await api.data.applyAgentTask({ ...input, expectedSha256: preview.sha256 }),
      );
    });

  return program;
}
