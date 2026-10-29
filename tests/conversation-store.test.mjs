import test from "node:test";
import assert from "node:assert/strict";
import { createConversationStore } from "../extension/conversation-store.js";

function makeStore(limit) {
  let stored = {};
  const storage = {
    get: async () => structuredClone(stored),
    set: async (value) => {
      stored = structuredClone(value);
    },
  };
  return { ...createConversationStore(storage, limit), read: () => stored.library || {} };
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

test("when storage fills up, the least recently used conversations make room", async () => {
  const store = makeStore(3000);
  const save = (id, text, archives = [], revision = 0) =>
    store.save({
      paperId: id,
      expectedRevision: revision,
      conversation: { messages: [{ role: "user", text }], archives },
    });
  const archive = [[{ role: "user", text: "o".repeat(400) }]];
  await save("1111.11111", "a".repeat(400), archive);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await save("2222.22222", "b".repeat(400), archive);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Room is needed: the oldest paper's history goes first, its conversation stays.
  let result = await save("3333.33333", "c".repeat(1200));
  assert.ok(result.removed >= 1);
  assert.deepEqual(store.read()["1111.11111"].archives, []);
  assert.ok(store.read()["1111.11111"].messages.length);
  assert.ok(store.read()["3333.33333"]);
  // More room: whole conversations of the least recently used papers go next.
  await save("4444.44444", "d".repeat(1200));
  assert.equal(store.read()["1111.11111"], undefined);
  assert.ok(store.read()["4444.44444"]);
  // A panel still showing a pruned paper can save it again.
  result = await save("1111.11111", "a again", [], 3);
  assert.ok(result.revision >= 1);
  // One conversation larger than the whole limit is refused and nothing else changes.
  const before = JSON.stringify(store.read());
  await assert.rejects(save("5555.55555", "x".repeat(5000)), /4 MB/);
  assert.equal(JSON.stringify(store.read()), before);
});
