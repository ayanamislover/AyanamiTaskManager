//! atm-setup: install, update, migrate from Squirrel, roll back, repair, recover, uninstall
//! (de-electron plan v9 §6). Replaces Squirrel's Update.exe and electron-winstaller.
#![windows_subsystem = "windows"]

#[macro_use]
mod log;
mod env;
mod fault;
mod fsx;
mod legacy;
mod maintain;
mod package;
mod procs;
mod quiesce;
mod register;
mod registry;
mod reverse;
mod runtime;
mod shortcut;
mod snapshot;
mod store;
mod txn;
mod webview2;

use std::path::PathBuf;

use atm_install_state::Outcome;

/// Exit codes the launcher, host and scripts rely on.
const EXIT_OK: i32 = 0;
const EXIT_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_RECOVERY_FAILED: i32 = 3;
const EXIT_ROLLED_BACK: i32 = 4;

fn attach_console() {
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

struct Args {
    command: String,
    manifest: Option<PathBuf>,
    force: bool,
    quiet: bool,
    retry: bool,
    from_temp: bool,
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        command: String::new(),
        manifest: None,
        force: false,
        quiet: false,
        retry: false,
        from_temp: false,
    };
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--force" => args.force = true,
            "--quiet" => args.quiet = true,
            "--retry" => args.retry = true,
            "--from-temp" => args.from_temp = true,
            "install" | "--install" | "--update" => {
                args.command = "install".into();
                args.manifest = Some(PathBuf::from(
                    rest.next().ok_or("install needs <manifest.json>")?,
                ));
            }
            "--recover" | "--repair" | "--rollback" | "--uninstall" | "--status" => {
                args.command = arg.trim_start_matches("--").into();
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if args.command.is_empty() {
        args.command = "install".into();
    }
    Ok(args)
}

/// No manifest given: the newest `atm-*-win-x64.json` next to this setup (a downloaded
/// installer folder).
fn manifest_beside_me() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut found: Vec<(String, PathBuf)> = fsx::list_dir(&dir)
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let version = name
                .strip_prefix("atm-")?
                .strip_suffix("-win-x64.json")?
                .to_owned();
            Some((version, path))
        })
        .collect();
    found.sort_by(|left, right| package::compare_versions(&left.0, &right.0));
    found.pop().map(|(_, path)| path)
}

fn outcome_exit(outcome: Outcome) -> i32 {
    match outcome {
        Outcome::Committed => EXIT_OK,
        Outcome::Aborted => EXIT_FAILED,
        Outcome::RolledBack => EXIT_ROLLED_BACK,
        Outcome::RecoveryFailed => EXIT_RECOVERY_FAILED,
    }
}

fn install(env: env::Env, args: &Args) -> i32 {
    let Some(manifest) = args.manifest.clone().or_else(manifest_beside_me) else {
        log::warn("没有找到安装包清单（atm-x.y.z-win-x64.json）。");
        return EXIT_USAGE;
    };
    let package = match package::load(&manifest) {
        Ok(package) => package,
        Err(error) => {
            log::warn(&format!("安装包无效：{error}"));
            return EXIT_FAILED;
        }
    };
    let version = package.manifest.version.clone();
    let mut setup = match txn::Setup::open(env, txn::Options { force: args.force }) {
        Ok(setup) => setup,
        Err(error) => {
            log::warn(&format!("无法开始安装：{error}"));
            return EXIT_FAILED;
        }
    };
    match setup.install(&package, args.retry) {
        Ok(outcome) => {
            if !args.quiet {
                log::inform(&format!("AyanamiTaskManager {version} 已安装。"));
            }
            outcome_exit(outcome)
        }
        Err(error) => {
            log::warn(&format!("安装没有完成，原来的版本保持不变。\n\n{error}"));
            // The outcome is in the journal; map it for scripts.
            let outcome = atm_install_state::read_journal(&setup.env.install_root)
                .ok()
                .flatten()
                .and_then(|txn| txn.outcome);
            outcome.map(outcome_exit).unwrap_or(EXIT_FAILED)
        }
    }
}

fn with_setup(
    env: env::Env,
    args: &Args,
    run: impl FnOnce(&mut txn::Setup) -> Result<i32, String>,
) -> i32 {
    match txn::Setup::open(env, txn::Options { force: args.force }) {
        Ok(mut setup) => match run(&mut setup) {
            Ok(code) => code,
            Err(error) => {
                log::warn(&error);
                EXIT_FAILED
            }
        },
        Err(error) => {
            log::warn(&error);
            EXIT_FAILED
        }
    }
}

fn real_main() -> i32 {
    attach_console();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse(&argv) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            return EXIT_USAGE;
        }
    };
    let env = match env::Env::detect() {
        Ok(env) => env,
        Err(error) => {
            eprintln!("{error}");
            return EXIT_FAILED;
        }
    };
    // The temporary uninstall copy logs next to itself only; the root is going away.
    if !args.from_temp {
        log::init(&env.state_dir(), args.quiet);
    } else {
        log::init(&std::env::temp_dir().join("atm-setup-uninstall-log"), true);
    }
    say!(
        "atm-setup {} {argv:?} root={}",
        env!("CARGO_PKG_VERSION"),
        env.install_root.display()
    );

    match args.command.as_str() {
        "install" => install(env, &args),
        "recover" => with_setup(env, &args, |setup| setup.recover().map(outcome_exit)),
        "rollback" => with_setup(env, &args, |setup| setup.rollback().map(outcome_exit)),
        "repair" => {
            let launcher = env.launcher();
            let code = with_setup(env, &args, |setup| {
                maintain::repair(setup).map(|()| EXIT_OK)
            });
            if code == EXIT_OK && !args.quiet {
                let _ = procs::spawn(&launcher, &[]);
            }
            code
        }
        "uninstall" => {
            let code = match maintain::uninstall(&env, args.quiet, args.force) {
                Ok(()) => EXIT_OK,
                Err(error) if error.starts_with("UNINSTALL_CANCELLED") => EXIT_FAILED,
                Err(error) => {
                    log::warn(&error);
                    EXIT_FAILED
                }
            };
            if args.from_temp {
                let _ =
                    std::fs::remove_dir_all(std::env::temp_dir().join("atm-setup-uninstall-log"));
                maintain::schedule_self_delete();
            }
            code
        }
        "status" => {
            println!("{}", maintain::status(&env));
            EXIT_OK
        }
        _ => EXIT_USAGE,
    }
}

fn main() {
    std::process::exit(real_main());
}
