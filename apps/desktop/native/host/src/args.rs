//! Command line of the host. Unknown arguments are an error, never a guess (§3.1).

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    pub background: bool,
    pub random_startup_delay: bool,
    pub agent_wake: bool,
    pub txn_start: Option<String>,
    pub health_probe: Option<String>,
    pub squirrel_event: Option<String>,
    pub headless: Option<Headless>,
    #[cfg(feature = "smoke")]
    pub smoke_quit: bool,
}

/// Modes that run a Node entry with inherited stdio instead of the GUI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Headless {
    /// `--cli <args…>` and `--doctor`
    Cli(Vec<String>),
    /// `--mcp-stdio [--profile p]`, or the Electron-as-node legacy form
    /// `<dataDir>\mcp-stdio.cjs [--profile p]` with ELECTRON_RUN_AS_NODE=1.
    McpStdio(Vec<String>),
}

fn is_txn_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn profile_args(rest: &[String]) -> Result<Vec<String>, String> {
    match rest {
        [] => Ok(Vec::new()),
        [flag, profile]
            if flag == "--profile" && matches!(profile.as_str(), "core" | "memory" | "actions") =>
        {
            Ok(vec![flag.clone(), profile.clone()])
        }
        _ => Err("MCP_PROFILE_INVALID: expected --profile core|memory|actions".into()),
    }
}

pub fn parse(argv: &[String], electron_run_as_node: bool) -> Result<Args, String> {
    let mut args = Args::default();
    let first = argv.first().map(String::as_str);
    // Legacy Agent configs: `current\AyanamiTaskManager.exe <dataDir>\mcp-stdio.cjs` with
    // ELECTRON_RUN_AS_NODE=1. Route to the new bridge; never run an arbitrary script.
    if electron_run_as_node {
        return match first {
            Some(script) if script.to_ascii_lowercase().ends_with("mcp-stdio.cjs") => {
                args.headless = Some(Headless::McpStdio(profile_args(&argv[1..])?));
                Ok(args)
            }
            _ => Err("ELECTRON_RUN_AS_NODE_UNSUPPORTED".into()),
        };
    }
    match first {
        Some("--cli") => {
            args.headless = Some(Headless::Cli(argv[1..].to_vec()));
            return Ok(args);
        }
        Some("--doctor") if argv.len() == 1 => {
            args.headless = Some(Headless::Cli(vec!["--doctor".into()]));
            return Ok(args);
        }
        Some("--mcp-stdio") => {
            args.headless = Some(Headless::McpStdio(profile_args(&argv[1..])?));
            return Ok(args);
        }
        Some(
            event @ ("--squirrel-install"
            | "--squirrel-updated"
            | "--squirrel-uninstall"
            | "--squirrel-obsolete"),
        ) => {
            args.squirrel_event = Some(event.to_owned());
            return Ok(args);
        }
        _ => {}
    }
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--background" => args.background = true,
            "--random-startup-delay" => args.random_startup_delay = true,
            "--agent-wake" => args.agent_wake = true,
            "--squirrel-firstrun" => {}
            "--txn-start" => match iter.next() {
                Some(id) if is_txn_id(id) => args.txn_start = Some(id.clone()),
                _ => return Err("TXN_ID_INVALID".into()),
            },
            "--health-probe" => {}
            "--txn" => match iter.next() {
                Some(id) if is_txn_id(id) => args.health_probe = Some(id.clone()),
                _ => return Err("TXN_ID_INVALID".into()),
            },
            #[cfg(feature = "smoke")]
            "--smoke-quit" => args.smoke_quit = true,
            other => return Err(format!("ARGUMENT_UNKNOWN: {other}")),
        }
    }
    if argv.iter().any(|arg| arg == "--health-probe") != args.health_probe.is_some() {
        return Err("HEALTH_PROBE_REQUIRES_TXN".into());
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn gui_flags_and_transaction_ids() {
        let args = parse(&v(&["--background", "--random-startup-delay"]), false).unwrap();
        assert!(args.background && args.random_startup_delay && !args.agent_wake);
        assert_eq!(
            parse(&v(&["--txn-start", "t-1"]), false)
                .unwrap()
                .txn_start
                .as_deref(),
            Some("t-1")
        );
        assert_eq!(
            parse(&v(&["--health-probe", "--txn", "t1"]), false)
                .unwrap()
                .health_probe
                .as_deref(),
            Some("t1")
        );
        assert!(parse(&v(&["--health-probe"]), false).is_err());
        assert!(parse(&v(&["--txn-start", "../x"]), false).is_err());
        assert!(parse(&v(&["--open-devtools"]), false).is_err());
    }

    #[test]
    fn legacy_commands_route_to_headless_bridges() {
        assert_eq!(
            parse(&v(&["--mcp-stdio", "--profile", "memory"]), false)
                .unwrap()
                .headless,
            Some(Headless::McpStdio(v(&["--profile", "memory"])))
        );
        assert!(parse(&v(&["--mcp-stdio", "--profile", "evil"]), false).is_err());
        assert_eq!(
            parse(
                &v(&[
                    r"C:\Users\u\AppData\Local\AyanamiTaskManager\mcp-stdio.cjs",
                    "--profile",
                    "core"
                ]),
                true
            )
            .unwrap()
            .headless,
            Some(Headless::McpStdio(v(&["--profile", "core"])))
        );
        // Electron-as-node with any other script is refused, not executed.
        assert!(parse(&v(&[r"C:\evil.js"]), true).is_err());
        assert_eq!(
            parse(&v(&["--doctor"]), false).unwrap().headless,
            Some(Headless::Cli(v(&["--doctor"])))
        );
        assert_eq!(
            parse(&v(&["--cli", "project", "list"]), false)
                .unwrap()
                .headless,
            Some(Headless::Cli(v(&["project", "list"])))
        );
        assert_eq!(
            parse(&v(&["--squirrel-updated", "1.2.3"]), false)
                .unwrap()
                .squirrel_event
                .as_deref(),
            Some("--squirrel-updated")
        );
    }
}
