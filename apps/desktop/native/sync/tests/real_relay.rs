//! 对真实的 apps/relay 跑的契约用例：中继客户端的每个接口，以及连接器从配对到回执的一整圈。
//!
//! 要先构建中继（`pnpm --filter @ayanami/relay build`），再用 `ATM_RELAY_BIN` 指向 `atm-relay.mjs` 显式运行：
//! `cargo test -p atm-sync --test real_relay -- --ignored`。中继监听 127.0.0.1 的随机端口，地址从它启动时那行
//! 「已启动：<地址>」读；token 从数据目录的 initial-token.txt 读，只留在内存里，不打印。

mod support;

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use atm_sync::connector::{Connector, Phase};
use atm_sync::relay::{RelayClient, RelayClientOptions, RelayErrorCode};
use atm_sync::space::{DeviceRef, SpaceStore, SpaceStoreOptions, StoreError};
use atm_sync::transport::Transport;
use atm_sync::winhttp::WinHttp;
use atm_sync_protocol::SpaceKeys;
use atm_sync_protocol::pairing::decode_pairing_code;
use serde_json::{Value, json};
use support::world::{Opts, test_root, user, wait_for, world};

const NEEDS_RELAY: &str = "需要 ATM_RELAY_BIN 指向构建好的 atm-relay.mjs";

struct RealRelay {
    child: Child,
    url: String,
    token: String,
    dir: PathBuf,
}

impl RealRelay {
    fn spawn(name: &str) -> RealRelay {
        let bin = std::env::var_os("ATM_RELAY_BIN").expect(NEEDS_RELAY);
        let dir = test_root().join("real-relay").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new("node")
            .arg(bin)
            .args(["serve", "--listen", "127.0.0.1:0", "--data"])
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("启动 node");
        // 两路输出都一直读到底（不读满了会卡住中继），只把行交给这里找启动那行。
        let (tx, rx) = mpsc::channel::<String>();
        let drain = |pipe: Box<dyn Read + Send>, tx: mpsc::Sender<String>| {
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        };
        drain(Box::new(child.stdout.take().unwrap()), tx.clone());
        drain(Box::new(child.stderr.take().unwrap()), tx);
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = Vec::new();
        let url = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(line) => {
                    if let Some(rest) = line.split("已启动：").nth(1) {
                        break rest.split('（').next().unwrap().trim().to_owned();
                    }
                    seen.push(line);
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("中继没有启动：{seen:?}");
                }
            }
        };
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        let token = std::fs::read_to_string(dir.join("initial-token.txt"))
            .unwrap()
            .trim()
            .to_owned();
        assert!(!token.is_empty());
        RealRelay {
            child,
            url,
            token,
            dir,
        }
    }

    fn client(&self, token: &str) -> RelayClient {
        RelayClient::new(RelayClientOptions {
            base_url: self.url.clone(),
            app_id: "atm".into(),
            token: token.into(),
            transport: transport(),
            timeout: Some(Duration::from_secs(10)),
            lifetime: None,
        })
        .unwrap()
    }
}

impl Drop for RealRelay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn transport() -> Arc<dyn Transport> {
    Arc::new(WinHttp::new("AyanamiTaskManager-test/3.0"))
}

/// 手机一侧的轮询放慢到 100 ms 一次：手机和电脑共用一枚 token，atm-relay 默认每 token 每秒 50 次。
fn poll(mut check: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("等待超时：{what}");
}

/// 被限流（429）就按 retry_after 等了再试，其余错误照常失败。
fn patient<T>(mut f: impl FnMut() -> Result<T, StoreError>) -> T {
    for _ in 0..20 {
        match f() {
            Ok(v) => return v,
            Err(StoreError::Relay(e)) if e.status == 429 => {
                std::thread::sleep(Duration::from_secs_f64(e.retry_after.unwrap_or(1.0)));
            }
            Err(e) => panic!("{e:?}"),
        }
    }
    panic!("一直被限流");
}

const KEY: &str = "atm1/0123456789abcdef01234567/dev/pc-0123456789ab";

