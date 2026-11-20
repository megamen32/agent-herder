use super::{
    BrowserAttachment, BrowserSubmitError, Config, Provider, sessions::Sessions,
    validate_attachments,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    path::Path,
};

const MAX_FRAME: usize = 4 * 1024 * 1024;
const METHODS: [&str; 8] = [
    "init",
    "listSessions",
    "getSession",
    "getSessionMessages",
    "createSession",
    "sendMessage",
    "cancelTurn",
    "getMessageAttachment",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RpcError {
    Invalid,
    Protocol,
    Unsupported,
    Identity,
    Missing,
    Unavailable,
    TooLarge,
    Parse,
}

impl RpcError {
    fn frame(self, id: &Value) -> Value {
        let (code, message) = match self {
            Self::Parse => (-32700, "invalid JSON"),
            Self::Protocol => (-32600, "invalid request or adapter initialization sequence"),
            Self::Unsupported => (-32601, "method is not supported by this browser adapter"),
            Self::Invalid => (-32602, "invalid browser adapter parameters"),
            Self::Identity => (-32000, "provider, account or target identity mismatch"),
            Self::Missing => (-32000, "browser session not found"),
            Self::Unavailable => (-32000, "scoped browser operation unavailable"),
            Self::TooLarge => (-32001, "AHAP frame exceeds 4 MiB"),
        };
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
    }
}

fn capabilities(provider: Provider) -> Value {
    json!({"harness":provider.name(),"name":match provider { Provider::ChatGpt => "ChatGPT", Provider::Zai => "Z.ai" },
        "capabilities":{"nativeProtocol":"direct-cdp","methods":METHODS,"deliveryModes":["queue"],
        "controlCapabilities":{"cancelTurn":true,"permissionReply":false,"steer":false},
        "browserFeatures":{"projects":false,"modelSwitch":false,"attachments":true,
            "attachmentCaptionRequired":provider.requires_attachment_caption(),
            "maxAttachments":crate::domain::attachment::MAX_ATTACHMENTS,"maxAttachmentBytes":super::MAX_ATTACHMENT_BYTES}}})
}

fn limit(value: Option<&Value>, default: usize, cap: usize) -> Result<usize, RpcError> {
    match value {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0)
            .map(|n| n.min(cap as u64) as usize)
            .ok_or(RpcError::Invalid),
    }
}

fn session_id(params: &Value) -> Result<&str, RpcError> {
    params["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .ok_or(RpcError::Invalid)
}

fn native_id<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params[key]
        .as_str()
        .filter(|s| super::valid_label(s) && s.trim() == *s)
        .ok_or(RpcError::Invalid)
}

fn send_options(
    provider: Provider,
    options: &Value,
) -> Result<(&str, &str, Vec<BrowserAttachment>), RpcError> {
    let options = options.as_object().ok_or(RpcError::Invalid)?;
    if options.keys().any(|key| {
        !matches!(
            key.as_str(),
            "message" | "attachments" | "inputId" | "queue" | "activeTurnOnly" | "steer" | "start"
        )
    }) || ["activeTurnOnly", "start", "steer"].iter().any(|key| {
        options
            .get(*key)
            .is_some_and(|v| v.as_bool() != Some(false))
    }) || options
        .get("queue")
        .is_some_and(|v| v.as_bool() != Some(true))
    {
        return Err(RpcError::Invalid);
    }
    let files = options
        .get("attachments")
        .map(Vec::<BrowserAttachment>::deserialize)
        .transpose()
        .map_err(|_| RpcError::Invalid)?
        .unwrap_or_default();
    validate_attachments(&files).map_err(|_| RpcError::Invalid)?;
    let text = options
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| {
            s.len() <= 8_000
                && match provider {
                    Provider::Zai => crate::domain::attachment::has_browser_caption(s),
                    Provider::ChatGpt => !files.is_empty() || !s.trim().is_empty(),
                }
        })
        .ok_or(RpcError::Invalid)?;
    let input = options
        .get("inputId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or(RpcError::Invalid)?;
    Ok((text, input, files))
}

struct Runner {
    config: Config,
    initialized: bool,
    sessions: Option<Sessions>,
}

