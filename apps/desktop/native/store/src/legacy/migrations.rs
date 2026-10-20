//! 2.x 的全部迁移（W3b3）：源库的来源证明与在副本上补迁移都用这一份。
//!
//! SQL 在编译时从仓库根的 `migrations/` 嵌入；每个文件的 sha256 另外固定在这里，用例核对两者一致，
//! 所以有人改了迁移文件，构建出来的转换器不会悄悄接受另一种 schema。2.0 的规则（`migration-runner.ts`）：
//! - `schema_migrations.name` 是完整文件名（含 `.sql`），`content_sha256` 是文件内容的 sha256；
//! - 0015 有一个历史 hash（修订前的原文件），已应用过原文件的库仍然有效（`:59-76`）；
//! - `hash_origin` 只能是 `APPLIED` 或 `LEGACY_BASELINE_UNVERIFIED`，hash 照样要对得上。

use super::Home;

#[derive(Clone, Copy, Debug)]
pub struct LegacyMigration {
    pub home: Home,
    pub version: i64,
    /// 完整文件名，与 2.0 写进 `schema_migrations.name` 的一致。
    pub name: &'static str,
    pub sql: &'static str,
    /// 当前文件内容的 sha256。
    pub sha256: &'static str,
    /// 也接受的历史 hash（只有 0015 有）。
    pub historical: &'static [&'static str],
}

const fn m(
    home: Home,
    version: i64,
    name: &'static str,
    sql: &'static str,
    sha256: &'static str,
) -> LegacyMigration {
    LegacyMigration {
        home,
        version,
        name,
        sql,
        sha256,
        historical: &[],
    }
}

macro_rules! file {
    ($kind:literal, $name:literal) => {
        include_str!(concat!("../../../../../../migrations/", $kind, "/", $name))
    };
}

use Home::{Knowledge, Project, Registry};

