//! Shared building blocks for the Herder daemon.
pub mod adapters {
    pub mod cdp;
    pub mod codex {
        pub mod connection;
        pub mod read;
    }
    pub mod opencode {
        pub mod connection;
        pub mod read;
    }
    pub mod chatgpt;
    pub mod zai;
}
pub mod application {
    pub mod list;
    pub mod models;
    pub mod recent;
    pub mod target;
    pub mod reconcile;
}
pub mod auth {
    pub mod identity;
}
pub mod config;
pub mod cli;
pub mod domain {
    pub mod adapter;
    pub mod address;
    pub mod resource;
}

pub mod error;
pub mod store;

pub mod ownership {
    pub mod claim;
    pub mod manifest;
    pub mod resource;
    pub mod release_runner;
}

pub mod mcp {
    pub mod catalog;
    pub mod transport;
}
