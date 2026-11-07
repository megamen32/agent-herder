//! Shared building blocks for the Herder daemon.
pub mod adapters {
    pub mod cdp;
    pub mod codex {
        pub mod connection;
        pub mod control;
        pub mod create;
        pub mod read;
    }
    pub mod opencode {
        pub mod connection;
        pub mod control;
        pub mod create;
        pub mod read;
    }
    pub mod chatgpt;
    pub mod zai;
    pub mod zcode {
        pub mod connection;
        pub mod create;
        pub mod read;
    }
}
pub mod application {
    pub mod list;
    pub mod models;
    pub mod recent;
    pub mod resource;
    pub mod settings;
    pub mod target;
    pub mod target_gate;
    #[cfg(target_os = "linux")]
    pub mod scoped_stop;
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
    pub mod transcript;
}

pub mod error;
pub mod search;
pub mod store;

pub mod ownership {
    pub mod claim;
    pub mod manifest;
    pub mod resource;
    pub mod release_runner;
    pub mod release_receipt;
}

pub mod mcp {
    pub mod catalog;
    pub mod transport;
}
