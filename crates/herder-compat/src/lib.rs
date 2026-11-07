//! Removable legacy MCP edge for unchanged clients.
//!
//! This crate is intentionally downstream of `herder`; the native server and
//! its 14-tool catalog do not depend on compatibility code.

pub mod contract;
pub mod error;
mod edge;

pub use edge::LegacyEdge;

pub const LEGACY_PROTOCOL: &str = "2025-06-18";
pub const NATIVE_PROTOCOL: &str = "2026-07-28";
pub const LEGACY_TOOLS: [&str; 3] = ["compat_task", "compat_skill", "compat_changes"];
