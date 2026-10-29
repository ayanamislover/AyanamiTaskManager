mod support;

use serde_json::json;
use support::{agent, world};

#[test]
fn only_the_user_can_permanently_delete_a_confirmed_trashed_project() {
    let w = world("purge-ui-route");
    let old = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({"name":"Old","code":"OLD","sourcePath":null})),
        201,
    );
    w.ok(
        "POST",
        "/api/v1/projects/OLD/ui/records",
        Some(json!({
            "opId":"purge-record",
            "kind":"DECISION",
            "importance":"HIGH",
            "title":"Historical decision",
            "summary":"restored only by the User",
            "detail":"protected project detail",
            "scope":"PROJECT"
        })),
        201,
    );
    w.ok("POST", "/api/v1/projects/OLD/trash", None, 200);
    let backups_before = w.get("/api/v1/backups");
    let trash = w.get("/api/v1/trash/projects");
    let version = trash[0]["version"].as_i64().unwrap();
    let route = "/api/v1/projects/OLD/purge";

    let agent_reply = w.call_as(
        &agent(),
        "POST",
        route,
        Some(json!({
            "confirmCode":"OLD", "expectedVersion":version
        })),
    );
    assert_eq!(agent_reply.status, 403);
    assert_eq!(
        w.call(
            "POST",
            route,
            Some(json!({"confirmCode":"NO","expectedVersion":version}))
        )
        .status,
        422
    );
    assert_eq!(
        w.call(
            "POST",
            route,
            Some(json!({"confirmCode":"OLD","expectedVersion":version-1}))
        )
        .status,
        409
    );
    assert_eq!(w.get("/api/v1/trash/projects").as_array().unwrap().len(), 1);

    let removed = w.ok(
        "POST",
        route,
        Some(json!({"confirmCode":"OLD","expectedVersion":version})),
        200,
    );
    assert_eq!(removed["deleted"], true);
    assert_eq!(removed["id"], old["id"]);
    assert_eq!(w.get("/api/v1/trash/projects").as_array().unwrap().len(), 0);
    assert_eq!(
        w.get("/api/v1/backups"),
        backups_before,
        "whole-database backup catalog is preserved"
    );
    let fresh = w.ok(
        "POST",
        "/api/v1/projects",
        Some(json!({"name":"Fresh","code":"OLD","sourcePath":null})),
        201,
    );
    assert_ne!(fresh["id"], old["id"]);
    let backup_id = backups_before[0]["id"].as_str().unwrap();
    let agent_catalog = w.call_as(
        &agent(),
        "GET",
        &format!("/api/v1/backups/{backup_id}/deleted-projects"),
        None,
    );
    assert!(matches!(agent_catalog.status, 403 | 404));
    let catalog = w.get(&format!("/api/v1/backups/{backup_id}/deleted-projects"));
    assert_eq!(catalog["projects"][0]["id"], old["id"]);
    assert_eq!(catalog["projects"][0]["codeTaken"], true);
    let suggested = catalog["projects"][0]["suggestedCode"].as_str().unwrap();
    assert_eq!(
        w.call_as(
            &agent(),
            "POST",
            &format!("/api/v1/backups/{backup_id}/import-project"),
            Some(json!({"projectId":old["id"], "code":suggested})),
        )
        .status,
        403
    );
    let imported = w.ok(
        "POST",
        &format!("/api/v1/backups/{backup_id}/import-project"),
        Some(json!({"projectId":old["id"], "code": suggested})),
        200,
    );
    assert_ne!(imported["projectId"], old["id"]);
    assert_ne!(imported["projectId"], fresh["id"]);
    assert_eq!(imported["code"], suggested);
    let recovered_records = w.get(&format!("/api/v1/projects/{suggested}/records?limit=100"));
    assert!(
        recovered_records
            .to_string()
            .contains("Historical decision")
    );
    assert!(
        recovered_records
            .to_string()
            .contains("protected project detail")
    );
}
