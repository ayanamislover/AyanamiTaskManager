/**
 * 新旧两个数据根里用户看得到的业务内容，按同一种形状列出来，便于逐步对照（W8b / W8h 的演练证据）：
 *
 *   projects  `<代码> <名称>`
 *   records   `<代码> <类型>#<序号> <标题> [<状态>]`
 *
 * 只读打开（`readOnly`），不写任何一边；2.x 根是 `registry\registry.sqlite` 加每个项目自己的
 * `projects\<id>\project.sqlite`，3.x 根是 `N\data\atm.sqlite`。读不出来（还没转换、库不在）时
 * 返回 `null`，调用方按「这一边还没有数据」对待。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Business = { projects: string[]; records: string[] };

type ProjectRow = { id: string; code: string; name: string };
type RecordRow = { code?: string; kind: string; local_no: number; title: string; status: string };

const label = (code: string, row: RecordRow) =>
  `${code} ${row.kind}#${row.local_no} ${row.title} [${row.status}]`;

function read<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export function legacyBusiness(root: string): Business | null {
  const registry = join(root, "registry", "registry.sqlite");
  if (!existsSync(registry)) return null;
  const projects = read(registry, (db) =>
    db.prepare("SELECT id, code, name FROM projects ORDER BY code").all(),
  ) as ProjectRow[];
  const records: string[] = [];
  for (const project of projects) {
    const path = join(root, "projects", project.id, "project.sqlite");
    if (!existsSync(path)) continue;
    const rows = read(path, (db) =>
      db.prepare("SELECT kind, local_no, title, status FROM records ORDER BY local_no").all(),
    ) as RecordRow[];
    records.push(...rows.map((row) => label(project.code, row)));
  }
  return { projects: projects.map((p) => `${p.code} ${p.name}`), records };
}

export function v3Business(n: string): Business | null {
  const path = join(n, "data", "atm.sqlite");
  if (!existsSync(path)) return null;
  return read(path, (db) => {
    const projects = db
      .prepare("SELECT id, code, name FROM projects ORDER BY code")
      .all() as ProjectRow[];
    const rows = db
      .prepare(
        "SELECT p.code AS code, r.kind, r.local_no, r.title, r.status FROM records r JOIN projects p ON p.id = r.project_id ORDER BY p.code, r.local_no",
      )
      .all() as RecordRow[];
    return {
      projects: projects.map((p) => `${p.code} ${p.name}`),
      records: rows.map((row) => label(row.code!, row)),
    };
  });
}

export const sameBusiness = (left: Business | null, right: Business | null): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
