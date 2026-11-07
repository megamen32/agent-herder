use serde::{Deserialize, Serialize};

/// Safe wire diagnostic shared by the legacy translation boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct CompatDiagnostic {
    pub code: String,
    pub effect: Effect,
    pub retry: Retry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect { None, Confirmed, Unknown }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retry { SafeSameKey, ReadReceipt, Forbidden }

impl CompatDiagnostic {
    pub fn unknown(receipt_ref: Option<String>) -> Self {
        let retry = if receipt_ref.as_deref().is_some_and(|value| !value.is_empty()) {
            Retry::ReadReceipt
        } else {
            Retry::Forbidden
        };
        Self { code: "outcome_unknown".into(), effect: Effect::Unknown, retry, receipt_ref }
    }
}
