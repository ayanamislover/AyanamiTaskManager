//! .lnk files with the properties Squirrel set: target, arguments, working directory, icon,
//! and the AppUserModel ID / ToastActivatorCLSID that tie taskbar grouping and toast
//! settings to this app. A snapshot keeps all of them, so a restore is exact.

use std::path::Path;

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Storage::EnhancedStorage::{
    PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0, PropVariantClear,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemAlloc, IPersistFile, STGM_READ,
};
use windows::Win32::System::Variant::{VT_CLSID, VT_EMPTY, VT_LPWSTR};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::core::{GUID, Interface, PCWSTR, PWSTR};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub target: String,
    pub arguments: String,
    pub working_dir: String,
    pub icon_path: String,
    pub icon_index: i32,
    pub description: String,
    pub app_user_model_id: Option<String>,
    /// `{xxxxxxxx-xxxx-...}`
    pub toast_activator_clsid: Option<String>,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn com() {
    // S_FALSE (already initialized) and RPC_E_CHANGED_MODE are both fine for our use.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
}

fn error(context: &str, error: windows::core::Error) -> String {
    format!("{context}: {error}")
}

fn format_guid(guid: &GUID) -> String {
    format!("{{{guid:?}}}")
}

fn parse_guid(text: &str) -> Option<GUID> {
    let hex: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (hex.len() == 32).then(|| GUID::from_u128(u128::from_str_radix(&hex, 16).unwrap_or(0)))
}

fn read_property(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<String> {
    let mut value = unsafe { store.GetValue(key) }.ok()?;
    let text = unsafe {
        let inner = &value.Anonymous.Anonymous;
        if inner.vt == VT_LPWSTR && !inner.Anonymous.pwszVal.is_null() {
            inner.Anonymous.pwszVal.to_string().ok()
        } else if inner.vt == VT_CLSID && !inner.Anonymous.puuid.is_null() {
            Some(format_guid(&*inner.Anonymous.puuid))
        } else {
            None
        }
    };
    let _ = unsafe { PropVariantClear(&mut value) };
    text
}

fn string_variant(text: &str) -> PROPVARIANT {
    let units = wide(text);
    let bytes = units.len() * 2;
    let pointer = unsafe { CoTaskMemAlloc(bytes) } as *mut u16;
    unsafe { std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len()) };
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(pointer),
                },
                ..Default::default()
            }),
        },
    }
}

fn guid_variant(guid: GUID) -> PROPVARIANT {
    let pointer = unsafe { CoTaskMemAlloc(std::mem::size_of::<GUID>()) } as *mut GUID;
    unsafe { pointer.write(guid) };
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_CLSID,
                Anonymous: PROPVARIANT_0_0_0 { puuid: pointer },
                ..Default::default()
            }),
        },
    }
}

fn empty_variant() -> PROPVARIANT {
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_EMPTY,
                ..Default::default()
            }),
        },
    }
}

pub fn read(path: &Path) -> Result<Option<Shortcut>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    com();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| error("ShellLink", e))?;
        let file: IPersistFile = link.cast().map_err(|e| error("IPersistFile", e))?;
        let name = wide(&path.to_string_lossy());
        file.Load(PCWSTR(name.as_ptr()), STGM_READ)
            .map_err(|e| error("Load", e))?;
        let mut buffer = vec![0u16; 1024];
        let mut shortcut = Shortcut::default();
        // SLGP_RAWPATH: keep environment strings as written.
        if link.GetPath(&mut buffer, std::ptr::null_mut(), 4).is_ok() {
            shortcut.target = from_wide(&buffer);
        }
        buffer.fill(0);
        if link.GetArguments(&mut buffer).is_ok() {
            shortcut.arguments = from_wide(&buffer);
        }
        buffer.fill(0);
        if link.GetWorkingDirectory(&mut buffer).is_ok() {
            shortcut.working_dir = from_wide(&buffer);
        }
        buffer.fill(0);
        let mut index = 0;
        if link.GetIconLocation(&mut buffer, &mut index).is_ok() {
            shortcut.icon_path = from_wide(&buffer);
            shortcut.icon_index = index;
        }
        buffer.fill(0);
        if link.GetDescription(&mut buffer).is_ok() {
            shortcut.description = from_wide(&buffer);
        }
        if let Ok(store) = link.cast::<IPropertyStore>() {
            shortcut.app_user_model_id = read_property(&store, &PKEY_AppUserModel_ID);
            shortcut.toast_activator_clsid =
                read_property(&store, &PKEY_AppUserModel_ToastActivatorCLSID);
        }
        Ok(Some(shortcut))
    }
}

