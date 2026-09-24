//! A deliberately tiny HTTP/1.1 client: one POST to 127.0.0.1, one response.
//!
//! The body is framed by `Content-Length` or chunked encoding, never by EOF. The daemon's
//! MCP transport answers `Connection: keep-alive` even when asked to close, so reading to
//! EOF would stall every request until the server's idle timeout (measured: over a minute).

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

/// Same limits the old bridge had through undici's defaults.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum Error {
    /// Nothing accepted the connection: the request provably never reached a daemon.
    Refused,
    /// Failed before a complete response head arrived (undici: "fetch failed").
    Request,
    /// The head arrived but the body did not (undici: "terminated").
    Body,
}

pub fn post(port: u16, path: &str, token: &str, body: &str) -> Result<Response, Error> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| {
        if error.kind() == io::ErrorKind::ConnectionRefused {
            Error::Refused
        } else {
            Error::Request
        }
    })?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|_| Error::Request)?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|_| Error::Request)?;
    let _ = stream.set_nodelay(true);

    let host = if port == 80 {
        "127.0.0.1".to_owned()
    } else {
        format!("127.0.0.1:{port}")
    };
    let head = format!(
        "POST {path} HTTP/1.1\r\n\
         host: {host}\r\n\
         authorization: Bearer {token}\r\n\
         accept: application/json, text/event-stream\r\n\
         content-type: application/json\r\n\
         content-length: {}\r\n\
         connection: close\r\n\r\n",
        body.len()
    );
    let mut writer = &stream;
    writer
        .write_all(head.as_bytes())
        .map_err(|_| Error::Request)?;
    writer
        .write_all(body.as_bytes())
        .map_err(|_| Error::Request)?;
    writer.flush().map_err(|_| Error::Request)?;

    let mut reader = BufReader::new(&stream);
    read_response(&mut reader)
}

pub fn read_response(reader: &mut impl BufRead) -> Result<Response, Error> {
    loop {
        let (status, headers) = read_head(reader)?;
        // Interim responses (100 Continue) carry no body; the real one follows.
        if (100..200).contains(&status) {
            continue;
        }
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        let content_type = header("content-type").map(str::to_owned);
        // The caller drops these without reading them, exactly like the old bridge.
        if status == 202 || status == 204 || status == 304 {
            return Ok(Response {
                status,
                content_type,
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
            let length: usize = length.trim().parse().map_err(|_| Error::Body)?;
            if length > MAX_BODY_BYTES {
                return Err(Error::Body);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).map_err(|_| Error::Body)?;
            body
        } else {
            // No framing at all: only then is the end of the connection the end of the body.
            let mut body = Vec::new();
            reader
                .take(MAX_BODY_BYTES as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|_| Error::Body)?;
            if body.len() > MAX_BODY_BYTES {
                return Err(Error::Body);
            }
            body
        };
        return Ok(Response {
            status,
            content_type,
            body,
        });
    }
}

fn read_line(
    reader: &mut impl BufRead,
    budget: &mut usize,
    error: fn() -> Error,
) -> Result<String, Error> {
    let mut line = Vec::new();
    let read = reader
        .take(*budget as u64)
        .read_until(b'\n', &mut line)
        .map_err(|_| error())?;
    if read == 0 || line.last() != Some(&b'\n') {
        return Err(error());
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
    let status_line = read_line(reader, &mut budget, || Error::Request)?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let status = parts.next().and_then(|code| code.parse::<u16>().ok());
    let Some(status) = status.filter(|_| version.starts_with("HTTP/1.")) else {
        return Err(Error::Request);
    };
    let mut headers = Vec::new();
    loop {
        let line = read_line(reader, &mut budget, || Error::Request)?;
        if line.is_empty() {
            return Ok((status, headers));
        }
        let (name, value) = line.split_once(':').ok_or(Error::Request)?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
}

fn read_chunked(reader: &mut impl BufRead) -> Result<Vec<u8>, Error> {
    let mut body = Vec::new();
    loop {
        let mut budget = MAX_HEAD_BYTES;
        let size_line = read_line(reader, &mut budget, || Error::Body)?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| Error::Body)?;
        if size == 0 {
            // Trailers, then the blank line that ends the message.
            while !read_line(reader, &mut budget, || Error::Body)?.is_empty() {}
            return Ok(body);
        }
        if body.len() + size > MAX_BODY_BYTES {
            return Err(Error::Body);
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|_| Error::Body)?;
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).map_err(|_| Error::Body)?;
        if crlf != *b"\r\n" {
            return Err(Error::Body);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &[u8]) -> Result<Response, Error> {
        read_response(&mut BufReader::new(raw))
    }

    #[test]
    fn content_length_body_stops_at_the_length_not_at_eof() {
        // Trailing bytes stand in for a connection the server keeps open.
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 5\r\n\r\nhelloEXTRA";
        let response = parse(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.content_type.as_deref(), Some("text/event-stream"));
        assert_eq!(response.body, b"hello");
    }

    #[test]
    fn chunked_body_with_extensions_and_trailers() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;x=y\r\nWiki\r\n5\r\npedia\r\n0\r\nX-T: 1\r\n\r\nNEXT";
        assert_eq!(parse(raw).unwrap().body, b"Wikipedia");
    }

    #[test]
    fn accepted_notification_is_not_read_further() {
        // What the daemon really sends for a notification.
        let raw = b"HTTP/1.1 202 Accepted\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
        let response = parse(raw).unwrap();
        assert_eq!(response.status, 202);
        assert!(response.body.is_empty());
    }

    #[test]
    fn interim_continue_is_skipped() {
        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
        assert_eq!(parse(raw).unwrap().body, b"{}");
    }

    #[test]
    fn unframed_body_reads_to_eof() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"a\":1}";
        assert_eq!(parse(raw).unwrap().body, b"{\"a\":1}");
    }

    #[test]
    fn failures_are_classified_by_how_far_the_response_got() {
        assert!(matches!(parse(b""), Err(Error::Request)));
        assert!(matches!(
            parse(b"HTTP/1.1 200 OK\r\ncontent-le"),
            Err(Error::Request)
        ));
        assert!(matches!(parse(b"garbage\r\n\r\n"), Err(Error::Request)));
        assert!(matches!(
            parse(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nshort"),
            Err(Error::Body)
        ));
        assert!(matches!(
            parse(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n"),
            Err(Error::Body)
        ));
    }

    #[test]
    fn refused_connection_is_distinguished_from_other_failures() {
        // Bind then drop to get a port that is very likely closed.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(matches!(post(port, "/mcp", "t", "{}"), Err(Error::Refused)));
    }
}
