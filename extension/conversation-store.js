import { paperIdFromUrl } from "./paper-context.js";

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;

// All panels write through the service worker. Serializing the read/merge/write
// prevents two paper tabs from replacing each other's saved conversations.
export function createConversationStore(storage) {
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
    if (expectedRevision !== revision) {
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
    if (new TextEncoder().encode(JSON.stringify(library)).byteLength > MAX_LIBRARY_BYTES) {
      throw new Error("对话记录达到 4 MB 保存上限；当前会话仍可使用，新的记录暂不保存。");
    }
    await storage.set({ library });
    return { revision: revision + 1 };
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
