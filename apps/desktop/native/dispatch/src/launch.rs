//! 怎么起 claude（2.x `launch.ts`）：参数数组、命令行、子进程环境、派单编号与会话 ID。
//!
//! 提示词不上命令行（从 stdin 写入）。每个参数都是枚举或按白名单校验过的，经 cmd.exe 转发也没有可注入的字符。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::config::{DispatchConfig, EFFORTS, PERMISSION_MODES, model_ok};
use crate::errors::{DispatchError, invalid};

/// `^[A-Z][A-Z0-9]*-T-\d{4,}$`：任务键会进命令行（`--name "ATM · <key>"`），入口处按它校验。
pub fn task_key_ok(key: &str) -> bool {
    let Some((code, number)) = key.split_once("-T-") else {
        return false;
    };
    let mut c = code.bytes();
    c.next().is_some_and(|b| b.is_ascii_uppercase())
        && c.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && number.len() >= 4
        && number.bytes().all(|b| b.is_ascii_digit())
}

/// `^[0-9a-z]{1,16}-[0-9a-f]{8}$`：毫秒时间的 base36 + 8 位随机 hex，按字典序大致就是时间序。
pub fn run_id_ok(run: &str) -> bool {
    let Some((time, random)) = run.split_once('-') else {
        return false;
    };
    (1..=16).contains(&time.len())
        && time
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        && random.len() == 8
        && random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        let d = (n % 36) as u8;
        out.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`。系统随机数不可用时是 `None`。
pub fn new_run_id(now_ms: i64) -> Option<String> {
    let random = atm_sync_protocol::encoding::random_bytes::<4>()?;
    Some(format!(
        "{}-{}",
        base36(u64::try_from(now_ms).unwrap_or(0)),
        hex(&random)
    ))
}

/// `crypto.randomUUID()`：小写的第 4 版 UUID。
pub fn new_session_id() -> Option<String> {
    let mut b = atm_sync_protocol::encoding::random_bytes::<16>()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    Some(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

fn uuid_ok(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| {
            g.len() == n
                && g.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// `claude -p` 的参数数组（2.x `claudeArguments`）。
pub fn claude_arguments(
    session_id: &str,
    key: &str,
    config: &DispatchConfig,
) -> Result<Vec<String>, DispatchError> {
    if !task_key_ok(key) {
        return Err(invalid(format!("任务键格式不合法：{key}")));
    }
    if !uuid_ok(session_id) {
        return Err(invalid("会话 ID 必须是小写 UUID"));
    }
    if !PERMISSION_MODES.contains(&config.permission_mode.as_str()) {
        return Err(invalid("权限模式不合法"));
    }
    if config.model.as_deref().is_some_and(|m| !model_ok(m)) {
        return Err(invalid("model 只能包含字母、数字与 ._-"));
    }
    if config
        .effort
        .as_deref()
        .is_some_and(|e| !EFFORTS.contains(&e))
    {
        return Err(invalid("effort 不合法"));
    }
    let mut args: Vec<String> = [
        "-p",
        "--permission-mode",
        &config.permission_mode,
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        session_id,
        "--name",
        &format!("ATM · {key}"),
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(model) = &config.model {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(effort) = &config.effort {
        args.extend(["--effort".to_owned(), effort.clone()]);
    }
    Ok(args)
}

/// 要起的程序，与原样拼在它后面的参数串（`CreateProcessW` 的整行命令行是两者之和）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: PathBuf,
    pub raw_args: String,
}

impl LaunchCommand {
    pub fn command_line(&self) -> String {
        format!(
            "{} {}",
            crt_quote(&self.program.to_string_lossy()),
            self.raw_args
        )
    }
}

/// cmd.exe 在双引号里仍会展开 `%VAR%`、`!VAR!`，引号本身与换行也无法安全表示。
fn cmd_quote(value: &str) -> Result<String, DispatchError> {
    if value
        .chars()
        .any(|c| matches!(c, '"' | '%' | '!' | '^' | '\r' | '\n' | '\0'))
    {
        return Err(invalid(
            "参数含 cmd.exe 无法安全转义的字符（引号、%、!、^ 或换行）",
        ));
    }
    let bare = !value.is_empty()
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'.' | b'_' | b':' | b'\\' | b'/' | b'=' | b'-')
        });
    Ok(if bare {
        value.to_owned()
    } else {
        format!("\"{value}\"")
    })
}

/// C 运行库的一个参数（libuv `quote_cmd_arg`）：不含空白与引号的原样，否则加引号，反斜杠只在引号前成对。
pub fn crt_quote(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '"'))
    {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                slashes = 0;
                out.push(c);
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// 把「claude 路径 + 参数」变成可直接起的命令，不经 shell（2.x `launchCommand`）：
/// - `.cmd` / `.bat`（npm 装法）：`cmd.exe /d /s /c "<整行>"`，每个参数都过 [`cmd_quote`]；
/// - 其余（官方安装器的 `claude.exe`）：直接起，参数按 C 运行库规则加引号。
///
/// 2.x 还认 `.js` / `.mjs`（用当前 Node 跑，给它的假 claude 用）；3.0 没有 Node，不再支持。
pub fn launch_command(
    claude: &Path,
    args: &[String],
    comspec: Option<&Path>,
) -> Result<LaunchCommand, DispatchError> {
    let text = claude.to_string_lossy();
    let extension = claude
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    if matches!(extension.as_deref(), Some("cmd" | "bat")) {
        let mut line = cmd_quote(&text)?;
        for a in args {
            line.push(' ');
            line.push_str(&cmd_quote(a)?);
        }
        let shell = comspec.map_or_else(|| PathBuf::from("cmd.exe"), Path::to_path_buf);
        return Ok(LaunchCommand {
            program: shell,
            raw_args: format!("/d /s /c \"{line}\""),
        });
    }
    if matches!(extension.as_deref(), Some("js" | "mjs" | "cjs")) {
        return Err(invalid(
            "找到的 claude 是一个 Node 脚本：ATM 3 不再带 Node，请安装 Claude Code 的原生版本",
        ));
    }
    let raw_args: Vec<String> = args.iter().map(|a| crt_quote(a)).collect();
    Ok(LaunchCommand {
        program: claude.to_path_buf(),
        raw_args: raw_args.join(" "),
    })
}

/// 从宿主环境继承时要去掉的变量（2.x `HOST_SESSION_ENV`）：它们属于「当前这个 Claude 会话」或 ATM 的用户凭证，
/// 继承下去会把派单会话串到宿主会话上（或把不该给 Agent 的凭证交出去）。用户配置类变量一律保留。
pub const HOST_SESSION_ENV: &[(&str, &str)] = &[
    (
        "CLAUDECODE",
        "标记「已在 Claude Code 会话里」，子进程会按嵌套会话处理",
    ),
    (
        "CLAUDE_CODE_ENTRYPOINT",
        "宿主的入口类型，子会话会冒用宿主的入口身份",
    ),
    (
        "CLAUDE_CODE_SSE_PORT",
        "宿主会话连着的 IDE 扩展端口，子会话会去连宿主的 IDE",
    ),
    (
        "CLAUDE_CODE_SESSION_ID",
        "宿主会话 ID；派单会话用自己的 --session-id",
    ),
    (
        "CLAUDE_CODE_HOST_SESSION_ID",
        "Claude 桌面 App 给宿主会话的绑定 ID",
    ),
    (
        "CLAUDE_CODE_CHILD_SESSION",
        "标记「由某个宿主会话派生」，派单会话是独立会话",
    ),
    (
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "宿主会话与桌面 App 之间的 IPC 管道",
    ),
    (
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "上面那条 IPC 管道的令牌，属于宿主会话的密钥",
    ),
    (
        "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
        "登录态由宿主经 SDK 刷新；派单会话没有宿主，只能用自己的登录态",
    ),
    (
        "CLAUDE_CODE_SESSION_ATTENDED",
        "宿主会话有人值守；派单会话无人值守",
    ),
    ("CLAUDE_CODE_EXECPATH", "宿主 claude 可执行文件的路径"),
    ("CLAUDE_PID", "宿主 claude 进程的 PID"),
    (
        "CLAUDE_AGENT_SDK_VERSION",
        "宿主经 Agent SDK 拉起；派单会话不是",
    ),
    (
        "CLAUDE_CODE_DESKTOP_APP_VERSION",
        "宿主嵌在 Claude 桌面 App 里；派单会话不是",
    ),
    (
        "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
        "桌面 App 终端面板只提供给宿主会话的工具清单",
    ),
    (
        "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
        "宿主界面能回答提问；无头会话没人回答，只会卡住",
    ),
    (
        "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
        "SDK 宿主的文件检查点协议，无头会话没有接收方",
    ),
    (
        "SENTRY-TRACE",
        "宿主的链路追踪上下文，派单会话会被记到宿主的 trace 下",
    ),
    ("BAGGAGE", "同上（W3C baggage 追踪上下文）"),
    (
        "AYANAMI_TASK_USER_TOKEN",
        "ATM 用户凭证：交给 Agent 会让 USER_ONLY 形同虚设",
    ),
];

pub const RUN_ENV: &str = "ATM_DISPATCH_RUN";

/// 派单子进程的环境：继承 `base`，去掉 [`HOST_SESSION_ENV`]（大小写不敏感），加上 `ATM_DISPATCH_RUN`。
/// 按名字（不分大小写）排序：`CreateProcessW` 的环境块要求如此。
pub fn child_env(base: &[(OsString, OsString)], run: &str) -> Vec<(OsString, OsString)> {
    let stripped = |name: &str| {
        let upper = name.to_ascii_uppercase();
        upper == RUN_ENV || HOST_SESSION_ENV.iter().any(|(n, _)| *n == upper)
    };
    let mut env: Vec<(OsString, OsString)> = base
        .iter()
        .filter(|(name, _)| !stripped(&name.to_string_lossy()))
        .cloned()
        .collect();
    env.push((RUN_ENV.into(), run.into()));
    env.sort_by_key(|(name, _)| name.to_string_lossy().to_ascii_uppercase());
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0b7a9c1e-3f2d-4c5b-8a6e-1d2c3b4a5f60";

    fn config() -> DispatchConfig {
        DispatchConfig::default()
    }

    #[test]
    fn the_argument_array_is_fixed_and_carries_no_prompt() {
        let args = claude_arguments(SESSION, "ATM-T-0545", &config()).unwrap();
        assert_eq!(
            args,
            [
                "-p",
                "--permission-mode",
                "auto",
                "--output-format",
                "stream-json",
                "--verbose",
                "--session-id",
                SESSION,
                "--name",
                "ATM · ATM-T-0545"
            ]
        );
        let tuned = DispatchConfig {
            permission_mode: "plan".into(),
            model: Some("claude-opus-5-5".into()),
            effort: Some("max".into()),
            ..config()
        };
        let args = claude_arguments(SESSION, "ATM-T-0545", &tuned).unwrap();
        assert_eq!(args[2], "plan");
        assert_eq!(
            args[args.len() - 4..],
            ["--model", "claude-opus-5-5", "--effort", "max"]
        );
    }

    #[test]
    fn bad_keys_models_and_session_ids_never_reach_the_command_line() {
        for key in [
            "atm-t-0001",
            "ATM-T-01",
            "ATM-T-0001 & calc",
            "A-T-0001\"",
            "-T-0001",
            "A-T-",
        ] {
            assert!(claude_arguments(SESSION, key, &config()).is_err(), "{key}");
        }
        let bad_model = DispatchConfig {
            model: Some("a b".into()),
            ..config()
        };
        assert!(claude_arguments(SESSION, "A-T-0001", &bad_model).is_err());
        assert!(claude_arguments("x", "A-T-0001", &config()).is_err());
        assert!(claude_arguments(&SESSION.to_uppercase(), "A-T-0001", &config()).is_err());
        assert!(task_key_ok("A1-T-00001"));
    }

    #[test]
    fn an_npm_cmd_goes_through_cmd_exe_with_each_argument_quoted() {
        let args = claude_arguments(SESSION, "ATM-T-0545", &config()).unwrap();
        let cmd = launch_command(
            Path::new(r"C:\Users\Tom Jerry\AppData\Roaming\npm\claude.cmd"),
            &args,
            Some(Path::new(r"C:\Windows\system32\cmd.exe")),
        )
        .unwrap();
        assert_eq!(cmd.program, Path::new(r"C:\Windows\system32\cmd.exe"));
        assert_eq!(
            cmd.command_line(),
            format!(
                r#"C:\Windows\system32\cmd.exe /d /s /c ""C:\Users\Tom Jerry\AppData\Roaming\npm\claude.cmd" -p --permission-mode auto --output-format stream-json --verbose --session-id {SESSION} --name "ATM · ATM-T-0545"""#
            )
        );
        assert!(launch_command(Path::new(r"C:\100%\claude.cmd"), &args, None).is_err());
        assert!(
            launch_command(Path::new(r"C:\x\CLAUDE.BAT"), &args, None)
                .unwrap()
                .command_line()
                .starts_with("cmd.exe /d /s /c ")
        );
        let exe = launch_command(Path::new(r"C:\x y\claude.exe"), &args, None).unwrap();
        assert_eq!(exe.program, Path::new(r"C:\x y\claude.exe"));
        assert!(
            exe.command_line()
                .starts_with(r#""C:\x y\claude.exe" -p --permission-mode auto"#)
        );
        assert!(exe.command_line().ends_with(r#"--name "ATM · ATM-T-0545""#));
        assert!(launch_command(Path::new("/opt/fake.mjs"), &args, None).is_err());
    }

    #[test]
    fn crt_quoting_round_trips_backslashes_and_quotes() {
        assert_eq!(crt_quote("plain"), "plain");
        assert_eq!(crt_quote(""), "\"\"");
        assert_eq!(crt_quote(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(crt_quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(crt_quote(r#"a\"b"#), r#""a\\\"b""#);
    }

    #[test]
    fn host_session_variables_and_the_user_token_are_stripped() {
        let base: Vec<(OsString, OsString)> = [
            ("PATH", "p"),
            ("CLAUDECODE", "1"),
            ("claude_code_entrypoint", "sdk-ts"),
            ("CLAUDE_CODE_SSE_PORT", "1234"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
            ("AYANAMI_TASK_USER_TOKEN", "user-secret"),
            ("SENTRY-TRACE", "t"),
            ("ANTHROPIC_BASE_URL", "https://proxy.example"),
            ("ANTHROPIC_API_KEY", "sk-user"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("HTTPS_PROXY", "http://127.0.0.1:7890"),
            ("ATM_DISPATCH_RUN", "stale"),
        ]
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let env = child_env(&base, "run-1");
        let names: Vec<String> = env
            .iter()
            .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
            .collect();
        assert_eq!(
            names,
            [
                "ANTHROPIC_API_KEY=sk-user",
                "ANTHROPIC_BASE_URL=https://proxy.example",
                "ATM_DISPATCH_RUN=run-1",
                "CLAUDE_CODE_USE_BEDROCK=1",
                "HTTPS_PROXY=http://127.0.0.1:7890",
                "PATH=p",
            ]
        );
        assert!(
            !HOST_SESSION_ENV
                .iter()
                .any(|(n, _)| n.starts_with("ANTHROPIC_") || n.contains("PROXY"))
        );
    }

    #[test]
    fn run_and_session_ids_have_the_2x_shapes() {
        let run = new_run_id(1_791_024_100_252).unwrap();
        assert!(run_id_ok(&run), "{run}");
        assert!(run.starts_with(&format!("{}-", base36(1_791_024_100_252))));
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        let session = new_session_id().unwrap();
        assert!(uuid_ok(&session), "{session}");
        assert_eq!(&session[14..15], "4");
        assert!(!run_id_ok("ABC-12345678"));
        assert!(!run_id_ok("abc-1234567g"));
    }
}