/// 2.x 全部迁移，按库、版本排序。
pub const MIGRATIONS: &[LegacyMigration] = &[
    m(
        Registry,
        1,
        "0001_initial.sql",
        file!("registry", "0001_initial.sql"),
        "d7cd7454489f763b05d25a76d6590d3a74c66fed5561ace0d8032babb36900a2",
    ),
    m(
        Registry,
        2,
        "0002_attention_fields.sql",
        file!("registry", "0002_attention_fields.sql"),
        "a2fa46b8e593265c61dc2f8d0f3649ac920d12d8f2c69744f2a53b8c7b3a3e94",
    ),
    m(
        Registry,
        3,
        "0003_saved_view_versions.sql",
        file!("registry", "0003_saved_view_versions.sql"),
        "1963336a67431c82cdf4d88ac3a31c2d3ba5b785b4e656b04674cd46e227ffb3",
    ),
    m(
        Registry,
        4,
        "0004_search_keyset.sql",
        file!("registry", "0004_search_keyset.sql"),
        "1d56c509283bde9185444030236ea02cccddb17c222d382c22f0bb7566566891",
    ),
    m(
        Registry,
        5,
        "0005_projection_reliability.sql",
        file!("registry", "0005_projection_reliability.sql"),
        "0914de73645a2f482717c0d75e2b1653ceb0003055032fb6d74c3ea27896cd9c",
    ),
    m(
        Registry,
        6,
        "0006_knowledge_backups.sql",
        file!("registry", "0006_knowledge_backups.sql"),
        "5de95e203b0bf3a6c86514e3cc85d0896e1315ba0aac58c7d8ee31c3a02bf6d1",
    ),
    m(
        Registry,
        7,
        "0007_project_restore_requests.sql",
        file!("registry", "0007_project_restore_requests.sql"),
        "e653d309128a16fc2161c07ecbade12d624fd23b9fb1720a9a0ffd94cef4b44c",
    ),
    m(
        Registry,
        8,
        "0008_global_event_class_indexes.sql",
        file!("registry", "0008_global_event_class_indexes.sql"),
        "b1e08907be1e2197e13109f3ecaa78c6320123d14ba0320289dc8373c08a263f",
    ),
    m(
        Knowledge,
        1,
        "0001_initial.sql",
        file!("knowledge", "0001_initial.sql"),
        "d278a520523fad8c0da993f2cc231b8c94fddac1cad281060e7656ec6e1ed601",
    ),
    m(
        Project,
        1,
        "0001_initial.sql",
        file!("project", "0001_initial.sql"),
        "cdd66cb5964b37d79b72d4ccf4ac1a1bcd66c3fc173e72edc44e0d456c0c7681",
    ),
    m(
        Project,
        2,
        "0002_context_handoff.sql",
        file!("project", "0002_context_handoff.sql"),
        "51c70b2334141c613a53506974e40e9e69ef3242f6999c4785aa0301d6041d4b",
    ),
    m(
        Project,
        3,
        "0003_engineering_metrics.sql",
        file!("project", "0003_engineering_metrics.sql"),
        "9e459e4fa7ba6a682d2cd30379e3c7f50f8264de6a5d09913e8989b135ea48be",
    ),
    m(
        Project,
        4,
        "0004_discovered_from.sql",
        file!("project", "0004_discovered_from.sql"),
        "0214671a5a6ec9a667786f9e38cebcceefbb23c7ec2ede30c40061732bbf3900",
    ),
    m(
        Project,
        5,
        "0005_session_git_context.sql",
        file!("project", "0005_session_git_context.sql"),
        "1ccb64607bbeaa09ebd4516eba72bd3843ef66ed590aa497b25d1da18b5b924c",
    ),
    m(
        Project,
        6,
        "0006_record_topics.sql",
        file!("project", "0006_record_topics.sql"),
        "2cc889de27defe333fee9f522a4eae5f08fd1b6947732615a08d0a415a82ecfe",
    ),
    m(
        Project,
        7,
        "0007_operation_trace.sql",
        file!("project", "0007_operation_trace.sql"),
        "144b43c832a748bb3fea6c07407871edde9749be6eca87e8982fd8a865be0455",
    ),
    m(
        Project,
        8,
        "0008_work_item_phase_waiting.sql",
        file!("project", "0008_work_item_phase_waiting.sql"),
        "a871fb5029bcba3593dc77368380287641f7e69bbfba6b7d1e7baa0dd6a151a5",
    ),
    m(
        Project,
        9,
        "0009_structured_cancel.sql",
        file!("project", "0009_structured_cancel.sql"),
        "63d181dd95e05cd049a794e421d0b4d726bc5b79dbc84795e498c5806b31c094",
    ),
    m(
        Project,
        10,
        "0010_review_workflow.sql",
        file!("project", "0010_review_workflow.sql"),
        "8539fab8ee05b1eb4b3429bd9b0d6bdebaeba9b2b91123bc84ed29baf5e231a0",
    ),
    m(
        Project,
        11,
        "0011_session_close_reason.sql",
        file!("project", "0011_session_close_reason.sql"),
        "4758e9d24cafe8fdb533092b971ebec3d14bf7e04ebe7d8504bed2b896f489ef",
    ),
    m(
        Project,
        12,
        "0012_project_update_evidence.sql",
        file!("project", "0012_project_update_evidence.sql"),
        "04e5239df326c4c830275ba922cc69869cd250186b038c42f8bb6316cee878a8",
    ),
    m(
        Project,
        13,
        "0013_project_update_session.sql",
        file!("project", "0013_project_update_session.sql"),
        "8bdc91e49d51e570192f6775dec38f27859fb712311b38762b2cfb26a227793d",
    ),
    m(
        Project,
        14,
        "0014_search_keyset.sql",
        file!("project", "0014_search_keyset.sql"),
        "200f7263ecfb75e56e0809540e43ce5fe6251cfe9eb88add5f9eeb5bbebd2e32",
    ),
    LegacyMigration {
        historical: &["046381e8fdfef46a32e0babe85aa49ac0ac2168eb324aaf34d3ce714ad331205"],
        ..m(
            Project,
            15,
            "0015_reconciliation_projection.sql",
            file!("project", "0015_reconciliation_projection.sql"),
            "4739d2ab1f36994ba82888094a894c080f3d8c9a018d38a48eff1c81e19adf47",
        )
    },
    m(
        Project,
        16,
        "0016_task_list_keyset.sql",
        file!("project", "0016_task_list_keyset.sql"),
        "891ca76fa01245a265bb800a663e08a93269b362d8f7fd56ea94e74937076b15",
    ),
    m(
        Project,
        17,
        "0017_record_list_keyset.sql",
        file!("project", "0017_record_list_keyset.sql"),
        "8f468feb2b34a2f465e5c7af7262a46cf8c78556afbfdca8e96f8ea6f8d1362b",
    ),
    m(
        Project,
        18,
        "0018_session_list_keyset.sql",
        file!("project", "0018_session_list_keyset.sql"),
        "89cdb54d7b63c31adac82db8f0cdc6bf01be73a5bacae65d59c221a625f807dd",
    ),
];

/// 某个库的迁移计划（按版本）。
pub fn plan(home: Home) -> Vec<&'static LegacyMigration> {
    MIGRATIONS.iter().filter(|m| m.home == home).collect()
}

/// 已应用的一行 `schema_migrations` 是否认得：名字一致，hash 等于当前或历史 hash（2.0 `migrationHashMatches`）。
pub fn recognizes(m: &LegacyMigration, name: &str, sha256: &str) -> bool {
    m.name == name && (m.sha256 == sha256 || m.historical.contains(&sha256))
}
