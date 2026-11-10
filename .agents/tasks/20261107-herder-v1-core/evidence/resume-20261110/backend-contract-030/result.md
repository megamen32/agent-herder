# UserIO package-only 0.9.30 runtime delivery

## Outcome

Installed the package-only derivative for published UserIO source commit `480146dfba5847c213fb98af00f316ece6aac6c7`. The source checkout was `/home/roomhacker/herder-artifacts/worktrees/zai-source13-userio`, at the requested exact source state and clean. Both package aliases are SHA256 `c21b8909771650f4fa0f00cb86078303d962d864d885071fd0fecdccce466e16`, version `0.9.30`, manifest v3.

The candidate reused the confirmed base image `sha256:cb56ddf6afad67ed4fdb57c03f280770ab55708e571b5178f5ced1e4aa145769`; its only layer changes were release metadata and the two ZIPs. Local Docker builder produced image `sha256:dbf36a79f5be11b4915c4f6d968d239fb50482aa65591731d97763a5a5a9f201`.

## Runtime acceptance

The supported `scripts/container_release.py replace-backend` completed once under project release lease fence 53 and compare-and-swap against then-current container `bd5d3963038815c50266c223a55c243538e61d8e8118c2ab99fb5310f84ca9d3`.

- Running backend container: `bd6eca19fcb90aa977c360f2221f8654f7e9fa4049a883d1e70843a893ac5e70`, image digest above, source revision `480146dfba5847c213fb98af00f316ece6aac6c7`, restart count 0.
- Independent hash readback from the running container: all 31 canonical backend source paths match the published source; both installed ZIPs match the expected SHA; release metadata matches commit and manifest digest. See `installed-source-hashes.json`.
- Candidate image source hashes independently match those installed: `candidate-source-hashes.json`.
- Supervisor health command passed after install and again on independent readback.
- The canonical replacement receipt confirms the 19 account identities are unchanged and frontend/voice configuration is unchanged. Independent readback matched all 19 current account identities to the protected baseline.
- Frontend `5a1f165c…` and voice `7345d430…` remain running with restart count 0 and the same container IDs observed before install.
- Public GET readback for both ZIP URLs returned HTTP 200, expected SHA256, version `0.9.30`, manifest v3. See `public-zip-readback.json`.
- Protected rollback/baseline receipt: `/var/backups/universal-userio/20261110-backend-extension-030-01a1c551`.

Lease fence 53 was released after installation and verification.

## Scope and evidence boundary

No full backend rebuild, main checkout mutation, customer conversation, provider turn/send, Chrome/Mac action, notification, or secret/config dump was performed. Source and package provenance, candidate image, installed runtime, and public ZIP readback are separately recorded. Parent owns Mac/browser/consumer verification; that is not included in this package/runtime result.
