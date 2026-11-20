//! Bind a recovery route to the exact credential selected by a v2 OpenCode workspace.

use std::path::Path;

use reqwest::{Method, StatusCode, Url};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::control::OpenCodeSessionControl;
use crate::domain::recovery::RecoveryCredential;

const OPENAI_COMPATIBLE: &str = "@opencode/ai/providers/openai-compatible";
const OPENAI_RESPONSES: &str = "@opencode/ai/providers/openai-compatible/responses";

impl OpenCodeSessionControl {
    pub async fn recovery_credential(
        &self,
        provider: &str,
        model: &str,
        cwd: &str,
    ) -> Option<RecoveryCredential> {
        if provider.is_empty()
            || provider.len() > 256
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            || model.is_empty()
            || !Path::new(cwd).is_absolute()
        {
            return None;
        }
        let query =
            reqwest::Url::parse_with_params("http://localhost", [("location[directory]", cwd)])
                .ok()?;
        let query = query.query()?;
        let models_path = format!("/api/model?{query}");
        // The catalog contains effective per-model provider settings for
        // this workspace, including any inherited credentials.
        let model_catalog = self.read_recovery_config(&models_path, cwd).await?;
        let qualified = format!("{provider}/{model}");
        let mut candidates = model_catalog.as_array()?.iter().filter(|row| {
            row["providerID"] == provider && (row["id"] == model || row["id"] == qualified)
        });
        let selected = candidates.next()?;
        if candidates.next().is_some()
            || selected["modelID"] != model
            || selected["enabled"] != true
            || !matches!(
                selected["package"].as_str(),
                Some(OPENAI_COMPATIBLE | OPENAI_RESPONSES)
            )
            || !empty_override(&selected["body"])
            || !variants_use_route(&selected["variants"])
        {
            return None;
        }
        credential(selected)
    }

    async fn read_recovery_config(&self, path: &str, cwd: &str) -> Option<Value> {
        let response = self
            .connection()
            .request("herder-opencode-recovery-config", Method::GET, path)
            .ok()?
            .send()
            .await
            .ok()?;
        if response.status() != StatusCode::OK {
            return None;
        }
        let result: Value = response.json().await.ok()?;
        if result["location"]["directory"] != cwd {
            return None;
        }
        result.get("data").cloned()
    }
}

fn credential(route: &Value) -> Option<RecoveryCredential> {
    let settings = route["settings"].as_object()?;
    if settings.keys().any(|key| {
        !matches!(
            key.as_str(),
            "apiKey" | "baseURL" | "provider" | "timeout" | "headerTimeout" | "chunkTimeout"
        )
    }) {
        return None;
    }
    let endpoint = settings.get("baseURL")?.as_str()?;
    let url = Url::parse(endpoint).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut bearer = None;
    if !route["headers"].is_null() {
        for (name, value) in route["headers"].as_object()? {
            if !name.eq_ignore_ascii_case("authorization") || bearer.is_some() {
                return None;
            }
            bearer = Some(value.as_str()?.strip_prefix("Bearer ")?);
        }
    }
    let key = match (settings.get("apiKey"), bearer) {
        (None, Some(bearer)) => bearer,
        (Some(value), header) if header.is_none_or(|header| value == header) => value.as_str()?,
        _ => return None,
    };
    if key.len() < 20 || key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return None;
    }
    let sha256 = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(RecoveryCredential {
        endpoint: endpoint.to_owned(),
        sha256,
    })
}

fn empty_override(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some_and(|fields| fields.is_empty())
}

fn variants_use_route(variants: &Value) -> bool {
    variants.is_null()
        || variants.as_array().is_some_and(|rows| {
            rows.iter().all(|variant| {
                variant.as_object().is_some_and(|fields| {
                    fields.iter().all(|(key, value)| match key.as_str() {
                        "id" | "name" => value.is_string(),
                        "body" | "headers" => empty_override(value),
                        "settings" => {
                            value.is_null()
                                || value.as_object().is_some_and(|settings| {
                                    settings.iter().all(|(name, value)| {
                                        name == "reasoningEffort"
                                            && matches!(
                                                value.as_str(),
                                                Some(
                                                    "none"
                                                        | "minimal"
                                                        | "low"
                                                        | "medium"
                                                        | "high"
                                                        | "xhigh"
                                                )
                                            )
                                    })
                                })
                        }
                        _ => false,
                    })
                })
            })
        })
}
