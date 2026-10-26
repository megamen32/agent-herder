# Installed long-message MCP consumer — 2026-10-26

Using the immutable installed 16f73e1 `dist/long-messages.js`, generated one task-owned 8,001-character Unicode fixture (`HF26_PREVIEW_` followed by Cyrillic characters) through compactAutomaticMessage. The returned preview contains exactly the first 8,000 characters followed by the continuation link. Stored message ID: `b4fa719e`; SHA256 `b4fa719e114611a25cb0d2b0cff8677b4844f62dd63c847dc39c70c1abe6760c`.

The actual connected Herder MCP `read_message` returned offset 0 with 8,000 characters, total 8,001 and nextOffset 8,000. The offset 8,000 read returned the final one character and nextOffset null. Concatenating the actual MCP structured responses exactly reconstructed the fixture. One intermediate read returned a tool transport error; this read-only call was retried and returned the exact final chunk. No send, model turn or external communication was performed.

This proves installed preview length and actual MCP continuation consumption in characters, not model tokens. It is not a browser rendering claim.
