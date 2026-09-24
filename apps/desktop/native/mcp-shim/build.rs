//! Embeds a VERSIONINFO resource with the same product fields as the desktop exe.
//!
//! An unsigned executable without any version information is both harder for a user to
//! recognise in Task Manager and more suspicious to heuristic antivirus engines. The
//! resource is compiled with the Windows SDK's rc.exe. A developer machine without the
//! SDK still builds (with a warning); packaging sets ATM_REQUIRE_VERSION_RESOURCE=1 so a
//! release can never ship without it.
//!
//! The product version is read from the repository's package.json, the single version
//! source that the release bump rewrites. Cargo.toml keeps a fixed placeholder version,
//! so a bump never has to touch Cargo.toml or Cargo.lock (a stale lock would break
//! `cargo build --locked`).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let package_json = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../../../../package.json");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-env-changed=RC");
    println!("cargo:rerun-if-env-changed=ATM_REQUIRE_VERSION_RESOURCE");
    let windows_msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return;
    }
    let required = env::var("ATM_REQUIRE_VERSION_RESOURCE").as_deref() == Ok("1");
    let Some(rc) = find_rc() else {
        if required {
            panic!("rc.exe not found (Windows SDK); set RC to its path");
        }
        println!("cargo:warning=rc.exe not found; atm-mcp.exe is built without a version resource");
        return;
    };

    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&package_json)
            .unwrap_or_else(|error| panic!("read {}: {error}", package_json.display())),
    )
    .expect("package.json is JSON");
    let version = manifest["version"]
        .as_str()
        .expect("package.json has a string version")
        .to_owned();
    let numbers: Vec<u16> = version
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    let [major, minor, patch] = [0, 1, 2].map(|i| numbers.get(i).copied().unwrap_or(0));
    let script = format!(
        r#"1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "ayanami"
      VALUE "FileDescription", "AyanamiTaskManager MCP stdio bridge"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "atm-mcp"
      VALUE "OriginalFilename", "atm-mcp.exe"
      VALUE "ProductName", "AyanamiTaskManager"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let source = out.join("atm-mcp.rc");
    let compiled = out.join("atm-mcp.res");
    fs::write(&source, script).expect("write atm-mcp.rc");
    let status = Command::new(&rc)
        .arg("/nologo")
        .arg("/fo")
        .arg(&compiled)
        .arg(&source)
        .status()
        .unwrap_or_else(|error| panic!("failed to run {}: {error}", rc.display()));
    assert!(status.success(), "rc.exe failed: {status}");
    // link.exe accepts a compiled .res as an ordinary input.
    println!("cargo:rustc-link-arg-bins={}", compiled.display());
}

fn find_rc() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("RC").map(PathBuf::from) {
        return explicit.is_file().then_some(explicit);
    }
    let kits = PathBuf::from(env::var_os("ProgramFiles(x86)")?)
        .join("Windows Kits")
        .join("10")
        .join("bin");
    let mut versions: Vec<PathBuf> = fs::read_dir(kits)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.join("x64").join("rc.exe").is_file())
        .collect();
    // Directory names are SDK versions (10.0.26100.0); compare them numerically.
    versions.sort_by_key(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.split('.')
                    .map(|part| part.parse::<u32>().unwrap_or(0))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    versions.pop().map(|path| path.join("x64").join("rc.exe"))
}
