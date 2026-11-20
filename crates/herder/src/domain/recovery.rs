//! Native observations and bounded submission for existing-session recovery.

use super::{
    adapter::{Admission, ReadError, RequestKey, SendMode, SubmitError},
    address::{InstanceRef, SessionAddress},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryBoundary {
    pub turn_id: String,
    pub input_item_id: String,
    pub cwd: String,
    pub provider: String,
    pub model: Option<String>,
    pub started_at_ms: u64,
    pub failure: RecoveryFailure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryFailure {
    Interrupted,
    Quota,
    Retryable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryRoute {
    pub provider: String,
    pub model: Option<String>,
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
    fn read_boundary(&self, target: &SessionAddress)
    -> Result<Option<RecoveryBoundary>, ReadError>;
    fn quota(&self, provider: &str, cwd: &str, reserve: u8) -> Option<bool>;
    fn credential(&self, provider: &str, model: &str, cwd: &str) -> Option<RecoveryCredential>;

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
