//! Bounded, read-only observation of one configured controller.
use super::CodexReader;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

impl CodexReader {
    pub fn inventory_thread_metadata(&mut self, id: &str, deadline: Instant) -> Option<Value> {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        let result = self
            .connection
            .request(
                "thread/read",
                json!({"threadId":id,"includeTurns":false}),
                remaining,
            )
            .ok()?;
        let t = result
            .get("thread")
            .filter(|t| t["id"].as_str() == Some(id))?;
        let status = t["status"]
            .as_str()
            .or_else(|| t["status"]["type"].as_str());
        let flags = t["status"]["activeFlags"]
            .as_array()
            .map(|flags| flags.iter().filter_map(Value::as_str).collect::<Vec<_>>());
        Some(
            json!({"id":id,"native_session_id":id,"status":status,"active_flags":flags,
            "cwd":t["cwd"].as_str(),"updated_at_ms":t["updatedAt"].as_i64().and_then(|s|s.checked_mul(1000)),
            "name":t["name"].as_str()}),
        )
    }

    pub fn inventory_runtime(&mut self, cwd: Option<&str>) -> (Vec<Value>, bool) {
        if self.instance.socket_path.is_none() || self.shared_connection_closed() {
            return (Vec::new(), false);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut seen = HashSet::new();
        let mut cursors = HashSet::new();
        let mut ids = Vec::new();
        let mut cursor = None::<String>;
        let mut complete = true;
        'pages: loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                complete = false;
                break;
            };
            let Ok(page) = self.connection.request(
                "thread/loaded/list",
                json!({"limit":100,"cursor":cursor}),
                remaining,
            ) else {
                complete = false;
                break;
            };
            let Some(data) = page["data"].as_array() else {
                complete = false;
                break;
            };
            for value in data {
                let Some(id) = value.as_str().filter(|s| !s.is_empty() && s.len() <= 512) else {
                    complete = false;
                    continue;
                };
                if seen.insert(id.to_owned()) {
                    if ids.len() == 512 {
                        complete = false;
                        break 'pages;
                    }
                    ids.push(id.to_owned());
                }
            }
            match page.get("nextCursor") {
                None | Some(Value::Null) => break,
                Some(Value::String(next))
                    if !next.is_empty() && next.len() <= 2048 && cursors.insert(next.clone()) =>
                {
                    cursor = Some(next.clone())
                }
                _ => {
                    complete = false;
                    break;
                }
            }
        }
        let mut rows = Vec::new();
        for id in ids {
            match self.inventory_thread_metadata(&id, deadline) {
                Some(t) if cwd.is_none() || t["cwd"].as_str() == cwd => rows.push(t),
                Some(_) => {}
                None => {
                    complete = false;
                    if cwd.is_none() {
                        rows.push(json!({"native_session_id":id,"status":null}));
                    }
                }
            }
        }
        (rows, complete)
    }
}
