//! 一个尽量小的 HTTP/1.1 客户端：对 127.0.0.1 发一个请求，收一个响应（与 atm-mcp 桥同一套读法）。
//!
//! 响应体按 `Content-Length` 或 chunked 分帧，不靠连接关闭：服务即使被要求关闭也可能回 keep-alive，
//! 读到 EOF 会一直等到服务端空闲超时。整个往返受一个绝对期限约束：连接、每次写、每次读都只等期限剩下的部分。

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// 没有人接这个连接：请求肯定没到服务。
    Refused,
    /// 连接失败或请求没写完：服务手里没有完整的请求，不可能照它做了什么。
    Unsent,
    /// 请求写完了，响应没收全（写操作此时是否提交未知）。
    Response,
}

/// 与 libuv 一样连 127.0.0.1：Windows 收到 RST 后还会按 500 ms 重传两次 SYN 才报拒绝，
/// 关掉回环连接的 SYN 重传（SIO_TCP_INITIAL_RTO），探活一个已关的端口才不会白等两秒。
fn connect_loopback(port: u16, deadline: Instant) -> io::Result<TcpStream> {
    use socket2::{Domain, Protocol, Socket, Type};
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    #[cfg(windows)]
    disable_syn_retransmissions(&socket);
    socket.connect_timeout(&address.into(), left(deadline)?)?;
    Ok(socket.into())
}

fn left(deadline: Instant) -> io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline passed"));
    }
    Ok(remaining)
}

/// 每次读写都按期限重新设超时，慢慢挤字节的对端也拖不过期限。
struct Timed<'a> {
    stream: &'a TcpStream,
    deadline: Instant,
}

impl Read for Timed<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(left(self.deadline)?))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

impl Write for Timed<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(left(self.deadline)?))?;
        let mut stream = self.stream;
        stream.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut stream = self.stream;
        stream.flush()
    }
}

#[cfg(windows)]
fn disable_syn_retransmissions(socket: &socket2::Socket) {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawSocket;
    // mstcpip.h: SIO_TCP_INITIAL_RTO = _WSAIOW(IOC_VENDOR, 17).
    const SIO_TCP_INITIAL_RTO: u32 = 0x9800_0011;
    const TCP_INITIAL_RTO_UNSPECIFIED_RTT: u16 = 0xFFFF;
    const TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS: u8 = 0xFE;
    #[repr(C)]
    struct TcpInitialRtoParameters {
        rtt: u16,
        max_syn_retransmissions: u8,
    }
    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn WSAIoctl(
            socket: usize,
            code: u32,
            input: *const c_void,
            input_len: u32,
            output: *mut c_void,
            output_len: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
            completion: *const c_void,
        ) -> i32;
    }
    let parameters = TcpInitialRtoParameters {
        rtt: TCP_INITIAL_RTO_UNSPECIFIED_RTT,
        max_syn_retransmissions: TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS,
    };
    let mut returned = 0u32;
    // SAFETY: 有效的 socket、声明大小的输入缓冲、没有输出缓冲、同步调用（没有 OVERLAPPED）。
    // 失败只意味着走慢的默认路径。
    unsafe {
        WSAIoctl(
            socket.as_raw_socket() as usize,
            SIO_TCP_INITIAL_RTO,
            std::ptr::from_ref(&parameters).cast(),
            std::mem::size_of::<TcpInitialRtoParameters>() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
            std::ptr::null(),
        );
    }
}

/// 发一个请求。`body` 为 `None` 时不带请求体（GET）。令牌只进 `authorization` 头。
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<Response, Error> {
    let deadline = Instant::now() + timeout;
    let stream = connect_loopback(port, deadline).map_err(|error| {
        if error.kind() == io::ErrorKind::ConnectionRefused {
            Error::Refused
        } else {
            Error::Unsent
        }
    })?;
    let _ = stream.set_nodelay(true);
    let host = if port == 80 {
        "127.0.0.1".to_owned()
    } else {
        format!("127.0.0.1:{port}")
    };
    let framing = body.map_or_else(String::new, |b| {
        format!(
            "content-type: application/json\r\ncontent-length: {}\r\n",
            b.len()
        )
    });
    let head = format!(
        "{method} {path} HTTP/1.1\r\n\
         host: {host}\r\n\
         authorization: Bearer {token}\r\n\
         accept: application/json\r\n\
         {framing}\
         connection: close\r\n\r\n"
    );
    let mut writer = Timed {
        stream: &stream,
        deadline,
    };
    writer
        .write_all(head.as_bytes())
        .map_err(|_| Error::Unsent)?;
    if let Some(body) = body {
        writer
            .write_all(body.as_bytes())
            .map_err(|_| Error::Unsent)?;
    }
    writer.flush().map_err(|_| Error::Response)?;
    let mut reader = BufReader::new(Timed {
        stream: &stream,
        deadline,
    });
    read_response(&mut reader)
}

