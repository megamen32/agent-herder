# V025LAUNCH independent review: REVISE

2026-11-07. Independent reviewer Nietzsche (existing Astra adviser), then
Astra source cross-check, commits 362e0606 + 75d22b49 atop ce46aa12.
No source edits, native actions or repeated tests in this review.

1. scoped_profile::open calls Writer::open_file, which accepts v1/v2/v3 and
   skips schema validation for v1. A provisioned v3 database with only
   user_version changed to 1 still passes the authority row check; missing v3
   triggers can then escape validation. Require exact v3 and validated schema
   plus authority on one consistent connection/transaction.
2. The opener stats the database path, opens it through Writer for schema,
   then opens it independently for authority. These do not prove the inode
   of the actual database read matches the saved metadata. The immediate
   private directory check also does not establish trust of its ancestors.
   Use one connection and establish a verifiable namespace/file-pinning
   boundary. A second stat alone is not protection against arbitrary ABA.
   No malicious same-UID protection is claimed; do not expand this into a new
   custom SQLite VFS without necessity. Test a replaceable ancestor and the
   actual supported trust boundary.
3. Profile open is blocking before fstat. FIFO without a writer can hang
   forever. O_NONBLOCK + O_NOFOLLOW and regular-file FD validation must reject
   it promptly.

The existing caller boundary is supported: launcher leaves Unknown caller,
empty grants, no self-binding, and does not wire authority to ApplicationPort
yet. A protected local profile does not grant MCP caller identity.
The previously cited negative stdio tests use --config, so they do not cover
the new --scoped-profile branch. Add a negative identity case with a valid
scoped profile. Public create/deliver/read is a later slice, not a requirement
to call this profile-opening slice complete.

Tesla owns corrections; Terra is informed. Required small proofs: downgraded
schema and missing trigger rejected; protected path identity maintained;
FIFO prompt rejection; forged metadata does not grant identity through the
scoped-profile launcher branch.
