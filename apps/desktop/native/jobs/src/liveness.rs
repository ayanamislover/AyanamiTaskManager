//! Agent 客户端进程还在不在（R11 A4）：`X-ATM-Client` 记下的 `<pid>:<创建时间>[@名字]`。
//! 创建时间是 FILETIME 刻度（atm-mcp 桥取的是同一口径），pid 被复用时对不上，按「已退出」算。

use atm_install_state::procs;

/// 格式不对（没有身份、不是 `<pid>:<ticks>`）→ `None`：按没有身份处理，走普通的心跳超时。
pub fn alive(identity: &str) -> Option<bool> {
    let head = identity.split('@').next()?;
    let (pid, ticks) = head.split_once(':')?;
    let pid: u32 = pid.parse().ok()?;
    let ticks: u64 = ticks.parse().ok()?;
    if pid == 0 || ticks == 0 {
        return None;
    }
    Some(procs::find(pid).is_some_and(|p| p.created == ticks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_client_is_recognised_by_pid_and_birth() {
        let me = procs::find(std::process::id()).unwrap();
        let mine = format!("{}:{}@claude-code", me.pid, me.created);
        assert_eq!(alive(&mine), Some(true));
        assert_eq!(alive(&format!("{}:{}", me.pid, me.created)), Some(true));
        // 同一个 pid、不同的出生时间：被复用的 pid，原来的客户端已经退出。
        assert_eq!(
            alive(&format!("{}:{}@x", me.pid, me.created + 1)),
            Some(false)
        );
        for junk in ["", "claude", "12@x", "x:1", "0:5", "5:0", ":"] {
            assert_eq!(alive(junk), None, "{junk}");
        }
    }
}
