import { paperIdFromUrl } from "./paper-context.js";

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;
const sizeOf = (library) => new TextEncoder().encode(JSON.stringify(library)).byteLength;

// Make room by forgetting what was used least recently: first the history of the least
// recently opened papers, then those papers' whole conversations, and only then the
// current paper's own oldest history. The conversation being saved is never touched.
function prune(library, keep, limit) {
  const others = Object.keys(library)
    .filter((id) => id !== keep)
    .sort((a, b) => (library[a].updated || 0) - (library[b].updated || 0));
  let removed = 0;
  for (const id of others) {
    if (sizeOf(library) <= limit) return removed;
    if (library[id].archives?.length) {
      removed += library[id].archives.length;
      library[id] = { ...library[id], archives: [] };
    }
  }
  for (const id of others) {
    if (sizeOf(library) <= limit) return removed;
    removed += 1 + (library[id].archives?.length || 0);
    delete library[id];
  }
  while (sizeOf(library) > limit && library[keep].archives.length) {
    library[keep].archives.shift();
    removed += 1;
  }
  return removed;
}

// All panels write through the service worker. Serializing the read/merge/write
// prevents two paper tabs from replacing each other's saved conversations.
export function createConversationStore(storage, limit = MAX_LIBRARY_BYTES) {
  let queue = Promise.resolve();

  async function write({ paperId, conversation, expectedRevision }) {
    if (
      paperIdFromUrl(`https://arxiv.org/abs/${paperId}`) !== paperId ||
      !Array.isArray(conversation?.messages) ||
      !Array.isArray(conversation?.archives)
    ) {
      throw new Error("对话数据不完整，未保存。请重新打开阅读区。");
    }
    const library = (await storage.get("library")).library || {};
    const revision = library[paperId]?.revision || 0;
    // A conversation pruned to make room may still be open in a panel; let it save again.
    const pruned = !library[paperId] && expectedRevision > 0;
    if (expectedRevision !== revision && !pruned) {
      throw new Error(
        "这篇论文的对话已在另一个窗口更新，本窗口的内容尚未保存。请复制需要保留的内容，再重新打开阅读区。",
      );
    }
    library[paperId] = {
      messages: conversation.messages,
      archives: conversation.archives,
      updated: Date.now(),
      revision: revision + 1,
    };
    const removed = prune(library, paperId, limit);
    if (sizeOf(library) > limit) {
      // Only this one conversation is too big on its own; leave every saved record as it was.
      throw new Error(
        "这段对话超过 4 MB 保存上限；当前会话仍可使用，但不会保存。可以点 ＋ 开始新对话。",
      );
    }
    await storage.set({ library });
    return { revision: revision + 1, removed };
  }

  return {
    save(request) {
      const result = queue.then(() => write(request));
      // One rejected save must not block unrelated papers or later attempts.
      queue = result.catch(() => {});
      return result;
    },
  };
}
