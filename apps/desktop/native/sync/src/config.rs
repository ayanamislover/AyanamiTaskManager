//! 同步配置（2.x `packages/sync/src/config.ts`）。存在库里（`atm_service::sync_state`），这里管默认值、
//! 格式校验与已处理命令的保留期。

use atm_service::sync_state::SyncLedger;
use atm_sync_protocol::encoding::js_trim;
use atm_sync_protocol::keys::{
    command_timestamp, is_app_id, is_command_id, is_device_id, is_project_code, is_space_id,
    new_device_id,
};
use atm_sync_protocol::schema::{COMMAND_MAX_AGE_MS, PROJECT_HEAD, check};

use crate::text::{clip_units, js_len};

/// 2.x 的 `SyncConfig` 就是库里的账本。
pub type SyncConfig = SyncLedger;

/// 已处理命令 ID 记多久：按 ID 里内嵌的发送时间算，命令有效期（7 天）再加 1 天余量才忘。余量覆盖
/// 「ID 时间与 `at` 允许差 10 分钟」和电脑时钟回拨；忘掉的命令再被重放，一定会因 COMMAND_EXPIRED 被拒。
/// 手机时钟快了（ID 时间在未来）的命令记得更久，不会提前忘。
pub const PROCESSED_RETENTION_MS: u64 = COMMAND_MAX_AGE_MS + 24 * 60 * 60 * 1000;
/// 硬上限。真被挤掉的旧 ID 再被重放时，建任务有 ATM 的 op_id 幂等，派单有请求账本兜底。
pub const PROCESSED_COMMAND_LIMIT: usize = 2_000;
pub const DEFAULT_APP_ID: &str = "atm";
pub const DEVICE_NAME_MAX: usize = 64;

/// 主机名当设备名；空的用「ATM 电脑」，超长按 UTF-16 截到 64（与配对码的 `n` 同一上限）。
pub fn default_device_name(name: &str) -> String {
    let trimmed = js_trim(name);
    let name = if trimmed.is_empty() {
        "ATM 电脑"
    } else {
        trimmed
    };
    clip_units(name, DEVICE_NAME_MAX)
}

/// 本机的 DNS 主机名（Node 的 `os.hostname()`）。取不到是空串。
pub fn hostname() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{
            ComputerNameDnsHostname, GetComputerNameExW,
        };
        let mut size: u32 = 0;
        // SAFETY: 第一次只问长度。
        unsafe { GetComputerNameExW(ComputerNameDnsHostname, std::ptr::null_mut(), &mut size) };
        if size == 0 || size > 1024 {
            return String::new();
        }
        let mut buf = vec![0u16; size as usize];
        // SAFETY: 缓冲区长度如实给出。
        if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut size) } == 0
        {
            return String::new();
        }
        buf.truncate(size as usize);
        String::from_utf16_lossy(&buf)
    }
    #[cfg(not(windows))]
    {
        String::new()
    }
}

/// 新装的默认配置：未启用、没有中继、新的设备 ID（首次保存后就固定下来）。系统随机数取不到时是 `None`。
pub fn default_config(device_name: &str) -> Option<SyncConfig> {
    Some(SyncLedger {
        enabled: false,
        relay_url: None,
        app_id: DEFAULT_APP_ID.to_owned(),
        device_id: new_device_id(false)?,
        device_name: device_name.to_owned(),
        space_id: None,
        cursor: None,
        published: Default::default(),
        head_digest: None,
        processed: Vec::new(),
        last_sync_at: None,
        last_ack_sweep_at: None,
    })
}

/// 2.x `SyncConfigSchema`：不合格的账本按「损坏」处理（用默认值）。
pub fn is_valid(c: &SyncConfig) -> bool {
    let short = |s: &Option<String>| s.as_deref().is_none_or(|s| js_len(s) <= 512);
    is_app_id(&c.app_id)
        && is_device_id(&c.device_id)
        && (1..=DEVICE_NAME_MAX).contains(&js_len(&c.device_name))
        && short(&c.relay_url)
        && c.space_id.as_deref().is_none_or(is_space_id)
        && short(&c.cursor)
        && c.processed.len() <= PROCESSED_COMMAND_LIMIT
        && c.processed.iter().all(|id| is_command_id(id))
        && c.published
            .iter()
            .all(|(code, p)| is_project_code(code) && check(&PROJECT_HEAD, &p.head).is_some())
}

/// 记下已处理的命令 ID，同时忘掉发送时间早于保留期的；仍超出硬上限时丢最早记下的。
/// 不是按条数滚动：旧窗口只留 500 条，7 天内再处理 500 条命令，早先的 ID 就被挤掉，重放原密文会被
/// 当成新命令再执行一次。没有变化时返回 `None`。
pub fn remember_processed(
    config: &SyncConfig,
    command_id: &str,
    now_ms: u64,
) -> Option<SyncConfig> {
    let cutoff = now_ms as i128 - PROCESSED_RETENTION_MS as i128;
    let mut kept: Vec<String> = config
        .processed
        .iter()
        .filter(|id| command_timestamp(id).is_none_or(|sent| sent as i128 >= cutoff))
        .cloned()
        .collect();
    if !kept.iter().any(|id| id == command_id) {
        kept.push(command_id.to_owned());
    }
    let skip = kept.len().saturating_sub(PROCESSED_COMMAND_LIMIT);
    let processed: Vec<String> = kept.split_off(skip);
    if processed == config.processed {
        return None;
    }
    Some(SyncConfig {
        processed,
        ..config.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atm_sync_protocol::keys::command_id;

    #[test]
    fn device_names_are_trimmed_and_clipped() {
        assert_eq!(default_device_name("  "), "ATM 电脑");
        assert_eq!(default_device_name(" 工作站 "), "工作站");
        let long = "长".repeat(80);
        assert_eq!(js_len(&default_device_name(&long)), 64);
    }

    #[test]
    fn processed_ids_expire_by_their_own_timestamp() {
        let day = 24 * 60 * 60 * 1000u64;
        let now = 1_800_000_000_000u64;
        let id = |at: u64| command_id("m-0123456789ab", at, [1, 2, 3, 4]).unwrap();
        let mut c = default_config("pc").unwrap();
        c.processed = vec![id(now - 9 * day), id(now - 7 * day), id(now + 3 * day)];
        let next = remember_processed(&c, &id(now), now).unwrap();
        assert_eq!(
            next.processed,
            [id(now - 7 * day), id(now + 3 * day), id(now)]
        );
        assert!(remember_processed(&next, &id(now), now).is_none());
    }

    #[test]
    fn the_hard_limit_drops_the_oldest_entries() {
        let now = 1_800_000_000_000u64;
        let mut c = default_config("pc").unwrap();
        c.processed = (0..PROCESSED_COMMAND_LIMIT as u64)
            .map(|i| command_id("m-0123456789ab", now - 1000 + i, [0, 0, 0, 0]).unwrap())
            .collect();
        let fresh = command_id("m-0123456789ab", now, [9, 9, 9, 9]).unwrap();
        let next = remember_processed(&c, &fresh, now).unwrap();
        assert_eq!(next.processed.len(), PROCESSED_COMMAND_LIMIT);
        assert_eq!(next.processed.last(), Some(&fresh));
        assert_eq!(next.processed[0], c.processed[1]);
    }
}
