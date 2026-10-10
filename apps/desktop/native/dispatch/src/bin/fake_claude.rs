//! 用例里当作 claude 拉起的假程序（2.x `test/fixtures/fake-claude.mjs`），模拟 `claude -p --output-format stream-json`。
//!
//! - 会话的行为由工作目录里的 `fake-claude.json` 决定：
//!   `{ "mode": "success" | "fail" | "error-result" | "auth-stderr" | "api-error" | "slow" | "tree", "delayMs": 数字 }`。
//!   `tree` 再起一个孙进程一起睡着，用例据此核对「结束整棵进程树」。
//! - `auth status` 由环境变量 `FAKE_CLAUDE_AUTH_FILE` 指向的 JSON 决定：`{ "mode": "in" | "out" | "hang" | "garbage" }`，
//!   没有这个变量时视为已登录；每探一次往 `<文件>.count` 追加一行，用例据此数探测次数。
//! - 每次会话都把收到的参数、stdin、工作目录与环境变量名写进 `fake-claude-dump-<ATM_DISPATCH_RUN>.json`。

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--grandchild") {
        std::thread::sleep(Duration::from_secs(120));
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("9.9.9 (Fake Claude)");
        return;
    }
    if args.first().map(String::as_str) == Some("auth")
        && args.get(1).map(String::as_str) == Some("status")
    {
        auth();
        return;
    }
    session(&args);
}

fn auth() {
    let mut mode = "in".to_owned();
    if let Some(file) = std::env::var_os("FAKE_CLAUDE_AUTH_FILE") {
        let file = Path::new(&file).to_path_buf();
        let count = format!("{}.count", file.display());
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(count)
        {
            let _ = f.write_all(b"probe\n");
        }
        if let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(v) = serde_json::from_str::<Value>(&text)
            && let Some(m) = v["mode"].as_str()
        {
            mode = m.to_owned();
        }
    }
    match mode.as_str() {
        "hang" => std::thread::sleep(Duration::from_secs(60)),
        "garbage" => println!("Usage: claude auth [command]"),
        _ => {
            let logged_in = mode != "out";
            let body = json!({
                "loggedIn": logged_in,
                "authMethod": if logged_in { "claude.ai" } else { "none" },
                "apiProvider": "firstParty",
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&body).unwrap_or_default()
            );
            if !logged_in {
                std::process::exit(1);
            }
        }
    }
}

fn line(v: Value) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn session(args: &[String]) {
    let cwd = std::env::current_dir().unwrap_or_default();
    let behavior: Value = std::fs::read_to_string(cwd.join("fake-claude.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let mode = behavior["mode"].as_str().unwrap_or("success").to_owned();
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let run = std::env::var("ATM_DISPATCH_RUN").unwrap_or_else(|_| "unknown".into());
    let session_id = args
        .iter()
        .position(|a| a == "--session-id")
        .and_then(|i| args.get(i + 1))
        .cloned();
    let mut grandchild = None;
    if mode == "tree"
        && let Ok(exe) = std::env::current_exe()
    {
        grandchild = std::process::Command::new(exe)
            .arg("--grandchild")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()
            .map(|c| c.id());
    }
    // 环境变量只记名字；值只记用例关心、且不含任何密钥的几个。
    let shown = [
        "ATM_DISPATCH_RUN",
        "KEEP_DISPATCH_VALUE",
        "HTTPS_PROXY",
        "ANTHROPIC_BASE_URL",
    ];
    let names: Vec<String> = std::env::vars_os()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    let env: serde_json::Map<String, Value> = shown
        .iter()
        .map(|n| {
            (
                (*n).to_owned(),
                std::env::var(n).map_or(Value::Null, Value::String),
            )
        })
        .collect();
    let dump = json!({
        "args": args,
        "stdin": stdin,
        "cwd": cwd.to_string_lossy(),
        "envNames": names,
        "env": env,
        "pid": std::process::id(),
        "grandchild": grandchild,
    });
    let _ = std::fs::write(
        cwd.join(format!("fake-claude-dump-{run}.json")),
        dump.to_string(),
    );
    line(
        json!({ "type": "system", "subtype": "init", "session_id": session_id, "cwd": cwd.to_string_lossy() }),
    );
    line(
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "开工" }] } }),
    );
    match mode.as_str() {
        "slow" | "tree" => {
            std::thread::sleep(Duration::from_millis(
                behavior["delayMs"].as_u64().unwrap_or(60_000),
            ));
        }
        _ => {}
    }
    match mode.as_str() {
        "fail" => {
            eprintln!("fake-claude: boom");
            std::process::exit(2);
        }
        "error-result" => {
            line(json!({
                "type": "result", "subtype": "success", "is_error": true, "num_turns": 1, "duration_ms": 104,
                "total_cost_usd": 0, "result": "Failed to authenticate: OAuth session expired and could not be refreshed"
            }));
            std::process::exit(1);
        }
        "auth-stderr" => {
            eprintln!("Invalid API key · Please run /login");
            std::process::exit(1);
        }
        "api-error" => {
            // 与登录无关的失败；stderr 里夹一条 MCP 的 OAuth 提示，不能被当成「claude 没登录」。
            eprintln!("MCP server \"figma\" requires OAuth authorization");
            line(
                json!({ "type": "result", "subtype": "success", "is_error": true, "num_turns": 2, "result": "API Error: 529 overloaded_error" }),
            );
            std::process::exit(1);
        }
        _ => {
            line(json!({
                "type": "result", "subtype": "success", "is_error": false, "num_turns": 3, "duration_ms": 1234,
                "total_cost_usd": 0.0123, "result": format!("完成 {run}：{}", "很长的总结".repeat(200))
            }));
        }
    }
}