#[test]
#[ignore = "需要 ATM_RELAY_BIN 指向构建好的 atm-relay.mjs"]
fn the_client_speaks_the_real_relays_document_and_change_contract() {
    let relay = RealRelay::spawn("client");
    let c = relay.client(&relay.token);
    let probe = c.probe().unwrap();
    assert_eq!(probe.app_id, "atm");
    assert_eq!(probe.server, "atm-relay");
    assert!(probe.version.is_some());

    // 变更流：从头拉，拿到游标。
    let start = c.changes(None, Some(500), 0.0, None).unwrap();
    assert!(start.changes.is_empty());
    let cursor = start.next_cursor.clone();

    // 新建、读、按修订号覆盖。
    let created = c.put_document(KEY, 0.0, &json!({ "n": 1 })).unwrap();
    assert!(created.meta.revision >= 1.0);
    let read = c.get_document(KEY, None).unwrap().unwrap();
    assert_eq!(read.data, Some(json!({ "n": 1 })));
    assert_eq!(read.meta.revision, created.meta.revision);
    let updated = c
        .put_document(KEY, created.meta.revision, &json!({ "n": 2 }))
        .unwrap();
    assert!(updated.meta.revision > created.meta.revision);

    // 修订号过期：409，current 带当前修订号；新建一个已存在的键同样是 409。
    for stale in [created.meta.revision, 0.0] {
        let e = c.put_document(KEY, stale, &json!({ "n": 3 })).unwrap_err();
        assert_eq!((e.status, e.code), (409, RelayErrorCode::RevisionConflict));
        assert_eq!(
            e.current.as_ref().map(|x| x.revision),
            Some(updated.meta.revision)
        );
        assert_eq!(e.message, "文档已被其它设备修改");
    }

    // 列表按前缀。
    let listed = c.list_documents("atm1/0123456789abcdef01234567/").unwrap();
    assert_eq!(
        listed.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(),
        [KEY]
    );
    assert!(
        c.list_documents("atm1/ffffffffffffffffffffffff/")
            .unwrap()
            .is_empty()
    );

    // 变更流里看得到这两次写。
    let page = c.changes(cursor.as_deref(), Some(500), 0.0, None).unwrap();
    let seen: Vec<(&str, f64)> = page
        .changes
        .iter()
        .map(|x| (x.key.as_str(), x.revision))
        .collect();
    assert_eq!(
        seen,
        [(KEY, created.meta.revision), (KEY, updated.meta.revision)]
    );
    let after = page.next_cursor.clone();
    assert!(
        after
            .as_deref()
            .is_some_and(|c| c.bytes().all(|b| b.is_ascii_digit())),
        "{after:?}"
    );

    // 删除：修订号不对是 409；对了删掉；再删是不存在。
    let e = c.delete_document(KEY, created.meta.revision).unwrap_err();
    assert_eq!(e.code, RelayErrorCode::RevisionConflict);
    assert!(c.delete_document(KEY, updated.meta.revision).unwrap());
    assert!(!c.delete_document(KEY, updated.meta.revision).unwrap());
    assert!(c.get_document(KEY, None).unwrap().is_none());
    let deleted = c.changes(after.as_deref(), Some(500), 0.0, None).unwrap();
    assert_eq!(deleted.changes.len(), 1);
    assert_eq!(deleted.changes[0].op, atm_sync::relay::ChangeOp::Delete);

    // 长轮询：atm-relay 支持，带 wait 等；期间写一次立刻返回。
    assert!(probe.long_poll && probe.max_wait >= 5.0, "{probe:?}");
    {
        let waiter = {
            let c = c.clone();
            let cursor = deleted.next_cursor.clone();
            std::thread::spawn(move || {
                let began = Instant::now();
                let page = c.changes(cursor.as_deref(), Some(500), 5.0, None).unwrap();
                (page.changes.len(), began.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        c.put_document(KEY, 0.0, &json!({ "n": 4 })).unwrap();
        let (n, took) = waiter.join().unwrap();
        assert_eq!(n, 1);
        assert!(took < Duration::from_secs(4), "{took:?}");
    }

    // 别家中继的游标：400。
    let e = c
        .changes(Some("cloud:opaque"), Some(500), 0.0, None)
        .unwrap_err();
    assert_eq!(e.status, 400);

    // 错的 token：401，算鉴权失败；报错文字是本地写死的，不带中继原文。
    let e = relay
        .client("atm_wrong_token_0000000000000000")
        .probe()
        .unwrap_err();
    assert_eq!((e.status, e.code), (401, RelayErrorCode::Unauthorized));
    assert!(e.is_auth_failure());
    assert!(!e.message.contains("atm_wrong_token"));
}

#[test]
#[ignore = "需要 ATM_RELAY_BIN 指向构建好的 atm-relay.mjs"]
fn a_phone_command_goes_round_the_real_relay_and_stop_cuts_the_long_poll() {
    let relay = RealRelay::spawn("connector");
    let w = world("real-connector", &[("PA", "ALPHA", true)]);
    let key = w.seed_task("ALPHA", "已有的任务");
    let c: Connector = w.connector_with(Opts {
        transport: Some(transport()),
        ..Default::default()
    });
    c.update_config(
        &user(),
        &json!({ "enabled": true, "relayUrl": relay.url, "token": relay.token }),
    )
    .unwrap();
    c.start().unwrap();
    let pairing = c.create_pairing(&user()).unwrap()["pairingCode"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_for(
        || c.status(&user()).unwrap()["state"] == "online",
        "连接器上线",
    );
    let status = c.status(&user()).unwrap();
    assert!(!status.to_string().contains(&relay.token));

    // 手机一侧：配对码里的地址、token 与空间密钥就够用了。
    let p = decode_pairing_code(&pairing).unwrap();
    assert_eq!(p.relay_url, relay.url);
    let phone = SpaceStore::new(SpaceStoreOptions {
        client: relay.client(&p.relay_token),
        keys: SpaceKeys::derive(&p.space_secret).unwrap(),
        space_id: p.space_id.clone(),
        retry_delay: Some(Duration::from_millis(50)),
        lifetime: None,
        sleep: None,
    })
    .unwrap();
    let mut head = None;
    poll(
        || {
            head = patient(|| phone.read_head());
            head.as_ref()
                .is_some_and(|h| h["projects"].as_array().is_some_and(|p| p.len() == 1))
        },
        "head 发布到真实中继",
    );
    let hash = head.unwrap()["projects"][0]["h"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = patient(|| phone.read_project(&hash)).unwrap();
    assert_eq!(doc["tasks"][0]["key"], json!(key));

    let device = DeviceRef {
        id: "m-0123456789ab".into(),
        name: "测试手机".into(),
    };
    let now = atm_sync::time::now_ms();
    let input = json!({ "type": "task.create", "body": { "project": "ALPHA", "title": "手机经真实中继建的" } });
    let sent =
        patient(|| phone.send_command(&device, &input, now as u64, &atm_sync::time::iso(now)));
    let id = sent["id"].as_str().unwrap().to_owned();
    let mut ack: Option<Value> = None;
    poll(
        || {
            ack = patient(|| phone.read_ack(&id));
            ack.is_some()
        },
        "回执",
    );
    let ack = ack.unwrap();
    assert_eq!(ack["ok"], true, "{ack}");
    let created = ack["result"]["key"].as_str().unwrap().to_owned();
    let task = w.task("ALPHA", &created);
    assert_eq!(task["title"], "手机经真实中继建的");
    assert!(patient(|| phone.read_command(&id)).is_none(), "命令已删");

    // 建的任务出现在重新发布的快照里。
    poll(
        || {
            patient(|| phone.read_project(&hash)).is_some_and(|d| {
                d["tasks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["key"] == json!(created))
            })
        },
        "新任务进快照",
    );

    // 重置空间（运行中；和 2.x 一样，停止之后设置页的中继请求都会被取消）：旧空间只剩撤销标记。
    let reset = c.reset_space(&user()).unwrap();
    assert!(reset.get("cleanupError").is_none(), "{reset}");
    let old = relay
        .client(&relay.token)
        .list_documents(&format!("atm1/{}/", p.space_id))
        .unwrap();
    assert_eq!(
        old.iter().map(|d| d.key.clone()).collect::<Vec<_>>(),
        [format!("atm1/{}/revoked", p.space_id)]
    );
    assert!(patient(|| phone.read_revoked()).is_some());
    let fresh = c.create_pairing(&user()).unwrap()["pairingCode"]
        .as_str()
        .unwrap()
        .to_owned();
    let q = decode_pairing_code(&fresh).unwrap();
    assert_ne!(q.space_id, p.space_id);
    let phone = SpaceStore::new(SpaceStoreOptions {
        client: relay.client(&q.relay_token),
        keys: SpaceKeys::derive(&q.space_secret).unwrap(),
        space_id: q.space_id.clone(),
        retry_delay: Some(Duration::from_millis(50)),
        lifetime: None,
        sleep: None,
    })
    .unwrap();
    poll(|| patient(|| phone.read_head()).is_some(), "新空间发布");

    // 中继支持长轮询时连接器正挂在一次等待上：停止要在预算内回来，并写出离线状态。
    std::thread::sleep(Duration::from_millis(300));
    let began = Instant::now();
    c.stop();
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(c.phase(), Phase::Stopped);
    let me = c.config().device_id;
    assert_eq!(
        patient(|| phone.read_device(&me)).unwrap()["state"],
        "offline"
    );
}
