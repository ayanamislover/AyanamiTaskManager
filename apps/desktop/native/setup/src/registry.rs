//! HKCU values the install owns: the Uninstall key, the Run value. Snapshots keep raw
//! type + bytes so a restore puts back exactly what Squirrel (or a user) wrote.

use std::collections::BTreeMap;
use std::ptr::null_mut;

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_DWORD, REG_EXPAND_SZ,
    REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW,
    RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawValue {
    pub kind: u32,
    pub data: Vec<u8>,
}

impl RawValue {
    pub fn string(text: &str) -> RawValue {
        let data = wide(text)
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        RawValue { kind: REG_SZ, data }
    }
    pub fn dword(value: u32) -> RawValue {
        RawValue {
            kind: REG_DWORD,
            data: value.to_le_bytes().to_vec(),
        }
    }
    pub fn as_string(&self) -> Option<String> {
        if self.kind != REG_SZ && self.kind != REG_EXPAND_SZ {
            return None;
        }
        let units: Vec<u16> = self
            .data
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn open(path: &str, access: u32) -> Result<Option<Key>, String> {
    let mut key: HKEY = null_mut();
    let status =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, access, &mut key) };
    match status {
        ERROR_SUCCESS => Ok(Some(Key(key))),
        ERROR_FILE_NOT_FOUND => Ok(None),
        other => Err(format!("RegOpenKeyEx {path}: {other}")),
    }
}

fn create(path: &str) -> Result<Key, String> {
    let mut key: HKEY = null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            wide(path).as_ptr(),
            0,
            null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_READ | KEY_WRITE,
            null_mut(),
            &mut key,
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyEx {path}: {status}"));
    }
    Ok(Key(key))
}

/// All values of a key; `None` if the key does not exist.
pub fn read_key(path: &str) -> Result<Option<BTreeMap<String, RawValue>>, String> {
    let Some(key) = open(path, KEY_READ)? else {
        return Ok(None);
    };
    let mut values = BTreeMap::new();
    for index in 0.. {
        let mut name = vec![0u16; 16384];
        let mut name_len = name.len() as u32;
        let mut kind = 0u32;
        let mut data = vec![0u8; 64 * 1024];
        let mut data_len = data.len() as u32;
        let status = unsafe {
            RegEnumValueW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut name_len,
                null_mut(),
                &mut kind,
                data.as_mut_ptr(),
                &mut data_len,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            return Err(format!("RegEnumValue {path}: {status}"));
        }
        data.truncate(data_len as usize);
        values.insert(
            String::from_utf16_lossy(&name[..name_len as usize]),
            RawValue { kind, data },
        );
    }
    Ok(Some(values))
}

pub fn read_value(path: &str, name: &str) -> Result<Option<RawValue>, String> {
    let Some(key) = open(path, KEY_READ)? else {
        return Ok(None);
    };
    let mut kind = 0u32;
    let mut data = vec![0u8; 64 * 1024];
    let mut data_len = data.len() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            null_mut(),
            &mut kind,
            data.as_mut_ptr(),
            &mut data_len,
        )
    };
    match status {
        ERROR_SUCCESS => {
            data.truncate(data_len as usize);
            Ok(Some(RawValue { kind, data }))
        }
        ERROR_FILE_NOT_FOUND => Ok(None),
        other => Err(format!("RegQueryValueEx {path}\\{name}: {other}")),
    }
}

pub fn write_value(path: &str, name: &str, value: &RawValue) -> Result<(), String> {
    let key = create(path)?;
    let status = unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            value.kind,
            value.data.as_ptr(),
            value.data.len() as u32,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegSetValueEx {path}\\{name}: {status}"));
    }
    Ok(())
}

pub fn delete_value(path: &str, name: &str) -> Result<(), String> {
    let Some(key) = open(path, KEY_WRITE)? else {
        return Ok(());
    };
    match unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) } {
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
        other => Err(format!("RegDeleteValue {path}\\{name}: {other}")),
    }
}

pub fn delete_key(path: &str) -> Result<(), String> {
    match unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(path).as_ptr()) } {
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
        other => Err(format!("RegDeleteTree {path}: {other}")),
    }
}

/// Remove `path` only if it has no subkeys (values alone do not block it).
#[cfg(test)]
pub fn delete_key_if_empty(path: &str) {
    use windows_sys::Win32::System::Registry::RegDeleteKeyW;
    unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(path).as_ptr()) };
}

/// Make the key hold exactly `values` (restore from a snapshot), or remove it if `None`.
pub fn restore_key(path: &str, values: &Option<BTreeMap<String, RawValue>>) -> Result<(), String> {
    delete_key(path)?;
    if let Some(values) = values {
        create(path)?;
        for (name, value) in values {
            write_value(path, name, value)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip_and_restore_is_exact() {
        let path = format!(
            r"Software\AyanamiTaskManagerDrill\unit-{}",
            std::process::id()
        );
        let _ = delete_key(&path);
        write_value(&path, "Name", &RawValue::string("绫波")).unwrap();
        write_value(&path, "Size", &RawValue::dword(7)).unwrap();
        let saved = read_key(&path).unwrap();
        assert_eq!(
            read_value(&path, "Name")
                .unwrap()
                .unwrap()
                .as_string()
                .as_deref(),
            Some("绫波")
        );
        write_value(&path, "Extra", &RawValue::string("x")).unwrap();
        delete_value(&path, "Name").unwrap();
        restore_key(&path, &saved).unwrap();
        assert_eq!(read_key(&path).unwrap(), saved);
        restore_key(&path, &None).unwrap();
        assert_eq!(read_key(&path).unwrap(), None);
        delete_key_if_empty(r"Software\AyanamiTaskManagerDrill");
    }
}
