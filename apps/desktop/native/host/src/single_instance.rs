//! The pipe and single-instance rules are shared with setup (atm-install-state::ipc).

pub use atm_install_state::ipc::*;

/// de-electron §9 负例「second-instance 管道发任意载荷 → 忽略」走真实命名管道：
/// `parse_command` 的单元用例只证明解析；这里证明服务线程对任何不在固定枚举里的字节
/// 都不调用 deliver、不回 ok，而且被乱发一通之后照样能处理下一条合法命令。
#[cfg(test)]
mod pipe_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    /// 只用来算管道名，不建任何文件；带进程号，与真实数据根和并行用例都不撞名。
    fn scope_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("atm-host-pipe-test")
            .join(format!("{}-{name}", std::process::id()))
    }

    /// 像任意同用户进程那样直接打开管道写原始字节，返回服务端的回复（断开则为空）。
    fn raw_send(data_dir: &std::path::Path, payload: &[u8]) -> Vec<u8> {
        let name = pipe_name(data_dir);
        let mut pipe = None;
        // 服务线程在每次断开后复用同一个实例；上一位客户端刚走时可能短暂 busy。
        for _ in 0..50 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&name)
            {
                Ok(file) => {
                    pipe = Some(file);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        let mut pipe = pipe.expect("pipe should accept a client");
        if pipe.write_all(payload).is_err() {
            return Vec::new();
        }
        let mut reply = [0u8; 64];
        match pipe.read(&mut reply) {
            Ok(read) => reply[..read].to_vec(),
            Err(_) => Vec::new(),
        }
    }

    #[test]
    fn arbitrary_payloads_on_the_pipe_are_ignored() {
        let data_dir = scope_root("arbitrary");
        let (sender, delivered) = mpsc::channel::<Command>();
        serve(&data_dir, move |command| {
            let _ = sender.send(command);
        })
        .expect("serve");

        let mut payloads: Vec<Vec<u8>> = vec![
            b"not json".to_vec(),
            b"{}".to_vec(),
            // serde 的序列形式（首元素当标签）：未知标签、越界路由同样拒绝。
            br#"["RUN","calc.exe"]"#.to_vec(),
            br#"["NAVIGATE","C:/Windows"]"#.to_vec(),
            br#"{"cmd":"show"}"#.to_vec(),
            br#"{"cmd":"RUN","script":"calc.exe"}"#.to_vec(),
            br#"{"cmd":"EVAL","code":"process.exit()"}"#.to_vec(),
            br#"{"cmd":"NAVIGATE","route":"C:\\Windows\\System32"}"#.to_vec(),
            br#"{"cmd":"NAVIGATE","route":"https://example.com/"}"#.to_vec(),
            br#"{"cmd":"NAVIGATE","route":"project:../../x"}"#.to_vec(),
            br#"{"cmd":"NAVIGATE"}"#.to_vec(),
            br#"{"cmd":"RUNTIME_REQUEST","method":"DELETE","path":"/api/v1/projects/X"}"#.to_vec(),
            vec![0xff, 0xfe, 0x00, 0x01, 0x7f],
            // 比 1 KiB 上限大得多：服务端读不完整条消息，直接断开。
            [
                br#"{"cmd":"SHOW","pad":""#.as_slice(),
                &[b'x'; 64 * 1024][..],
                &b"\"}"[..],
            ]
            .concat(),
        ];
        // 测试构建专用的退出命令：生产构建的管道不认它。
        if !cfg!(feature = "smoke") {
            payloads.push(br#"{"cmd":"SMOKE_QUIT"}"#.to_vec());
        }

        for payload in &payloads {
            let reply = raw_send(&data_dir, payload);
            let shown = String::from_utf8_lossy(&payload[..payload.len().min(80)]).into_owned();
            assert_ne!(reply, b"ok", "accepted: {shown}");
            // 服务线程先 deliver 再回复（或断开），读到回复时 deliver 必然已经发生过。
            assert!(
                delivered.try_recv().is_err(),
                "delivered a command for: {shown}"
            );
        }

        // 阳性对照：乱发一通之后，固定枚举里的命令照样送达，且原样送达。
        assert_eq!(raw_send(&data_dir, br#"{"cmd":"WAKE"}"#), b"ok");
        assert_eq!(delivered.try_recv().ok(), Some(Command::Wake));
        assert_eq!(
            raw_send(&data_dir, br#"{"cmd":"NAVIGATE","route":"settings"}"#),
            b"ok"
        );
        assert_eq!(
            delivered.try_recv().ok(),
            Some(Command::Navigate {
                route: Route::Settings
            })
        );
        assert!(send(&data_dir, &Command::Show, Duration::from_secs(5)));
        assert_eq!(delivered.try_recv().ok(), Some(Command::Show));
    }
}
