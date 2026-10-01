import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 数据库迁移相对已发布的 Electron 1.2.2 冻结（de-electron §7）。
 *
 * 「回到 Electron」（atm-setup --rollback 的反向迁移）让 1.2.2 重新打开同一个数据根。1.2.2 启动时
 * 核对 schema_migrations ⊆ 它随包的集合；新版本多加一条迁移、或改了已有迁移的内容，1.2.2 就打
 * 不开这个库——反向迁移看起来成功，旧版却起不来，用户手里只剩一个坏掉的回退。
 *
 * 下面这份清单取自用户机器上实际安装的 1.2.2（app-1.2.2\resources\app.asar 里的 migrations，
 * 2026-10-01 只读核对，与仓库逐字节一致）。要加迁移，就得先有意地结束「可回到 Electron」：
 * 删掉反向迁移入口和 state\rollback 资产，再改这里——不是顺手更新哈希。
 */
const ELECTRON_1_2_2_MIGRATIONS: Array<[string, string]> = [
  [
    "knowledge/0001_initial.sql",
    "d278a520523fad8c0da993f2cc231b8c94fddac1cad281060e7656ec6e1ed601",
  ],
  ["project/0001_initial.sql", "cdd66cb5964b37d79b72d4ccf4ac1a1bcd66c3fc173e72edc44e0d456c0c7681"],
  [
    "project/0002_context_handoff.sql",
    "51c70b2334141c613a53506974e40e9e69ef3242f6999c4785aa0301d6041d4b",
  ],
  [
    "project/0003_engineering_metrics.sql",
    "9e459e4fa7ba6a682d2cd30379e3c7f50f8264de6a5d09913e8989b135ea48be",
  ],
  [
    "project/0004_discovered_from.sql",
    "0214671a5a6ec9a667786f9e38cebcceefbb23c7ec2ede30c40061732bbf3900",
  ],
  [
    "project/0005_session_git_context.sql",
    "1ccb64607bbeaa09ebd4516eba72bd3843ef66ed590aa497b25d1da18b5b924c",
  ],
  [
    "project/0006_record_topics.sql",
    "2cc889de27defe333fee9f522a4eae5f08fd1b6947732615a08d0a415a82ecfe",
  ],
  [
    "project/0007_operation_trace.sql",
    "144b43c832a748bb3fea6c07407871edde9749be6eca87e8982fd8a865be0455",
  ],
  [
    "project/0008_work_item_phase_waiting.sql",
    "a871fb5029bcba3593dc77368380287641f7e69bbfba6b7d1e7baa0dd6a151a5",
  ],
  [
    "project/0009_structured_cancel.sql",
    "63d181dd95e05cd049a794e421d0b4d726bc5b79dbc84795e498c5806b31c094",
  ],
  [
    "project/0010_review_workflow.sql",
    "8539fab8ee05b1eb4b3429bd9b0d6bdebaeba9b2b91123bc84ed29baf5e231a0",
  ],
  [
    "project/0011_session_close_reason.sql",
    "4758e9d24cafe8fdb533092b971ebec3d14bf7e04ebe7d8504bed2b896f489ef",
  ],
  [
    "project/0012_project_update_evidence.sql",
    "04e5239df326c4c830275ba922cc69869cd250186b038c42f8bb6316cee878a8",
  ],
  [
    "project/0013_project_update_session.sql",
    "8bdc91e49d51e570192f6775dec38f27859fb712311b38762b2cfb26a227793d",
  ],
  [
    "project/0014_search_keyset.sql",
    "200f7263ecfb75e56e0809540e43ce5fe6251cfe9eb88add5f9eeb5bbebd2e32",
  ],
  [
    "project/0015_reconciliation_projection.sql",
    "4739d2ab1f36994ba82888094a894c080f3d8c9a018d38a48eff1c81e19adf47",
  ],
  [
    "project/0016_task_list_keyset.sql",
    "891ca76fa01245a265bb800a663e08a93269b362d8f7fd56ea94e74937076b15",
  ],
  [
    "project/0017_record_list_keyset.sql",
    "8f468feb2b34a2f465e5c7af7262a46cf8c78556afbfdca8e96f8ea6f8d1362b",
  ],
  [
    "project/0018_session_list_keyset.sql",
    "89cdb54d7b63c31adac82db8f0cdc6bf01be73a5bacae65d59c221a625f807dd",
  ],
  ["registry/0001_initial.sql", "d7cd7454489f763b05d25a76d6590d3a74c66fed5561ace0d8032babb36900a2"],
  [
    "registry/0002_attention_fields.sql",
    "a2fa46b8e593265c61dc2f8d0f3649ac920d12d8f2c69744f2a53b8c7b3a3e94",
  ],
  [
    "registry/0003_saved_view_versions.sql",
    "1963336a67431c82cdf4d88ac3a31c2d3ba5b785b4e656b04674cd46e227ffb3",
  ],
  [
    "registry/0004_search_keyset.sql",
    "1d56c509283bde9185444030236ea02cccddb17c222d382c22f0bb7566566891",
  ],
  [
    "registry/0005_projection_reliability.sql",
    "0914de73645a2f482717c0d75e2b1653ceb0003055032fb6d74c3ea27896cd9c",
  ],
  [
    "registry/0006_knowledge_backups.sql",
    "5de95e203b0bf3a6c86514e3cc85d0896e1315ba0aac58c7d8ee31c3a02bf6d1",
  ],
  [
    "registry/0007_project_restore_requests.sql",
    "e653d309128a16fc2161c07ecbade12d624fd23b9fb1720a9a0ffd94cef4b44c",
  ],
  [
    "registry/0008_global_event_class_indexes.sql",
    "b1e08907be1e2197e13109f3ecaa78c6320123d14ba0320289dc8373c08a263f",
  ],
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** 当前仓库里的迁移集合：相对路径 → sha256，与打包清单的 schemaSet 同一来源。 */
function migrationSet(root: string): Map<string, string> {
  return new Map(
    walk(root)
      .map((path): [string, string] => [
        relative(root, path).split(sep).join("/"),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe("数据库迁移相对 Electron 1.2.2 冻结", () => {
  it("迁移目录与已发布的 1.2.2 逐文件、逐字节一致", () => {
    expect([...migrationSet("migrations")]).toEqual(
      [...new Map(ELECTRON_1_2_2_MIGRATIONS)].sort(([left], [right]) => left.localeCompare(right)),
    );
  });
});