pub fn write(path: &Path, shortcut: &Shortcut) -> Result<(), String> {
    com();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| error("ShellLink", e))?;
        link.SetPath(PCWSTR(wide(&shortcut.target).as_ptr()))
            .map_err(|e| error("SetPath", e))?;
        link.SetArguments(PCWSTR(wide(&shortcut.arguments).as_ptr()))
            .map_err(|e| error("SetArguments", e))?;
        link.SetWorkingDirectory(PCWSTR(wide(&shortcut.working_dir).as_ptr()))
            .map_err(|e| error("SetWorkingDirectory", e))?;
        if !shortcut.icon_path.is_empty() {
            link.SetIconLocation(
                PCWSTR(wide(&shortcut.icon_path).as_ptr()),
                shortcut.icon_index,
            )
            .map_err(|e| error("SetIconLocation", e))?;
        }
        link.SetDescription(PCWSTR(wide(&shortcut.description).as_ptr()))
            .map_err(|e| error("SetDescription", e))?;
        let store: IPropertyStore = link.cast().map_err(|e| error("IPropertyStore", e))?;
        let mut id = match &shortcut.app_user_model_id {
            Some(id) => string_variant(id),
            None => empty_variant(),
        };
        store
            .SetValue(&PKEY_AppUserModel_ID, &id)
            .map_err(|e| error("AppUserModel.ID", e))?;
        let _ = PropVariantClear(&mut id);
        if let Some(guid) = shortcut
            .toast_activator_clsid
            .as_deref()
            .and_then(parse_guid)
        {
            let mut clsid = guid_variant(guid);
            store
                .SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &clsid)
                .map_err(|e| error("ToastActivatorCLSID", e))?;
            let _ = PropVariantClear(&mut clsid);
        }
        store.Commit().map_err(|e| error("Commit", e))?;
        let file: IPersistFile = link.cast().map_err(|e| error("IPersistFile", e))?;
        let name = wide(&path.to_string_lossy());
        file.Save(PCWSTR(name.as_ptr()), true)
            .map_err(|e| error("Save", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_property_survives_a_round_trip() {
        let dir = std::path::absolute(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
                .join("setup-tests")
                .join("shortcut"),
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("ATM.lnk");
        let shortcut = Shortcut {
            target: r"C:\Windows\System32\notepad.exe".into(),
            arguments: "--background".into(),
            working_dir: r"C:\Windows".into(),
            icon_path: r"C:\Windows\System32\notepad.exe".into(),
            icon_index: 0,
            description: "绫波任务管理器".into(),
            app_user_model_id: Some(crate::env::APP_USER_MODEL_ID.into()),
            toast_activator_clsid: Some("{69f12b18-2bbb-5b7a-98b5-b8f0246b08a6}".into()),
        };
        write(&path, &shortcut).unwrap();
        let read_back = read(&path).unwrap().unwrap();
        assert_eq!(read_back.target, shortcut.target);
        assert_eq!(read_back.arguments, shortcut.arguments);
        assert_eq!(read_back.working_dir, shortcut.working_dir);
        assert_eq!(read_back.description, shortcut.description);
        assert_eq!(read_back.app_user_model_id, shortcut.app_user_model_id);
        assert_eq!(
            read_back.toast_activator_clsid.map(|id| id.to_lowercase()),
            shortcut.toast_activator_clsid
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
