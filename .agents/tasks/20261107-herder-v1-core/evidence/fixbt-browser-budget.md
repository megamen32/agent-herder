# Browser AHAP deadline correction

Commit508500ed, integrated/published5ea28f51. Existing MacMiniChromeTransport allows30seconds per call, but owner AHAP round trip was20seconds. Browser init composes pinned-account verification and passive inventory reads. Browser overall budget is now120seconds; CLI kinds remain20seconds. Expiry continues to poison the runner; mutation errors remain UNKNOWN and are never replayed.

CI measured original bundled init at22.093seconds and ERROR, initialize0.079seconds PASS (CI/evidence/chatgpt-a836-ahap-timing.json). This proves the old core budget masked the eventual adapter error. Raising the budget is not a native PASS. The separate actual fresh-account/cache/order defect is fixed in wrapper88f81409 and CI driver e4c5edb6, both integrated5ea28f51.

cargo build --locked --manifest-path crates/herder/Cargo.toml --bin herder_native_stdio PASS. Existing transport deadline/no-replay tests retained; latest candidate NEG must be run on packaged bytes. No new timing-only unit test or native effect was needed for the reversible timeout adjustment. Driver tests107/3suites and wrapper30/30 are separate source evidence.
