import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";

export type RegistryProjectView = {
  id: string;
  code: string;
  name: string;
  description: string;
  databasePath: string;
  lifecycle: string;
  coordinationMode: string;
  sourcePaths: string[];
  version: number;
};

function projectFromRow(row: any, paths: string[] = []): RegistryProjectView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    databasePath: row.db_path,
    lifecycle: row.lifecycle,
    coordinationMode: row.coordination_mode,
    sourcePaths: paths,
    version: row.version,
  };
}

export class RegistryReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  listProjects(includeArchived = false): RegistryProjectView[] {
    const lifecycleClause = includeArchived ? "" : "WHERE projects.lifecycle <> 'TRASHED'";
    const rows = this.sqlite
      .prepare(
        `SELECT projects.* FROM projects ${lifecycleClause} ORDER BY projects.updated_at DESC`,
      )
      .all() as any[];
    const pathRows = this.sqlite
      .prepare(
        `SELECT paths.project_id, paths.canonical_path
         FROM project_paths paths
         JOIN projects ON projects.id = paths.project_id
         ${lifecycleClause}
         ORDER BY paths.project_id, paths.is_primary DESC, paths.last_seen_at DESC`,
      )
      .all() as Array<{ project_id: string; canonical_path: string }>;
    const pathsByProject = new Map<string, string[]>();
    for (const path of pathRows) {
      const paths = pathsByProject.get(path.project_id) ?? [];
      paths.push(path.canonical_path);
      pathsByProject.set(path.project_id, paths);
    }
    return rows.map((row) => projectFromRow(row, pathsByProject.get(row.id) ?? []));
  }

  getProject(codeOrId: string): RegistryProjectView {
    const row = this.sqlite
      .prepare("SELECT * FROM projects WHERE code = ? OR id = ?")
      .get(codeOrId.toUpperCase(), codeOrId) as any;
    if (!row)
      throw new AtmError("PROJECT_NOT_FOUND", {
        message: `项目不存在：${codeOrId}`,
        details: { entity: "PROJECT", reference: codeOrId },
      });
    const paths = (
      this.sqlite
        .prepare(
          "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC",
        )
        .all(row.id) as Array<{ canonical_path: string }>
    ).map((path) => path.canonical_path);
    return projectFromRow(row, paths);
  }
}
