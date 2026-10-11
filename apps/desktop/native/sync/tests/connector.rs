//! 连接器：快照发布、中继异常、停机预算、密钥与权限、配对（2.x `connector-publish`、`connector-safety`、
//! `connector-relay-errors`、`connector-stop-budget` 的连接器部分；03 §5 的 T-DENY 与 NS-3 / NS-6）。

mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atm_sync::connector::{Phase, Timings};
use atm_sync::transport::{Cancel, HttpRequest, HttpResponse, NetFailure, Transport};
use serde_json::{Value, json};
use support::MemoryRelay;
use support::world::{Opts, RELAY_URL, agent, connect, fast, phone_for, user, wait_for, world};

fn head_projects(phone: &support::world::Phone) -> Vec<Value> {
    phone
        .store
        .read_head()
        .unwrap()
        .map(|h| h["projects"].as_array().cloned().unwrap_or_default())
        .unwrap_or_default()
}

#[test]
fn the_first_sync_publishes_active_projects_and_an_unchanged_world_writes_nothing() {
    let w = world("pub-first", &[("PA", "ALPHA", true), ("PB", "BETA", true)]);
    let key = w.seed_task("ALPHA", "第一个任务");
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    wait_for(|| head_projects(&phone).len() == 2, "head 列出两个项目");
    let heads = head_projects(&phone);
    let codes: Vec<&str> = heads.iter().map(|h| h["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["ALPHA", "BETA"]);
    let alpha = &heads[0];
    assert_eq!(alpha["counts"]["active"], 1);
    assert_eq!(alpha["counts"]["ready"], 1);
    let doc = phone
        .store
        .read_project(alpha["h"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(doc["tasks"][0]["key"], json!(key));
    assert_eq!(doc["tasks"][0]["title"], "第一个任务");
    // 中继里只有密文：项目名、任务标题都看不到。
    let raw: String = w
        .relay
        .state()
        .docs
        .values()
        .map(|d| d.data.to_string())
        .collect();
    assert!(!raw.contains("第一个任务") && !raw.contains("ALPHA"));
    // 摘要不变不写：立即同步一次，中继上没有新的 PUT。
    std::thread::sleep(Duration::from_millis(100));
    let mark = w.relay.request_count();
    c.mark_dirty(Some("ALPHA"));
    c.sync_now();
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        w.relay.puts_since(mark).iter().all(|k| k.contains("/dev/")),
        "{:?}",
        w.relay.puts_since(mark)
    );
    c.stop();
}

#[test]
fn a_task_change_rewrites_only_that_project_and_the_head() {
    let w = world("pub-change", &[("PA", "ALPHA", true), ("PB", "BETA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    wait_for(|| head_projects(&phone).len() == 2, "首次发布");
    std::thread::sleep(Duration::from_millis(100));
    let alpha_hash = head_projects(&phone)[0]["h"].as_str().unwrap().to_owned();
    let beta_hash = head_projects(&phone)[1]["h"].as_str().unwrap().to_owned();
    let mark = w.relay.request_count();
    let key = w.seed_task("ALPHA", "后来加的");
    // 观察线程看到事件后去抖发布。
    wait_for(
        || {
            phone
                .store
                .read_project(&alpha_hash)
                .unwrap()
                .is_some_and(|d| {
                    d["tasks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|t| t["key"] == json!(key))
                })
        },
        "ALPHA 重写",
    );
    wait_for(
        || head_projects(&phone)[0]["counts"]["active"] == 1,
        "head 更新",
    );
    let puts = w.relay.puts_since(mark);
    assert!(
        puts.iter()
            .any(|k| k.ends_with(&format!("/p/{alpha_hash}")))
    );
    assert!(!puts.iter().any(|k| k.contains(&beta_hash)), "{puts:?}");
    c.stop();
}

#[test]
fn an_archived_project_leaves_the_head_and_its_document_is_deleted() {
    let w = world(
        "pub-archive",
        &[("PA", "ALPHA", true), ("PB", "BETA", true)],
    );
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    wait_for(|| head_projects(&phone).len() == 2, "首次发布");
    let beta_hash = head_projects(&phone)[1]["h"].as_str().unwrap().to_owned();
    w.service
        .store()
        .write(|tx| {
            tx.execute(
                "UPDATE projects SET lifecycle = 'ARCHIVED' WHERE id = 'PB'",
                [],
            )
        })
        .unwrap();
    c.mark_dirty(None);
    c.sync_now();
    wait_for(|| head_projects(&phone).len() == 1, "head 去掉 BETA");
    assert!(phone.store.read_project(&beta_hash).unwrap().is_none());
    assert!(!c.config().published.contains_key("BETA"));
    c.stop();
}

#[test]
fn the_ledger_keeps_the_device_and_publish_cache_but_no_secrets() {
    let w = world("pub-ledger", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    wait_for(|| c.config().published.contains_key("ALPHA"), "发布缓存");
    c.stop();
    let ledger = w.service.sync_ledger(&user()).unwrap().unwrap();
    assert!(ledger.device_id.starts_with("pc-"));
    assert!(ledger.published.contains_key("ALPHA"));
    assert!(ledger.space_id.is_some());
    let p = atm_sync_protocol::pairing::decode_pairing_code(&pairing).unwrap();
    let dump = format!("{ledger:?}");
    assert!(!dump.contains(&p.relay_token) && !dump.contains(&p.space_secret));
    // 密钥文件里也不是明文。
    let file = std::fs::read_to_string(w.dir.join("sync").join("secrets.dpapi.json")).unwrap();
    assert!(!file.contains(&p.relay_token) && !file.contains(&p.space_secret));
    // 重启后用同一个设备 ID 与空间。
    let again = w.connector();
    assert_eq!(again.config().device_id, ledger.device_id);
    assert_eq!(again.config().space_id, ledger.space_id);
}

#[test]
fn status_carries_no_secret_and_matches_the_desktop_contract() {
    let w = world("safe-status", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let status = c.status(&user()).unwrap();
    let p = atm_sync_protocol::pairing::decode_pairing_code(&pairing).unwrap();
    let text = status.to_string();
    for secret in [
        p.relay_token.as_str(),
        p.space_secret.as_str(),
        pairing.as_str(),
    ] {
        assert!(!text.contains(secret));
    }
    let mut keys: Vec<&str> = status
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "appId",
            "configured",
            "deviceName",
            "enabled",
            "lastError",
            "lastSyncAt",
            "longPoll",
            "paired",
            "pendingCommands",
            "relayUrl",
            "secretStore",
            "state"
        ]
    );
    assert_eq!(status["secretStore"], "os-encrypted");
    assert_eq!(status["state"], "online");
    c.stop();
}

#[test]
fn disabled_by_default_starts_without_any_request() {
    let w = world("safe-default", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    c.start().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(w.relay.request_count(), 0);
    assert_eq!(c.status(&user()).unwrap()["state"], "disabled");
    let ledger = w.service.sync_ledger(&user()).unwrap().unwrap();
    assert!(!ledger.enabled && ledger.device_id.starts_with("pc-"));
    // 启用但没填中继：状态 error 并说明缺什么。
    c.update_config(&user(), &json!({ "enabled": true }))
        .unwrap();
    let status = c.status(&user()).unwrap();
    assert_eq!(status["state"], "error");
    assert_eq!(
        status["lastError"],
        "已启用手机同步，但还没有填写中继地址或 token"
    );
    assert_eq!(w.relay.request_count(), 0);
    c.stop();
}

/// 03 §5：Agent 主体调设置页的每个入口都被拒，响应里没有配对码或密钥；拒绝没有副作用：
/// 库里每张表（NS-1/2）、数据根下的文件（NS-3）、网络（NS-6：后台循环自己的 `GET /changes` 之外零请求，
/// Agent 给的地址与 token 不出现在任何请求里）、宿主状态（NS-8：阶段、状态、内存里的账本）、
/// 内存队列（NS-9：待处理命令、待发布的脏集合）都不变。子进程（NS-5）与 Agent 配置（NS-7）在 atm-sync 里没有通道，
/// 由 `src/lib.rs` 的静态守卫看着。
#[test]
fn agents_are_refused_every_settings_entry_without_side_effects() {
    let w = world("safe-deny", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    std::thread::sleep(Duration::from_millis(100));
    c.sync_now();
    std::thread::sleep(Duration::from_millis(50));
    let tree = |dir: &std::path::Path| -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for e in walk(dir) {
            if e.extension()
                .is_some_and(|x| x == "sqlite" || x == "sqlite-wal" || x == "sqlite-shm")
            {
                continue;
            }
            out.push((
                e.display().to_string(),
                std::fs::read(&e).unwrap_or_default(),
            ));
        }
        out.sort();
        out
    };
    let tables = || -> Vec<String> {
        w.service
            .store()
            .read(|db| {
                let names: Vec<String> = db
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                let mut rows = Vec::new();
                for name in names {
                    let mut st = db.prepare(&format!("SELECT * FROM \"{name}\""))?;
                    let n = st.column_count();
                    let mut q = st.query([])?;
                    while let Some(r) = q.next()? {
                        let cells: Vec<rusqlite::types::Value> =
                            (0..n).map(|i| r.get(i)).collect::<Result<_, _>>()?;
                        rows.push(format!("{name}: {cells:?}"));
                    }
                }
                Ok::<_, rusqlite::Error>(rows)
            })
            .unwrap()
    };
    let memory = || {
        let mut config = c.config();
        config.last_sync_at = None; // 后台每轮轮询都会刷新它，与拒绝无关
        let mut status = c.status(&user()).unwrap();
        status["lastSyncAt"] = Value::Null;
        (c.phase(), status, config, c.scheduler_dirty())
    };
    let outbound = || -> Vec<String> {
        w.relay
            .state()
            .requests
            .iter()
            .filter(|r| !(r.method == "GET" && r.url.contains("/changes")))
            .map(|r| format!("{} {}", r.method, r.url))
            .collect()
    };
    let before = (tree(&w.dir), tables(), memory(), outbound());
    let elsewhere = "https://agent-chosen.example.net";
    // 第二项是入口自己要的能力：拒绝必须发生在入口的第一步（P-004），而不是更深处的账本读写替它兜住。
    let checks: Vec<(&str, &str, Result<Value, atm_domain::error::DomainError>)> = vec![
        ("status", "sync.status", c.status(&agent())),
        (
            "configure",
            "sync.configure",
            c.update_config(
                &agent(),
                &json!({ "enabled": false, "relayUrl": elsewhere, "token": "agent-token-123" }),
            ),
        ),
        (
            "test",
            "sync.test_relay",
            c.test_relay(
                &agent(),
                &json!({ "relayUrl": elsewhere, "token": "agent-token-123" }),
            ),
        ),
        ("pairing", "sync.pairing_create", c.create_pairing(&agent())),
        ("reset", "sync.reset", c.reset_space(&agent())),
    ];
    for (name, capability, r) in checks {
        let e = r.unwrap_err();
        assert_eq!(e.code.as_str(), "USER_AUTHORIZATION_REQUIRED", "{name}");
        assert_eq!(e.details["capability"], capability, "{name}");
        assert!(!e.message.contains(&pairing), "{name}");
        assert!(!format!("{e:?}").contains("agent-token-123"), "{name}");
    }
    std::thread::sleep(Duration::from_millis(50));
    let after = (tree(&w.dir), tables(), memory(), outbound());
    assert_eq!(before.0, after.0, "NS-3：数据根下的文件不变");
    assert_eq!(before.1, after.1, "NS-1/2：库里每张表不变");
    assert_eq!(before.2, after.2, "NS-8/9：阶段、状态、账本、脏集合不变");
    assert_eq!(before.3, after.3, "NS-6：没有新的出站请求");
    let all: String = w
        .relay
        .state()
        .requests
        .iter()
        .map(|r| format!("{} {:?}\n", r.url, r.body))
        .collect();
    assert!(!all.contains("agent-chosen") && !all.contains("agent-token-123"));
    // 阳性对照：同样的调用以用户身份是可以的，而且会留下痕迹。
    assert!(c.status(&user()).is_ok());
    c.update_config(&user(), &json!({ "deviceName": "改过的名字" }))
        .unwrap();
    assert_ne!(tables(), after.1);
    c.stop();
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[test]
fn a_rejected_token_stops_until_a_new_one_is_saved() {
    let w = world("relay-401", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    c.update_config(
        &user(),
        &json!({ "enabled": true, "relayUrl": RELAY_URL, "token": "wrong-token-1234" }),
    )
    .unwrap();
    c.start().unwrap();
    wait_for(|| c.phase() == Phase::Rejected, "停在 rejected");
    let status = c.status(&user()).unwrap();
    assert_eq!(status["state"], "error");
    assert!(
        status["lastError"]
            .as_str()
            .unwrap()
            .contains("中继拒绝了 token")
    );
    assert!(!status.to_string().contains("wrong-token-1234"));
    let count = w.relay.request_count();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(w.relay.request_count(), count, "停下后不再请求");
    c.update_config(&user(), &json!({ "token": support::TOKEN }))
        .unwrap();
    wait_for(
        || c.status(&user()).unwrap()["state"] == "online",
        "换上正确 token 恢复",
    );
    c.stop();
}

#[test]
fn going_offline_backs_off_with_a_chinese_reason_then_recovers() {
    let w = world("relay-offline", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    connect(&c, &w.relay);
    w.relay.state().offline = true;
    wait_for(|| c.phase() == Phase::Retrying, "退避中");
    let status = c.status(&user()).unwrap();
    assert_eq!(status["state"], "error");
    assert!(
        status["lastError"]
            .as_str()
            .unwrap()
            .starts_with("连不上中继"),
        "{status}"
    );
    w.relay.state().offline = false;
    wait_for(
        || c.status(&user()).unwrap()["state"] == "online",
        "恢复在线",
    );
    c.stop();
}

#[test]
fn an_expired_cursor_rereads_commands_and_rewrites_every_snapshot() {
    // BETA 停机前后都没变：只有「游标过期就强制全量」才会重写它。
    let w = world("relay-410", &[("PA", "ALPHA", true), ("PB", "BETA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    wait_for(|| head_projects(&phone).len() == 2, "首次发布");
    // 游标落盘之后再停：否则重启时没有旧游标，走的是「第一次拿游标」而不是「游标过期」。
    wait_for(
        || {
            w.service
                .sync_ledger(&user())
                .unwrap()
                .is_some_and(|l| l.cursor.is_some())
        },
        "游标落盘",
    );
    c.stop();
    // 停机期间发命令，中继裁掉变更（保存的游标过期）。
    let id = phone.send(json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "游标过期期间发的" } }));
    for i in 0..3 {
        w.relay
            .put_raw(&format!("atm1/ffffffffffffffffffffffff/x{i}"), json!({}));
    }
    w.relay.prune(1);
    let mark = w.relay.request_count();
    let again = w.connector();
    again.start().unwrap();
    assert_eq!(phone.await_ack(&id)["ok"], true);
    let beta_hash = c.config().published["BETA"].h.clone();
    wait_for(
        || {
            w.relay
                .puts_since(mark)
                .iter()
                .any(|k| k.ends_with(&beta_hash))
        },
        "没变过的项目也强制重写",
    );
    again.stop();
}

#[test]
fn a_cursor_the_relay_does_not_accept_is_dropped_once_and_snapshots_are_forced() {
    let w = world("relay-400", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    connect(&c, &w.relay);
    wait_for(|| c.config().published.contains_key("ALPHA"), "首次发布");
    c.stop();
    // 换成别家中继的游标格式（atm-relay 回 400）。
    let mut ledger = w.service.sync_ledger(&user()).unwrap().unwrap();
    ledger.cursor = Some("cloud:opaque".into());
    w.service.save_sync_ledger(&user(), &ledger).unwrap();
    let mark = w.relay.request_count();
    let again = w.connector();
    again.start().unwrap();
    let alpha_hash = ledger.published["ALPHA"].h.clone();
    wait_for(
        || {
            w.relay
                .puts_since(mark)
                .iter()
                .any(|k| k.ends_with(&alpha_hash))
        },
        "强制重写快照",
    );
    wait_for(
        || {
            again
                .config()
                .cursor
                .as_deref()
                .is_some_and(|c| c.bytes().all(|b| b.is_ascii_digit()))
        },
        "新游标",
    );
    assert_eq!(again.phase(), Phase::Online);
    let stale = w.relay.state().requests[mark..]
        .iter()
        .filter(|r| r.url.contains("cursor=cloud"))
        .count();
    assert_eq!(stale, 1, "旧游标只试一次");
    let began = Instant::now();
    again.stop();
    assert!(
        began.elapsed() < Duration::from_secs(1),
        "{:?}",
        began.elapsed()
    );
}

#[test]
fn a_rate_limit_waits_at_least_as_long_as_the_relay_asks() {
    let w = world("relay-429", &[("PA", "ALPHA", true)]);
    let asked: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let sleep: atm_sync::transport::Sleeper = {
        let asked = asked.clone();
        Arc::new(move |d| {
            asked.lock().unwrap().push(d);
            std::thread::sleep(d.min(Duration::from_millis(5)));
            true
        })
    };
    let c = w.connector_with(Opts {
        sleep: Some(sleep),
        ..Default::default()
    });
    connect(&c, &w.relay);
    {
        let mut s = w.relay.state();
        s.retry_after = Some(7);
        s.faults
            .push(("GET", "/changes".into(), 429, "RATE_LIMITED".into()));
    }
    wait_for(
        || {
            asked
                .lock()
                .unwrap()
                .iter()
                .any(|d| *d >= Duration::from_secs(7))
        },
        "按 Retry-After 等待",
    );
    // 只有这一次限流：等完之后回到在线，下一次失败的退避从头算（不是 7 s）。
    wait_for(
        || c.status(&user()).unwrap()["state"] == "online",
        "恢复在线",
    );
    let waits = asked.lock().unwrap().clone();
    assert!(waits.iter().all(|d| *d <= Duration::from_secs(60)));
    assert_eq!(
        waits
            .iter()
            .filter(|d| **d >= Duration::from_secs(7))
            .count(),
        1,
        "{waits:?}"
    );
    c.stop();
}

/// 中继要的等待超过一分钟也照等：一分钟的上限只管退避自己（W7 r1 P2-01；2.x 把两者合起来截到 60 s）。
/// 中继给的值在解析时限到 600 s（`relay` 的用例）。
#[test]
fn a_rate_limit_above_a_minute_is_waited_out_in_full() {
    for seconds in [60u64, 61, 120, 600] {
        let w = world(&format!("relay-429-{seconds}"), &[("PA", "ALPHA", true)]);
        let asked: Arc<Mutex<Vec<Duration>>> = Arc::default();
        let sleep: atm_sync::transport::Sleeper = {
            let asked = asked.clone();
            Arc::new(move |d| {
                asked.lock().unwrap().push(d);
                std::thread::sleep(d.min(Duration::from_millis(5)));
                true
            })
        };
        let c = w.connector_with(Opts {
            sleep: Some(sleep),
            ..Default::default()
        });
        connect(&c, &w.relay);
        {
            let mut s = w.relay.state();
            s.retry_after = Some(seconds);
            s.faults
                .push(("GET", "/changes".into(), 429, "RATE_LIMITED".into()));
        }
        let want = Duration::from_secs(seconds);
        wait_for(
            || {
                asked
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|d| *d >= Duration::from_secs(1))
            },
            "限流之后等待",
        );
        c.stop();
        let waits = asked.lock().unwrap().clone();
        assert!(waits.contains(&want), "Retry-After {seconds}: {waits:?}");
        assert!(
            waits.iter().all(|d| *d <= want),
            "Retry-After {seconds}: {waits:?}"
        );
    }
}

/// 中继要等十分钟：停下时不等它，马上返回（夹具的 `stop_timeout` 是 1 s：等待打断不了，停止要等满它才返回）。
#[test]
fn a_stop_during_a_long_rate_limit_wait_returns_at_once() {
    let w = world("relay-429-stop", &[("PA", "ALPHA", true)]);
    let c = w.connector_with(Opts {
        real_sleep: true,
        ..Default::default()
    });
    connect(&c, &w.relay);
    {
        let mut s = w.relay.state();
        s.retry_after = Some(600);
        s.faults
            .push(("GET", "/changes".into(), 429, "RATE_LIMITED".into()));
    }
    wait_for(
        || c.status(&user()).unwrap()["state"] == "error",
        "限流之后在等",
    );
    let began = Instant::now();
    c.stop();
    assert!(
        began.elapsed() < Duration::from_millis(500),
        "{:?}",
        began.elapsed()
    );
}

/// 一直不回的中继：只在令牌取消时失败。`hang` 为假时转给内存中继。
type HangIf = Box<dyn Fn(&HttpRequest) -> bool + Send + Sync>;

struct Hanging {
    inner: MemoryRelay,
    hang: Mutex<HangIf>,
    /// 卡住的请求里，被令牌掐断（Cancelled）返回的个数。
    cut: std::sync::atomic::AtomicUsize,
}

impl Hanging {
    fn new(inner: MemoryRelay, hang: HangIf) -> Hanging {
        Hanging {
            inner,
            hang: Mutex::new(hang),
            cut: Default::default(),
        }
    }
}

impl Transport for Hanging {
    fn send(&self, r: &HttpRequest, cancel: &[&Cancel]) -> Result<HttpResponse, NetFailure> {
        if (self.hang.lock().unwrap())(r) {
            let out = atm_sync::transport::run_cancellable(cancel, None, || {
                std::thread::sleep(Duration::from_secs(30));
                Err(NetFailure::Timeout)
            });
            if matches!(out, Err(NetFailure::Cancelled)) {
                self.cut.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            return out;
        }
        self.inner.send(r, cancel)
    }
}

fn budget() -> Timings {
    Timings {
        stop_timeout: Duration::from_millis(300),
        ..fast()
    }
}

#[test]
fn stopping_while_the_relay_is_still_being_probed_cuts_the_probe() {
    let w = world("stop-probe", &[("PA", "ALPHA", true)]);
    let hanging = Arc::new(Hanging::new(w.relay.clone(), Box::new(|_| true)));
    let c = w.connector_with(Opts {
        transport: Some(hanging),
        timings: budget(),
        ..Default::default()
    });
    c.update_config(
        &user(),
        &json!({ "enabled": true, "relayUrl": RELAY_URL, "token": support::TOKEN }),
    )
    .unwrap();
    c.start().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let began = Instant::now();
    c.stop();
    assert!(
        began.elapsed() < Duration::from_millis(300),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(c.phase(), Phase::Stopped);
}

#[test]
fn a_stuck_relay_write_is_cut_within_the_budget_and_no_offline_presence_is_attempted() {
    let w = world("stop-stuck", &[("PA", "ALPHA", true)]);
    let hanging = Arc::new(Hanging::new(w.relay.clone(), Box::new(|_| false)));
    let c = w.connector_with(Opts {
        transport: Some(hanging.clone()),
        timings: budget(),
        ..Default::default()
    });
    connect(&c, &w.relay);
    wait_for(|| c.config().published.contains_key("ALPHA"), "首次发布");
    std::thread::sleep(Duration::from_millis(50));
    // 发布卡住：下一次写项目文档的请求一直不回。
    *hanging.hang.lock().unwrap() = Box::new(|r| r.method == "PUT");
    let _key = w.seed_task("ALPHA", "触发发布");
    std::thread::sleep(Duration::from_millis(100));
    let mark = w.relay.request_count();
    let began = Instant::now();
    c.stop();
    let took = began.elapsed();
    assert!(took < Duration::from_millis(1500), "{took:?}");
    // 卡住的那个请求被掐断了（会话作废），而不是留在后台再挂 30 秒。
    wait_for(
        || hanging.cut.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "卡住的请求被掐断",
    );
    let after = w.relay.state().requests[mark..]
        .iter()
        .filter(|r| r.method == "PUT" && r.key.as_deref().is_some_and(|k| k.contains("/dev/")))
        .count();
    assert_eq!(after, 0, "不再写离线状态");
}

#[test]
fn a_normal_stop_writes_offline_presence() {
    let w = world("stop-offline", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    c.stop();
    let device = c.config().device_id;
    let doc = phone.store.read_device(&device).unwrap().unwrap();
    assert_eq!(doc["state"], "offline");
    assert_eq!(doc["role"], "host");
}

#[test]
fn concurrent_pairing_requests_create_one_space_and_return_the_same_code() {
    let w = world("pair-once", &[("PA", "ALPHA", true)]);
    let c = Arc::new(w.connector());
    // 没填中继就要配对码：拒绝并说明。
    let e = c.create_pairing(&user()).unwrap_err();
    assert!(e.message.contains("请先填写中继地址和 token"));
    c.update_config(
        &user(),
        &json!({ "relayUrl": RELAY_URL, "token": support::TOKEN }),
    )
    .unwrap();
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let c = c.clone();
            std::thread::spawn(move || c.create_pairing(&user()).unwrap())
        })
        .collect();
    let codes: Vec<Value> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(codes.windows(2).all(|p| p[0] == p[1]));
    assert_eq!(c.create_pairing(&user()).unwrap(), codes[0]);
}

#[test]
fn reset_space_leaves_only_a_revocation_and_the_new_code_works() {
    let w = world("pair-reset", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let old = connect(&c, &w.relay);
    let old_phone = phone_for(&w.relay, &old);
    wait_for(|| !head_projects(&old_phone).is_empty(), "首次发布");
    let result = c.reset_space(&user()).unwrap();
    assert_ne!(result["spaceId"], json!(old_phone.space_id));
    assert!(result["removed"].as_u64().unwrap() > 0);
    assert!(result.get("cleanupError").is_none(), "{result}");
    // 旧空间只剩撤销标记。
    let prefix = format!("atm1/{}/", old_phone.space_id);
    let left: Vec<String> = w
        .relay
        .keys()
        .into_iter()
        .filter(|k| k.starts_with(&prefix))
        .collect();
    assert_eq!(left, [format!("{prefix}revoked")]);
    assert!(old_phone.store.read_revoked().unwrap().is_some());
    let fresh = c.create_pairing(&user()).unwrap();
    let new_phone = phone_for(&w.relay, fresh["pairingCode"].as_str().unwrap());
    wait_for(|| !head_projects(&new_phone).is_empty(), "新空间发布");
    c.stop();
}

#[test]
fn the_phones_presence_shows_up_as_a_paired_device_and_this_pc_does_not() {
    let w = world("pair-devices", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let pairing = connect(&c, &w.relay);
    let phone = phone_for(&w.relay, &pairing);
    phone
        .store
        .write_device(&json!({ "v": 1, "id": phone.device.id, "name": "测试手机", "kind": "android", "role": "client", "app": "1.0.0", "at": atm_sync::time::iso(atm_sync::time::now_ms()), "state": "online" }))
        .unwrap();
    wait_for(
        || {
            c.status(&user()).unwrap()["paired"]
                .as_array()
                .unwrap()
                .len()
                == 1
        },
        "手机出现",
    );
    let paired = c.status(&user()).unwrap()["paired"][0].clone();
    assert_eq!(paired["name"], "测试手机");
    assert!(paired.get("v").is_none());
    c.stop();
}

#[test]
fn test_relay_reports_without_reflecting_relay_text() {
    let w = world("relay-test", &[("PA", "ALPHA", true)]);
    let c = w.connector();
    let r = c
        .test_relay(
            &user(),
            &json!({ "relayUrl": RELAY_URL, "token": support::TOKEN }),
        )
        .unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["server"], "app-data");
    let bad = c
        .test_relay(
            &user(),
            &json!({ "relayUrl": RELAY_URL, "token": "wrong-token-9876" }),
        )
        .unwrap();
    assert_eq!(bad["ok"], false);
    assert!(!bad.to_string().contains("wrong-token-9876"));
    assert_eq!(
        c.test_relay(&user(), &json!({ "nope": 1 })).unwrap()["error"],
        "测试参数不合法"
    );
    assert_eq!(
        c.test_relay(&user(), &Value::Null).unwrap()["error"],
        "还没有填写中继地址"
    );
}
