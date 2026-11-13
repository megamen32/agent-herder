# BACKENDCONTRACT11 — corrected final image provenance receipt

State: corrected local immutable candidate verified against the exact replace-backend provenance gate. No production mutation or restart occurred in this task.

The first candidate universal-userio:backend-contract-b181618 (image 42c4d7c3...) was REJECTED before mutation. Its release commit was correct, but it was accidentally based on image 6679fdc..., so its two Python files remained at f3983cd bytes. Do not use that image/tag.

Corrected candidate:
- Tag: universal-userio:backend-contract-b181618-r2
- Image ID: sha256:3fcf68de0c32592b097d0d2d6636c553fdf1c62aaf44febb139aa32f2f29212b
- Exact base: currently installed image ID sha256:19be11dd7a20d41e3f80f6a5829be563d63d86c80f27ee13abf89bf69ad57fc2, pinned locally by universal-userio-base:sha256-19be11dd7a20d41e3f80f6a5829be563d63d86c80f27ee13abf89bf69ad57fc2.
- Published revision and OCI label: b181618c3030bfb19f4195f1f4e0ff53e5feed45.
- Embedded release identity: schema_version=1; commit=b181618c3030bfb19f4195f1f4e0ff53e5feed45; manifest_sha256=bfd202a8196ef7c765c9cc1bb99a3a4a80473b9efe534f647c9565fdca0fc103.
- Exact gate reproduction used the same 31 BACKEND_SOURCE_HASH_PATHS entries and backend_source_target mapping as container_release.py. With docker run --rm --network none, candidate release.commit matched the full pinned commit and candidate hashes equaled every published blob: 31/31. OCI revision label also matched.
- The derivative copies only .userio-release.json and the two published ZIPs; it contains no Python source changes beyond installed f3983cd base.
- Both 0.9.27 ZIPs: SHA256 e968104369ed507b14bcb708d7ca2a54c055a047e83d1e581cdde147724940cf.

Production was re-read after the build and remains backend container b57726c95aa99039f90a6040435a4d743b5c5a4f0a3a2d503e5628cf5a393c01, running on image 19be11dd.... No deploy/restart was performed. Lead may use the corrected tag only after its normal lease and immediate live-ID/image preflight. This receipt makes no installation or consumer acceptance claim.

