import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const adapterPath = new URL("../../../crates/herder/src/adapters/zai/mod.rs", import.meta.url);
const adapterSource = await readFile(adapterPath, "utf8");
const expressionMatch = adapterSource.match(
  /const ZAI_CHAT_LIST_EXPRESSION: &str = r#"([\s\S]*?)"#;/,
);
assert.ok(expressionMatch, "Z.ai list expression should be available for this contract test");
const listExpression = expressionMatch[1];

function accountScope(userId) {
  return createHash("sha256").update(userId).digest("hex");
}

async function evaluateListExpression({ expectedUserId, listStatus = 200, chats = [], proof }) {
  const expectedScope = accountScope(expectedUserId);
  const calls = [];
  const context = {
    location: { origin: "https://chat.z.ai" },
    encodeURIComponent,
    TextEncoder,
    crypto: {
      subtle: {
        async digest(_algorithm, bytes) {
          const userId = new TextDecoder().decode(bytes);
          const digest = createHash("sha256").update(userId).digest();
          return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
        },
      },
    },
    async fetch(url) {
      calls.push(url);
      if (url.includes("/api/v1/chats/?")) {
        return {
          ok: listStatus >= 200 && listStatus < 300,
          status: listStatus,
          async json() {
            return chats;
          },
        };
      }
      return {
        ok: proof.status >= 200 && proof.status < 300,
        status: proof.status,
        async json() {
          return proof.body;
        },
      };
    },
  };
  const expression = listExpression.replace("__EXPECTED_SCOPE__", JSON.stringify(expectedScope));
  const result = await vm.runInNewContext(expression, context);
  return { result, calls };
}

test("list result is bound to its first chat's account identity", async (t) => {
  const cases = [
    {
      name: "account A list and matching first-chat proof succeeds",
      expected: "user-A",
      chats: [{ id: "chat-a" }],
      proof: { status: 200, body: { id: "chat-a", user_id: "user-A" } },
      check(result) {
        assert.deepEqual(result.chats, [{ id: "chat-a" }]);
        assert.equal(result.scope, accountScope("user-A"));
        assert.equal(result.scope_verified, true);
      },
      calls: 2,
    },
    {
      name: "account B list and B proof is rejected for expected account A",
      expected: "user-A",
      chats: [{ id: "chat-b" }],
      proof: { status: 200, body: { id: "chat-b", user_id: "user-B" } },
      check(result) {
        assert.equal(result.error, "account_mismatch");
        assert.equal(result.scope, accountScope("user-B"));
      },
      calls: 2,
    },
    {
      name: "proof with another chat identity fails closed",
      expected: "user-A",
      chats: [{ id: "chat-b" }],
      proof: { status: 200, body: { id: "chat-a", user_id: "user-A" } },
      check(result) {
        assert.equal(result.error, "account_unverified");
      },
      calls: 2,
    },
    {
      name: "list HTTP 403 preserves provider status",
      expected: "user-A",
      listStatus: 403,
      chats: [],
      proof: { status: 200, body: { id: "chat-a", user_id: "user-A" } },
      check(result) {
        assert.equal(result.status, 403);
      },
      calls: 1,
    },
    {
      name: "first-chat HTTP 403 fails closed",
      expected: "user-A",
      chats: [{ id: "chat-a" }],
      proof: { status: 403, body: null },
      check(result) {
        assert.equal(result.error, "account_unverified");
      },
      calls: 2,
    },
    {
      name: "missing first-chat user_id fails closed",
      expected: "user-A",
      chats: [{ id: "chat-a" }],
      proof: { status: 200, body: { id: "chat-a" } },
      check(result) {
        assert.equal(result.error, "account_unverified");
      },
      calls: 2,
    },
    {
      name: "empty list has no identity proof and fails closed",
      expected: "user-A",
      chats: [],
      proof: { status: 200, body: { id: "chat-a", user_id: "user-A" } },
      check(result) {
        assert.equal(result.error, "account_unverified");
      },
      calls: 1,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { result, calls } = await evaluateListExpression({
        expectedUserId: scenario.expected,
        listStatus: scenario.listStatus,
        chats: scenario.chats,
        proof: scenario.proof,
      });
      scenario.check(result);
      assert.equal(calls.length, scenario.calls);
    });
  }
});
