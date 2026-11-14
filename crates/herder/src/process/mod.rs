//! Herder-owned supervised executions. Authorization belongs to the application.
//! This module never acquires resource ownership or delivers agent messages.
#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
use darwin as platform;
#[cfg(target_os = "linux")]
use linux as platform;
mod storage;
pub mod remote;
mod remote_controller;
mod remote_endpoint;
mod remote_deadline;
mod types;
mod worker;

pub use platform::{capture_process, observe_process};
pub use storage::{ExecutionStore, execution_ref_for};
pub use remote_controller::{remote_terminal_observed_at,remote_source_evidence};
pub use remote_endpoint::remote_endpoint;
pub use remote_deadline::run_deadline_watchdog;
pub use types::*;
pub use worker::{ExecutionHooks, NoopHooks, run_worker, run_worker_with_hooks};

pub fn unix_millis() -> std::io::Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis().min(u64::MAX as u128) as u64)
        .map_err(|_| std::io::Error::other("system clock unavailable"))
}
