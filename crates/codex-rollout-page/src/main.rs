//! A backward window over an existing Codex JSONL file, supplied as a read-only fd.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::fd::FromRawFd;
#[cfg(target_os = "wasi")]
use std::os::wasi::io::FromRawFd;

type Error = Box<dyn std::error::Error>;
const CHUNK: usize = 64 * 1024;

fn cursor(file: &mut (impl Read + Seek), scope: &str, before: u64) -> Result<String, Error> {
    let start = before.saturating_sub(1024);
    file.seek(SeekFrom::Start(start))?;
    let mut boundary = vec![0; (before - start) as usize];
    file.read_exact(&mut boundary)?;
    let hash = Sha256::new()
        .chain_update(scope)
        .chain_update(before.to_le_bytes())
        .chain_update(boundary)
        .finalize();
    let digest: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("rollout.{before}.{digest}"))
}

fn transcript_record(row: &Value) -> bool {
    if row["type"] != "response_item" {
        return false;
    }
    let p = &row["payload"];
    match p["type"].as_str() {
        Some("message") => matches!(p["role"].as_str(), Some("user" | "assistant" | "system")),
        Some(
            "function_call"
            | "custom_tool_call"
            | "mcp_tool_call"
            | "function_call_output"
            | "custom_tool_call_output",
        ) => true,
        _ => false,
    }
}