impl Runner {
    async fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, RpcError> {
        let config = &self.config;
        if method == "initialize" {
            if self.initialized
                || params["ahapVersion"] != "0.1"
                || params["harness"] != config.provider.name()
            {
                return Err(RpcError::Protocol);
            }
            self.initialized = true;
            return Ok(capabilities(config.provider));
        }
        if !self.initialized {
            return Err(RpcError::Protocol);
        }
        if method == "shutdown" {
            return Ok(Value::Null);
        }
        if !METHODS.contains(&method) {
            return Err(RpcError::Unsupported);
        }
        if method == "init" {
            if self.sessions.is_some() {
                return Err(RpcError::Protocol);
            }
            self.sessions = Some(Sessions::open(config).await?);
            return Ok(Value::Null);
        }
        let sessions = self.sessions.as_mut().ok_or(RpcError::Protocol)?;
        match method {
            "listSessions" => {
                let options = params.get("options");
                if options.is_some_and(|v| !v.is_object()) {
                    return Err(RpcError::Invalid);
                }
                if let Some(cwd) = options.and_then(|o| o.get("cwd")) {
                    let path = Path::new(cwd.as_str().ok_or(RpcError::Invalid)?);
                    if !path.is_absolute() {
                        return Err(RpcError::Invalid);
                    }
                    if path != config.cwd {
                        return Ok(json!([]));
                    }
                }
                let limit = limit(options.and_then(|v| v.get("limit")), 100, 100)?;
                sessions.list(config, limit).await
            }
            "getSession" => match sessions.get(config, session_id(params)?).await {
                Err(RpcError::Missing) => Ok(Value::Null),
                result => result,
            },
            "getSessionMessages" => {
                if params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n > 200)
                {
                    return Err(RpcError::Invalid);
                }
                let size = limit(params.get("limit"), 200, 200)?;
                sessions.messages(config, session_id(params)?, size).await
            }
            "createSession" => {
                let options = &params["options"];
                let title = options["name"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or(RpcError::Invalid)?;
                if !options["cwd"]
                    .as_str()
                    .is_some_and(|s| Path::new(s).is_absolute())
                {
                    return Err(RpcError::Invalid);
                }
                sessions.create(config, title).await
            }
            "cancelTurn" => {
                let id = session_id(params)?;
                let input = native_id(params, "inputMessageId")?;
                let cancelled = sessions.cancel(config, id, input).await?;
                Ok(json!({"sessionId":id,"inputMessageId":input,"cancelled":cancelled}))
            }
            "getMessageAttachment" => {
                let id = session_id(params)?;
                let message = native_id(params, "messageId")?;
                let file = native_id(params, "attachmentId")?;
                let data = sessions.attachment(config, id, message, file).await?;
                data.validate().map_err(|_| RpcError::Unavailable)?;
                Ok(
                    json!({"sessionId":id,"messageId":message,"attachmentId":file,
                    "name":data.name,"mime_type":data.mime_type,"data_base64":data.data_base64}),
                )
            }
            "sendMessage" => {
                let id = session_id(params)?;
                let (text, key, files) = send_options(config.provider, &params["options"])?;
                let mut result =
                    json!({"inputId":key,"sessionId":id,"harness":config.provider.name()});
                let admission = match sessions.send(config, id, text, &files).await {
                    Ok(native) => {
                        result["nativeInputMessageId"] = Value::String(native);
                        result["ok"] = Value::Bool(true);
                        result["admitted"] = Value::Bool(true);
                        "accepted"
                    }
                    Err(BrowserSubmitError::BeforeSend) => {
                        result["ok"] = Value::Bool(false);
                        result["notSubmitted"] = Value::Bool(true);
                        "not_submitted"
                    }
                    Err(BrowserSubmitError::Unknown) => {
                        result["ok"] = Value::Bool(false);
                        result["admissionUnknown"] = Value::Bool(true);
                        result["retryable"] = Value::Bool(false);
                        "unknown"
                    }
                };
                result["admission"] = json!(admission);
                Ok(result)
            }
            _ => Err(RpcError::Unsupported),
        }
    }
}

fn request(value: &Value) -> Result<(&Value, &str, &Value), RpcError> {
    let id = &value["id"];
    if value["jsonrpc"] != "2.0"
        || !(id.is_number() || id.as_str().is_some_and(|s| s.len() <= 512))
        || value.get("params").is_some_and(|p| !p.is_object())
    {
        return Err(RpcError::Protocol);
    }
    Ok((
        id,
        value["method"].as_str().ok_or(RpcError::Protocol)?,
        &value["params"],
    ))
}

fn write_response(output: &mut impl Write, id: &Value, response: Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    if bytes.len() >= MAX_FRAME {
        bytes = serde_json::to_vec(&RpcError::TooLarge.frame(id))?;
    }
    bytes.push(b'\n');
    output.write_all(&bytes)?;
    output.flush()
}

