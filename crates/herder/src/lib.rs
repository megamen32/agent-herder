//! Shared building blocks for the Herder daemon.
pub mod adapters {
    pub mod codex {
        pub mod connection;
    }
    pub mod opencode {
        pub mod connection;
    }
    pub mod chatgpt;
    pub mod zai;
}
pub mod application {
    pub mod list;
    pub mod recent;
    pub mod reconcile;
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

pub mod ownership {
    pub mod manifest;
}

pub mod mcp {
    pub mod catalog;
    pub mod transport;
}