fn page(
    file: &mut (impl Read + Seek),
    session: &str,
    scope: &str,
    limit: usize,
    token: Option<&str>,
) -> Result<Value, Error> {
    if !(1..=100).contains(&limit) {
        return Err("invalid page size".into());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut header = Vec::new();
    let header_size = BufReader::new(&mut *file).read_until(b'\n', &mut header)? as u64;
    let meta: Value = serde_json::from_slice(&header)?;
    let payload = &meta["payload"];
    let id = payload.get("id").or_else(|| payload.get("session_id"));
    if meta["type"] != "session_meta"
        || id.and_then(Value::as_str) != Some(session)
        || payload
            .get("session_id")
            .is_some_and(|legacy| legacy != session)
    {
        return Err("rollout does not match the native session".into());
    }
    let size = file.seek(SeekFrom::End(0))?;
    let mut end = size;
    if let Some(token) = token {
        let before: u64 = token
            .split('.')
            .nth(1)
            .ok_or("invalid rollout cursor")?
            .parse()?;
        if before == 0 || before > size || cursor(file, scope, before)? != token {
            return Err("rollout cursor does not match this file or position".into());
        }
        end = before;
    }

    let mut chunk = [0; CHUNK];
    let mut line = Vec::new();
    let mut rows = Vec::with_capacity(limit);
    let mut oldest = 0;
    let mut at_eof = end == size;
    // Include the delimiter before the first data record, but skip the metadata.
    let first_delimiter = header_size.saturating_sub(1);
    while end > first_delimiter {
        let start = end.saturating_sub(CHUNK as u64).max(first_delimiter);
        let count = (end - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk[..count])?;
        for i in (0..count).rev() {
            if chunk[i] != b'\n' {
                line.push(chunk[i]);
                continue;
            }
            line.reverse();
            let content = line.strip_suffix(b"\r").unwrap_or(&line);
            if !content.iter().all(u8::is_ascii_whitespace) {
                match serde_json::from_slice::<Value>(content) {
                    Ok(row) if transcript_record(&row) => {
                        let offset = start + i as u64 + 1;
                        if rows.len() == limit {
                            return Ok(
                                json!({"rows":rows,"nextCursor":cursor(file, scope, oldest)?}),
                            );
                        }
                        oldest = offset;
                        rows.push(json!({"offset":offset,"line":std::str::from_utf8(&line)?}));
                    }
                    Ok(_) => (),
                    // NUL-only lines between Codex events occupy bytes but carry no event.
                    Err(_) if content.iter().all(|&byte| byte == 0) => (),
                    Err(err) if at_eof && err.is_eof() => (),
                    Err(_) => return Err("malformed Codex rollout record".into()),
                }
            }
            at_eof = false;
            line.clear();
        }
        end = start;
    }
    // The first line was already verified as session_meta.
    Ok(json!({"rows":rows,"nextCursor":null}))
}

fn main() -> Result<(), Error> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [session, scope, limit, rest @ ..] = args.as_slice() else {
        return Err("missing page arguments".into());
    };
    // fd 0 is the selected rollout, opened by the harness adapter. The Wasm
    // module has no preopened directories and cannot open a different file.
    let mut file = unsafe { File::from_raw_fd(0) };
    let result = page(
        &mut file,
        session,
        scope,
        limit.parse()?,
        rest.first().map(String::as_str),
    )?;
    serde_json::to_writer(std::io::stdout().lock(), &result)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn record(id: usize) -> String {
        json!({"type":"response_item","payload":{"type":"message","id":id.to_string(),"role":"assistant"}}).to_string()
    }

    #[test]
    fn older_pages_use_the_same_byte_boundary_after_an_append() {
        let mut lines = vec![json!({"type":"session_meta","payload":{"id":"s"}}).to_string()];
        lines.extend((0..205).map(record));
        let mut file = Cursor::new((lines.join("\n") + "\n").into_bytes());
        let mut token = None;
        for (count, first, last) in [(100, 204, 105), (100, 104, 5), (5, 4, 0)] {
            let result = page(&mut file, "s", "file-one", 100, token.as_deref()).unwrap();
            let ids: Vec<_> = result["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    let entry: Value = serde_json::from_str(row["line"].as_str().unwrap()).unwrap();
                    entry["payload"]["id"]
                        .as_str()
                        .unwrap()
                        .parse::<usize>()
                        .unwrap()
                })
                .collect();
            assert_eq!(ids.len(), count);
            assert_eq!(ids, (last..=first).rev().collect::<Vec<_>>());
            token = result["nextCursor"].as_str().map(str::to_owned);
            if first == 204 {
                file.get_mut()
                    .extend_from_slice((record(205) + "\n").as_bytes());
                assert!(page(&mut file, "s", "other-file", 100, token.as_deref()).is_err());
            }
        }
        assert!(token.is_none());
    }

    #[test]
    fn pages_across_a_nul_only_record_but_rejects_a_damaged_record() {
        let header = json!({"type":"session_meta","payload":{"id":"s"}});
        let padding = "\0".repeat(1313);
        let bytes = format!("{header}\n{}\n{padding}\r\n{}\n", record(1), record(2));
        let mut file = Cursor::new(bytes.into_bytes());
        let latest = page(&mut file, "s", "file", 1, None).unwrap();
        assert_eq!(latest["rows"][0]["line"], record(2));
        let cursor = latest["nextCursor"].as_str().unwrap();
        let older = page(&mut file, "s", "file", 1, Some(cursor)).unwrap();
        assert_eq!(older["rows"][0]["line"], record(1));
        assert!(older["nextCursor"].is_null());

        let damaged = format!("{header}\n{padding}{}\n", record(1));
        assert!(page(&mut Cursor::new(damaged.as_bytes()), "s", "file", 1, None).is_err());
    }

    #[test]
    fn reads_long_legacy_headers_and_ignores_an_unfinished_last_line() {
        let header = json!({"type":"session_meta","payload":{"session_id":"s","instructions":"x".repeat(1024*1024)}});
        let mut bytes = format!("{header}\r\n{}\r\n", record(1)).into_bytes();
        bytes.extend_from_slice(br#"{"type":"resp"#);
        let mut file = Cursor::new(bytes);
        let result = page(&mut file, "s", "file", 100, None).unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), 1);
        assert!(result["nextCursor"].is_null());
        assert!(page(&mut file, "different-session", "file", 100, None).is_err());
    }
}
