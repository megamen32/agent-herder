# Z.ai list scope and snapshot delta

Verdict: SUPPORTED for source properties, not live provider acceptance. Reviewer Nietzsche, session 01a1b453-5507-7b81-ae21-6853827cef0e. Reviewed HEAD a3f95ac9 plus WIP with zai/mod.rs SHA256 9ca8393c78f7b767366b024cb1b99e99632888ec0dd1980b6bf730da767b2597. File was stable during review.

The exact list expression binds a specific list response to a proof fetched for its first chat ID, checks proof.id, hashes proof.user_id, compares expected scope, and returns the original list. Rust also rejects errors, missing scope_verified and scope mismatch. A preflight on A followed by a list from B is rejected. This relies on the observed provider endpoint returning a single account list, not a hypothetical mixed-account list.

Independent Node VM execution of the exact Rust expression with stub fetch and real SHA-256 passed seven scenarios: valid A; B-list/B-proof; B-list/wrong A-proof;403 proof;missing user_id;empty list;A-list with later successful proof for the same A chat. No browser or network calls. Fake CDP alone would not prove the JS fetch relationship. Worker asked to persist exact-expression regression.

Snapshot hashing includes version, principal, account, node, instance and native chat ID. Each field is u64 length plus bytes. This removes identical-content collisions across full SessionAddress and NUL-delimiter ambiguity. Browser context and target identify transport rather than provider session and need not distinguish the same account/chat snapshot.

Transcript message-level content loss is a separate open defect, not accepted by this verdict. Terra published representation fix a5c3a405; browser must preserve observed user question text and assistant original blocks in a regression before acceptance.
