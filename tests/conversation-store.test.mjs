import test from "node:test";
import assert from "node:assert/strict";
import { createConversationStore } from "../extension/conversation-store.js";

function makeStore() {
  let stored = {};
  const storage = {
    get: async () => structuredClone(stored),
    set: async (value) => {
      stored = structuredClone(value);
    },
  };
  return { ...createConversationStore(storage), read: () => stored.library || {} };
}

function request(paperId, text, expectedRevision = 0) {
  return {
    paperId,
    expectedRevision,
    conversation: {
      messages: [{ role: "user", text }],
      archives: [],
    },
  };
}

test("concurrent paper tabs merge saves without overwriting other papers", async () => {
  const store = makeStore();
  await Promise.all([
    store.save(request("1706.03762", "Paper A")),
    store.save(request("2401.12345v2", "Paper B")),
  ]);
  assert.equal(store.read()["1706.03762"].messages[0].text, "Paper A");
  assert.equal(store.read()["2401.12345v2"].messages[0].text, "Paper B");
});

test("a stale view of the same paper cannot replace a newer saved conversation", async () => {
  const store = makeStore();
  const first = await store.save(request("1706.03762", "First"));
  await store.save(request("1706.03762", "Newer", first.revision));
  await assert.rejects(store.save(request("1706.03762", "Stale", first.revision)), /另一个窗口/);
  assert.equal(store.read()["1706.03762"].messages[0].text, "Newer");
  await store.save(request("2401.12345", "Independent paper"));
  assert.equal(store.read()["2401.12345"].messages[0].text, "Independent paper");
});

test("the chat storage limit preserves existing records and recovers after rejection", async () => {
  const store = makeStore();
  await store.save(request("1706.03762", "Keep this"));
  await assert.rejects(store.save(request("2401.12345", "x".repeat(4 * 1024 * 1024))), /4 MB/);
  assert.equal(store.read()["1706.03762"].messages[0].text, "Keep this");
  assert.equal(store.read()["2401.12345"], undefined);
  await store.save(request("2401.12345", "A smaller question"));
  assert.equal(store.read()["2401.12345"].messages[0].text, "A smaller question");
});
