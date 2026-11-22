//! Native observations and bounded submission for existing-session recovery.

use super::{
    adapter::{Admission, ReadError, RequestKey, SendMode, SubmitError},
    address::{InstanceRef, SessionAddress},
};
use std::borrow::Cow;

/// Exact latest eligible failed or interrupted native turn and its input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryBoundary {
    pub turn_id: String,
    pub input_item_id: String,
    pub cwd: String,
    pub provider: String,
    pub model: Option<String>,
    pub started_at_ms: u64,
    pub failure: RecoveryFailure,
    /// Native parents, nearest first, verified against this turn's root.
    pub ancestors: Vec<RecoveryAncestor>,
}

impl RecoveryBoundary {
    /// Codex starts turns directly. Queued native recovery receipts identify the input.
    pub(crate) fn receipt_id(&self, harness: &str) -> &str {
        match harness {
            "codex" => &self.turn_id,
            _ => &self.input_item_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct RecoveryAncestor {
    pub address: SessionAddress,
    pub cwd: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryFailure {
    Interrupted,
    Quota,
    Throttled,
    Retryable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryRoute {
    pub provider: String,
    pub model: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SameRouteRetry {
    Hold,
    Ready,
    /// The saved route must follow its configured quota policy.
    UseQuotaPolicy,
}

/// Credential bound to a native provider endpoint. Only its digest crosses
/// the adapter boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct RecoveryCredential {
    pub endpoint: String,
    pub sha256: String,
}

pub struct RecoveryQuotaProof<'a> {
    pub credential: &'a RecoveryCredential,
    pub still_available: &'a (dyn Fn() -> bool + Sync),
}

pub struct RecoveryPermit<'a> {
    pub reserve: u8,
    pub quota_proof: Option<RecoveryQuotaProof<'a>>,
    pub still_allowed: &'a (dyn Fn() -> bool + Sync),
}

pub trait RecoveryControl: Send + Sync {
    fn harness(&self) -> &'static str;
    fn instance(&self) -> &InstanceRef;
    fn mode(&self) -> SendMode;
    /// Match the latest failed input against the ID stored by this adapter's delivery receipt.
    fn receipt_id<'a>(&self, boundary: &'a RecoveryBoundary) -> Cow<'a, str> {
        Cow::Borrowed(boundary.receipt_id(self.harness()))
    }
    fn read_boundary(&self, target: &SessionAddress)
    -> Result<Option<RecoveryBoundary>, ReadError>;
    fn quota(&self, provider: &str, cwd: &str, reserve: u8) -> Option<bool>;
    fn credential(&self, provider: &str, model: &str, cwd: &str) -> Option<RecoveryCredential>;
    /// Recheck a terminal throttle if the adapter needs more evidence than its boundary.
    fn same_route_retry(
        &self,
        _target: &SessionAddress,
        _boundary: &RecoveryBoundary,
    ) -> SameRouteRetry {
        SameRouteRetry::Ready
    }
    fn supports_alternate(
        &self,
        _target: &SessionAddress,
        _boundary: &RecoveryBoundary,
        _route: &RecoveryRoute,
    ) -> bool {
        false
    }

    /// Submit at most once. If admission is uncertain, the owner reconciles
    /// the same request key without calling submit again.
    fn submit(
        &self,
        target: &SessionAddress,
        boundary: &RecoveryBoundary,
        route: &RecoveryRoute,
        permit: RecoveryPermit<'_>,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError>;
}
