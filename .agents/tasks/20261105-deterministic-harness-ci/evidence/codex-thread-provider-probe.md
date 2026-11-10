# Codex provider selection probe

2026-11-07. Real Codex app-server 0.167.0 inside the existing private network and disposable HOME launcher; only the local deterministic fixture was reachable. User config defaulted to fixture_default; thread/start explicitly selected fixture_project and supplied its config. The returned thread confirmed fixture_project, but the first turn/start was refused with native error modelProviderMismatch (modelProvider fixture_project, currentModelProvider fixture_default). No repeat was attempted. No production credentials, provider configuration or sessions were used.

Separately config/read with a trusted disposable project showed project model applied, while project model_provider and model_providers were filtered from the effective layer; effective provider stayed fixture_default.

A second isolated experiment set both thread/start modelProvider and its config.model_provider to fixture_project. The native turn/start still refused modelProviderMismatch against fixture_default. A new disposable thread was used; no prior send was retried.

A third isolated probe supplied config.profile=fixture at thread/start with a real fixture.config.toml. Native Codex rejected thread/start: legacy profile config is no longer supported; use --profile at process startup. No turn or model request was sent.

A fourth isolated experiment tried `codex -p fixture app-server` using fixture.config.toml. The CLI refused startup: --profile only applies to runtime commands, codex mcp, and codex migrate-nfs-db; app-server is not included. No thread or turn was created. The existing isolated stand succeeds with a separate CODEX_HOME config, not with this profile flag.