fn read_response(reader: &mut impl BufRead) -> Result<Response, Error> {
    loop {
        let (status, headers) = read_head(reader)?;
        if (100..200).contains(&status) {
            continue;
        }
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        if status == 204 || status == 304 {
            return Ok(Response {
                status,
                body: Vec::new(),
            });
        }
        let chunked = header("transfer-encoding").is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().eq_ignore_ascii_case("chunked"))
        });
        let body = if chunked {
            read_chunked(reader)?
        } else if let Some(length) = header("content-length") {
            let length: usize = length.trim().parse().map_err(|_| Error::Response)?;
            if length > MAX_BODY_BYTES {
                return Err(Error::Response);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).map_err(|_| Error::Response)?;
            body
        } else {
            let mut body = Vec::new();
            reader
                .take(MAX_BODY_BYTES as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|_| Error::Response)?;
            if body.len() > MAX_BODY_BYTES {
                return Err(Error::Response);
            }
            body
        };
        return Ok(Response { status, body });
    }
}

fn read_line(reader: &mut impl BufRead, budget: &mut usize) -> Result<String, Error> {
    let mut line = Vec::new();
    let read = reader
        .take(*budget as u64)
        .read_until(b'\n', &mut line)
        .map_err(|_| Error::Response)?;
    if read == 0 || line.last() != Some(&b'\n') {
        return Err(Error::Response);
    }
    *budget -= read;
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

type Head = (u16, Vec<(String, String)>);

fn read_head(reader: &mut impl BufRead) -> Result<Head, Error> {
    let mut budget = MAX_HEAD_BYTES;
    let status_line = read_line(reader, &mut budget)?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let status = parts.next().and_then(|code| code.parse::<u16>().ok());
    let Some(status) = status.filter(|_| version.starts_with("HTTP/1.")) else {
        return Err(Error::Response);
    };
    let mut headers = Vec::new();
    loop {
        let line = read_line(reader, &mut budget)?;
        if line.is_empty() {
            return Ok((status, headers));
        }
        let (name, value) = line.split_once(':').ok_or(Error::Response)?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
}

fn read_chunked(reader: &mut impl BufRead) -> Result<Vec<u8>, Error> {
    let mut body = Vec::new();
    loop {
        let mut budget = MAX_HEAD_BYTES;
        let size_line = read_line(reader, &mut budget)?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| Error::Response)?;
        if size == 0 {
            while !read_line(reader, &mut budget)?.is_empty() {}
            return Ok(body);
        }
        if body.len() + size > MAX_BODY_BYTES {
            return Err(Error::Response);
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|_| Error::Response)?;
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).map_err(|_| Error::Response)?;
        if &crlf != b"\r\n" {
            return Err(Error::Response);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Result<Response, Error> {
        read_response(&mut BufReader::new(raw.as_bytes()))
    }

    #[test]
    fn bodies_are_framed_by_length_or_chunks() {
        let r = parse("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}extra").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"{}"[..]));
        let r = parse(
            "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{\"\r\n3\r\na\"}\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!((r.status, r.body.as_slice()), (201, &b"{\"a\"}"[..]));
        assert_eq!(
            parse("HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nshort").unwrap_err(),
            Error::Response
        );
        assert_eq!(parse("garbage\r\n\r\n").unwrap_err(), Error::Response);
    }

    #[test]
    fn a_closed_port_is_refused_quickly() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let started = Instant::now();
        let error = request(port, "GET", "/", "t", None, Duration::from_millis(750)).unwrap_err();
        assert!(matches!(error, Error::Refused | Error::Unsent), "{error:?}");
        assert!(started.elapsed() < Duration::from_millis(1500));
    }
}