pub(super) async fn serve(
    config: Config,
    mut input: impl BufRead,
    mut output: impl Write,
) -> io::Result<()> {
    let mut runner = Runner {
        config,
        initialized: false,
        sessions: None,
    };
    let mut line = Vec::new();
    loop {
        line.clear();
        let size = input
            .by_ref()
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut line)?;
        if size == 0 {
            break;
        }
        if size > MAX_FRAME || !line.ends_with(b"\n") {
            if !line.ends_with(b"\n") {
                input.skip_until(b'\n')?;
            }
            write_response(
                &mut output,
                &Value::Null,
                RpcError::TooLarge.frame(&Value::Null),
            )?;
            continue;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let parsed: Value = match serde_json::from_slice(&line) {
            Ok(req) => req,
            Err(_) => {
                write_response(
                    &mut output,
                    &Value::Null,
                    RpcError::Parse.frame(&Value::Null),
                )?;
                continue;
            }
        };
        let (id, method, params) = match request(&parsed) {
            Ok(request) => request,
            Err(e) => {
                write_response(&mut output, &Value::Null, e.frame(&Value::Null))?;
                continue;
            }
        };
        let result = runner.dispatch(method, params).await;
        let shutdown = method == "shutdown" && result.is_ok();
        let response = match result {
            Ok(value) => {
                let mut frame = json!({"jsonrpc":"2.0","id":id});
                frame["result"] = value;
                frame
            }
            Err(error) => error.frame(id),
        };
        write_response(&mut output, id, response)?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::cdp::CdpTargetIdentity;

    fn config(provider: Provider) -> Config {
        Config {
            provider,
            endpoint: String::new(),
            scope: "0".repeat(64),
            origin_port: None,
            identity: CdpTargetIdentity {
                node_id: "n".into(),
                instance_id: "i".into(),
                browser_context_id: "c".into(),
                target_id: "t".into(),
            },
            home: "/unused".into(),
            cwd: "/unused".into(),
        }
    }

    #[tokio::test]
    async fn bounded_frames_resynchronize_without_opening_a_browser() {
        for provider in [Provider::ChatGpt, Provider::Zai] {
            let mut input = vec![b'x'; MAX_FRAME + 27];
            input.push(b'\n');
            for (id, method, params) in [
                (1, "sendMessage", json!({})),
                (
                    2,
                    "initialize",
                    json!({"harness":provider.name(),"ahapVersion":"0.1"}),
                ),
                (3, "getSession", json!({"id":"unknown"})),
                (4, "interrupt", json!({})),
                (5, "shutdown", json!({})),
            ] {
                serde_json::to_writer(
                    &mut input,
                    &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                )
                .unwrap();
                input.push(b'\n');
            }
            let mut output = Vec::new();
            serve(config(provider), input.as_slice(), &mut output)
                .await
                .unwrap();
            let frames: Vec<Value> = serde_json::Deserializer::from_slice(&output)
                .into_iter()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(frames.len(), 6);
            assert_eq!(frames[0]["error"]["code"], -32001);
            assert_eq!(frames[1]["error"]["code"], -32600);
            assert_eq!(frames[2]["result"]["harness"], provider.name());
            assert_eq!(frames[3]["error"]["code"], -32600);
            assert_eq!(frames[4]["error"]["code"], -32601);
            assert_eq!(frames[5]["result"], Value::Null);
        }
    }

    #[test]
    fn refuses_to_reinterpret_current_turn_or_attached_content_as_a_plain_send() {
        for incompatible in [
            json!({"steer":true}),
            json!({"activeTurnOnly":true}),
            json!({"start":true}),
            json!({"queue":false}),
            json!({"attachments":["file"]}),
            json!({"expectedTurnId":"stale"}),
        ] {
            let mut options = json!({"message":"hello","inputId":"key"});
            options
                .as_object_mut()
                .unwrap()
                .extend(incompatible.as_object().unwrap().clone());
            assert_eq!(
                send_options(Provider::ChatGpt, &options),
                Err(RpcError::Invalid)
            );
        }
        assert_eq!(
            send_options(
                Provider::ChatGpt,
                &json!({"inputId":"key","message":"  exact text  ","queue":true})
            ),
            Ok(("  exact text  ", "key", vec![]))
        );
    }

    #[test]
    fn attachment_only_input_respects_the_native_composer() {
        let value = json!({"message":"","queue":true,"inputId":"file-only",
            "attachments":[{"name":"data.bin","mime_type":"application/octet-stream","data_base64":"AP8="}]});
        assert_eq!(send_options(Provider::Zai, &value), Err(RpcError::Invalid));
        let (text, key, files) = send_options(Provider::ChatGpt, &value).unwrap();
        assert_eq!((text, key), ("", "file-only"));
        assert_eq!(files[0].data_base64, "AP8=");
        assert_eq!(
            send_options(Provider::ChatGpt, &json!({"message":"","inputId":"empty"})),
            Err(RpcError::Invalid)
        );
    }
}
