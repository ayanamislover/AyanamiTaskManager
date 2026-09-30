//! Shared build.rs body for the host, the root launcher and setup: embeds the application
//! icon (resource 1: window, tray, shortcuts, Uninstall DisplayIcon) and a VERSIONINFO
//! resource. Same approach and rc.exe discovery as the MCP shim.
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

/// What the resource says about one executable.
pub struct Resource<'a> {
    /// Stem for the .rc/.res files and the `cargo:warning` text.
    pub name: &'a str,
    pub description: &'a str,
    pub original_filename: &'a str,
}

/// Call from a crate's build.rs under apps/desktop/native/<crate>.
pub fn embed(resource: Resource<'_>) {
    let package_json = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../../../../package.json");
    let icon = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../../../../logo.ico");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", package_json.display());
    println!("cargo:rerun-if-changed={}", icon.display());
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
        println!(
            "cargo:warning=rc.exe not found; {} is built without icon and version resources",
            resource.name
        );
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
    let icon_path = icon.display().to_string().replace('\\', "/");
    let script = format!(
        r#"1 ICON "{icon_path}"
1 VERSIONINFO
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
      VALUE "FileDescription", "{description}"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "AyanamiTaskManager"
      VALUE "OriginalFilename", "{original_filename}"
      VALUE "ProductName", "AyanamiTaskManager"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
        description = resource.description,
        original_filename = resource.original_filename,
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let source = out.join(format!("{}.rc", resource.name));
    let compiled = out.join(format!("{}.res", resource.name));
    fs::write(&source, script).expect("write .rc");
    let status = Command::new(&rc)
        .arg("/nologo")
        // The script is UTF-8 (descriptions may be Chinese); rc.exe defaults to ANSI.
        .arg("/c65001")
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
