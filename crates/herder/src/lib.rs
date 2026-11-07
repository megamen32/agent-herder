//! Shared building blocks for the Herder daemon.
pub mod application {
    pub mod recent;
}
pub mod auth {
    pub mod identity;
}
pub mod config;
pub mod domain {
    pub mod adapter;
    pub mod address;
    pub mod resource;
}

pub mod error;
pub mod store;

pub mod mcp {
    pub mod catalog;
}
