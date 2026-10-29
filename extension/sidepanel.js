import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createReaderOptions } from "./reader-options.js";
import { createSettingsView } from "./settings-view.js";

const $ = (id) => document.getElementById(id);
const HOST = "org.local.paper_sidecar";
const panelParams = new URLSearchParams(location.search);
const sourceTabId = Number(panelParams.get("tabId"));
// Shown inside a paper page (see reader-view.js) rather than the browser's side panel.
const parentOrigin = panelParams.get("parent");
const embedded =
  panelParams.get("embedded") === "1" &&
  [
    "https://www.alphaxiv.org",
    "https://alphaxiv.org",
    "https://arxiv.org",
    "https://www.arxiv.org",
  ].includes(parentOrigin);
const library = (await chrome.storage.local.get("library")).library || {};
let context = null,
  port = null,
  connected = false,
  selectedText = "";
// Answers in progress, one per paper; other papers stay usable while one is answering.
const turns = new Map();
let refreshSequence = 0,
  lastTabId = null;
let saveQueue = Promise.resolve();
const pending = new Map();
const options = await createReaderOptions(document, chrome.storage.local, (text) =>
  notice(text, true),
);

function notice(text = "", error = false) {
  // The settings sheet covers the chat, so it mirrors notices while it is open.
  for (const id of ["notice", "settings-notice"]) {
    $(id).hidden = !text || (id === "settings-notice" && !settingsView?.isOpen());
    $(id).textContent = text;
    $(id).classList.toggle("error", error);
  }
}

// Sign-in opens in its own popup window. A new tab would switch away from this paper
// tab, which closes its side panel and, with it, the local sign-in callback server.
let loginWindowId = null;
const settingsView = createSettingsView(document, {
  send,
  notice,
  openUrl: async (url) => {
    if (!/^https:\/\//.test(url || "")) return;
    const popup = await chrome.windows.create({
      url,
      type: "popup",
      width: 520,
      height: 720,
      focused: true,
    });
    loginWindowId = popup?.id ?? null;
  },
  onLoginFinished: () => {
    if (loginWindowId !== null) void chrome.windows.remove(loginWindowId).catch(() => {});
    loginWindowId = null;
  },
  onClose: () => notice(),
});

// ChatGPT plan usage (Codex rate limits), shown quietly in the footer.
let chatgptSignedIn = false;
function windowLabel(minutes) {
  if (minutes === 10080) return "周";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}天`;
  if (minutes) return `${Math.round(minutes / 60)}h`;
  return "";
}
function showQuota({ windows = [], reached } = {}) {
  const quota = $("quota");
  quota.hidden = !windows.length && !reached;
  if (quota.hidden) return;
  quota.classList.toggle("low", !!reached || windows.some((item) => item.usedPercent >= 90));
  quota.textContent = reached
    ? "额度已用完"
    : `额度 ${windows.map((item) => `${windowLabel(item.minutes)} ${Math.round(item.usedPercent)}%`.trim()).join(" · ")}`;
  quota.title = windows
    .map((item) => {
      const reset = item.resetsAt
        ? new Date(item.resetsAt * 1000).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "未知";
      return `${windowLabel(item.minutes) || "当前"}窗口已用 ${Math.round(item.usedPercent)}%，${reset} 重置`;
    })
    .join("\n");
}
function requestQuota() {
  if (!chatgptSignedIn) {
    $("quota").hidden = true;
    return;
  }
  try {
    send("quota");
  } catch {
    /* Shown again once reconnected. */
  }
}

function refreshSettings() {
  try {
    send("settings");
  } catch {
    /* Reconnecting shows its own notice. */
  }
}

function send(type, payload = {}) {
  if (!port || !connected) throw new Error("本机连接未就绪，请运行安装脚本后重新打开侧栏。");
  const requestId = crypto.randomUUID();
  pending.set(requestId, { type, paperId: payload.context?.paperId || payload.paperId });
  port.postMessage({ type, requestId, ...payload });
  return requestId;
}

// All versions of a paper (1706.03762, 1706.03762v7) share one conversation.
const conversationKey = (paperId) => paperId.replace(/v\d+$/, "");

function entry(key) {
  if (!library[key]) {
    // Older releases stored one conversation per version; adopt the most recent one.
    const legacy = Object.keys(library)
      .filter((id) => id !== key && conversationKey(id) === key)
      .map((id) => library[id])
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    library[key] = {
      messages: legacy[0]?.messages || [],
      archives: legacy.flatMap((item, index) =>
        index ? [...item.archives, item.messages] : item.archives,
      ),
      updated: Date.now(),
    };
    library[key].archives = library[key].archives.filter((messages) => messages?.length);
  }
  return library[key];
}

// In the browser's PDF viewer the tab title is only the arXiv number.
const looksLikeId = (title) => /^\[?[\w./-]*\d{4}\.?\d*(v\d+)?\]?$/.test(title || "");
let prefetched = null;
const pdfTitles = new Map();

// Fetch the PDF as soon as a paper is shown, so the first question does not wait for the
// download, and the PDF viewer gets the real title. Each paper is fetched once per panel.
function prefetchPaper() {
  if (!connected || !context || prefetched === context.paperId) return;
  prefetched = context.paperId;
  try {
    send("load", { context });
  } catch {
    prefetched = null;
  }
}

const currentTurn = () => (context ? turns.get(context.key) : undefined);
const turnFor = (requestId) => [...turns.values()].find((turn) => turn.requestId === requestId);

function persist(paperId) {
  // Persist only the changed paper's visible chat, never PDF or tool payloads.
  const conversation = structuredClone(entry(paperId));
  saveQueue = saveQueue
    .then(async () => {
      const result = await chrome.runtime.sendMessage({
        type: "save-conversation",
        paperId,
        conversation,
        expectedRevision: entry(paperId).revision || 0,
      });
      if (!result?.ok) throw new Error(result?.error || "对话记录保存失败，请保持阅读区打开。");
      entry(paperId).revision = result.revision;
    })
    .catch((error) => notice(error.message, true));
  return saveQueue;
}

function renderBody(element, text, isUser) {
  if (isUser) {
    element.textContent = text;
    return;
  }
  // Preserve math delimiters through Markdown's backslash processing.
  const math = [];
  const protectedText = text.replace(
    /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g,
    (value) => {
      const index = math.push(value) - 1;
      return `SIDECARMATHPLACEHOLDER${index}END`;
    },
  );
  let html = marked.parse(protectedText, { breaks: true });
  html = html.replace(/SIDECARMATHPLACEHOLDER(\d+)END/g, (_, index) => {
    const span = document.createElement("span");
    span.textContent = math[Number(index)];
    return span.innerHTML;
  });
  element.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "img",
      "iframe",
      "style",
      "form",
      "input",
      "video",
      "audio",
      "source",
      "track",
      "picture",
    ],
    FORBID_ATTR: ["style"],
  });
  element.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
  renderMathInElement(element, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
    trust: false,
  });
}

function nearBottom() {
  const container = $("conversation");
  return container.scrollHeight - container.scrollTop - container.clientHeight < 100;
}

function scrollToBottom(smooth = false) {
  const container = $("conversation");
  if (smooth) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  else container.scrollTop = container.scrollHeight;
}

function updateJumpButton() {
  $("jump-latest").hidden = nearBottom();
}

function renderAnswer(body, message, streaming) {
  if (streaming && message.text) {
    // Re-entering a paper mid-answer shows what has arrived so far, then keeps flowing.
    const turn = [...turns.values()].find((item) => item.answer === message);
    if (turn) turn.shown = message.text.length;
    renderStreamingBody(body, message.text);
    return;
  }
  if (!message.text && streaming) {
    // One quiet indicator until the first words arrive; no progress chatter.
    const thinking = document.createElement("span");
    thinking.className = "thinking";
    thinking.textContent = "思考中";
    body.replaceChildren(thinking);
    return;
  }
  renderBody(body, message.text || "", false);
}

function copyButton(message) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = "复制";
  button.title = "复制这条回答的 Markdown 原文";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
    setTimeout(() => (button.textContent = "复制"), 1500);
  });
  return button;
}

function messageNode(message) {
  const streaming = [...turns.values()].some((turn) => turn.answer === message);
  const node = document.createElement("article");
  node.className = `message ${message.role}${streaming ? " streaming" : ""}`;
  const body = document.createElement("div");
  body.className = "body";
  if (message.role === "user") renderBody(body, message.text, true);
  else renderAnswer(body, message, streaming);
  node.append(body);
  if (message.role === "assistant" && !streaming && message.text) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.append(copyButton(message));
    node.append(actions);
  }
  return node;
}

function renderMessages() {
  const shouldScroll = nearBottom();
  const messages = context ? entry(context.key).messages : [];
  $("welcome").hidden = messages.length > 0;
  $("messages").replaceChildren(...messages.map(messageNode));
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
  updateControls();
}

// Streaming stays smooth on long answers:
// - Text is revealed a few characters per animation frame, faster when there is a backlog,
//   so bursty model output reads as an even flow and never falls behind.
// - Finished paragraphs are rendered once (Markdown + KaTeX) and cached; each frame only
//   re-renders the paragraph still being written.
const requestFrame = (callback) =>
  window.requestAnimationFrame ? window.requestAnimationFrame(callback) : setTimeout(callback, 16);
let streamFrame = 0;

function stableSplit(text) {
  // Split at the last blank line that is not inside a code fence or a $$ block.
  for (
    let index = text.lastIndexOf("\n\n");
    index > 0;
    index = text.lastIndexOf("\n\n", index - 1)
  ) {
    const head = text.slice(0, index);
    if ((head.match(/```/g) || []).length % 2 === 0 && (head.match(/\$\$/g) || []).length % 2 === 0)
      return index;
  }
  return 0;
}

function renderStreamingBody(body, text) {
  let stable = body.querySelector(":scope > .stream-stable");
  let tail = body.querySelector(":scope > .stream-tail");
  if (!stable || !tail) {
    stable = document.createElement("div");
    stable.className = "stream-stable";
    tail = document.createElement("div");
    tail.className = "stream-tail";
    body.replaceChildren(stable, tail);
    stable.dataset.text = "";
  }
  const cut = stableSplit(text);
  const head = text.slice(0, cut);
  if (stable.dataset.text !== head) {
    renderBody(stable, head, false);
    stable.dataset.text = head;
  }
  renderBody(tail, text.slice(cut), false);
}

function streamStep() {
  streamFrame = 0;
  const turn = currentTurn();
  if (!turn) return;
  const full = turn.answer.text;
  const backlog = full.length - turn.shown;
  // Never lag behind the model: at least 8 characters a frame, and a backlog clears in ~3 frames.
  if (backlog > 0) turn.shown += Math.max(8, Math.ceil(backlog / 3));
  const node = $("messages").lastElementChild;
  if (!node?.classList.contains("streaming")) return renderMessages();
  if (!full) return;
  const shouldScroll = nearBottom();
  renderStreamingBody(node.querySelector(".body"), full.slice(0, turn.shown));
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
  if (turn.shown < full.length) scheduleStreamRender();
}

function scheduleStreamRender() {
  if (!streamFrame) streamFrame = requestFrame(streamStep);
}

function resizeQuestion() {
  const question = $("question");
  question.style.height = "auto";
  question.style.height = `${Math.min(question.scrollHeight, 150)}px`;
  question.style.overflowY = question.scrollHeight > 150 ? "auto" : "hidden";
}

function updateControls() {
  const busy = !!currentTurn();
  $("send").hidden = busy;
  $("stop").hidden = !busy;
  $("send").disabled = !connected || !context || !options.isReady() || !$("question").value.trim();
  $("reset").disabled = !context || busy;
  $("history").disabled = !context || busy || !entry(context.key).archives.length;
  if ($("history").disabled) $("history-menu").hidden = true;
  $("question").disabled = !context;
  options.setBusy(!connected || busy);
  $("refresh-settings").disabled = !connected || turns.size > 0;
  $("clear-cache").disabled =
    !connected ||
    turns.size > 0 ||
    [...pending.values()].some((request) => request.type === "clear-cache");
}

function updateCache(cache) {
  if (!cache) return;
  $("cache-size").textContent =
    cache.bytes === null ? "缓存不可用" : `缓存 ${(cache.bytes / 1024 / 1024).toFixed(1)} MB`;
  $("cache-size").title =
    `${cache.path}\n上限 ${(cache.maxBytes / 1024 / 1024).toFixed(0)} MB，满后清理最久未用的论文。`;
  $("clear-cache").title = `清理 ${cache.path} 中的论文缓存，保留聊天记录。`;
}

async function refreshContext() {
  const sequence = ++refreshSequence;
  let tab;
  try {
    tab = await contextTab();
  } catch {
    return false;
  }
  if (!tab || sequence !== refreshSequence) return false;
  let data;
  try {
    data = await chrome.tabs.sendMessage(tab.id, { type: "paper-context" });
  } catch {
    data = { url: tab.url, title: tab.title, pdfLinks: [] };
  }
  if (sequence !== refreshSequence) return false;
  const paperId = paperIdFromUrl(data.url);
  const changed = context?.paperId !== paperId || lastTabId !== tab.id;
  if (changed) $("history-menu").hidden = true;
  lastTabId = tab.id;
  if (!paperId) {
    context = null;
    $("paper-title").textContent = "打开一篇论文";
    $("paper-id").textContent = "";
    $("paper-status").textContent = "";
    $("pdf-link").hidden = true;
    if (changed) {
      selectedText = "";
      showSelection();
      renderMessages();
      notice();
    }
    updateControls();
    return true;
  }
  const pdfUrl = pdfUrlForPaper(paperId, data.pdfLinks || []);
  const pageTitle = data.title || paperId;
  context = {
    paperId,
    key: conversationKey(paperId),
    url: data.url,
    title: looksLikeId(pageTitle) ? pdfTitles.get(paperId) || pageTitle : pageTitle,
    pdfUrl,
  };
  $("paper-title").textContent = context.title;
  $("paper-id").textContent = paperId;
  if (changed) {
    options.clearRuntime();
    selectedText = "";
    showSelection();
    $("pdf-link").hidden = true;
    $("paper-status").textContent = "";
    notice();
    renderMessages();
    prefetchPaper();
  }
  updateControls();
  return true;
}

// The side panel opened for one tab stays bound to it (see background.js).
const boundTab = panelParams.has("tabId") && Number.isSafeInteger(sourceTabId) && sourceTabId >= 0;

async function contextTab() {
  if (boundTab) return chrome.tabs.get(sourceTabId);
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

function showSelection() {
  $("selection").hidden = !selectedText;
  $("selection").querySelector("p").textContent = selectedText;
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((message) => {
    updateCache(message.cache);
    const request = pending.get(message.requestId);
    if (settingsView.handle(message, request)) {
      pending.delete(message.requestId);
      // Account and API changes alter which models can be chosen.
      if (
        message.event === "account-changed" ||
        (message.event === "account" && ["login", "logout"].includes(request?.type)) ||
        (message.event === "user-settings" && request?.type !== "save-prompt")
      )
        refreshSettings();
      if (message.event === "account-changed") send("account");
      return;
    }
    if (message.event === "ready") {
      connected = true;
      $("connection").textContent = "本机已连接";
      $("connection").dataset.state = "online";
      notice();
      updateControls();
      send("settings");
      prefetchPaper();
    } else if (message.event === "settings") {
      pending.delete(message.requestId);
      options.initialize(message);
      settingsView.initialize(message);
      updateControls();
      chatgptSignedIn = message.account?.account?.type === "chatgpt";
      requestQuota();
      // Shown instantly the next time a panel opens, then refreshed in the background.
      const { requestId, event, ...catalog } = message;
      void chrome.storage.local.set({ settingsCache: catalog }).catch(() => {});
    } else if (message.event === "quota") {
      pending.delete(message.requestId);
      showQuota(message);
    } else if (message.event === "runtime-settings") {
      if (turnFor(message.requestId) && turnFor(message.requestId) === currentTurn())
        options.showRuntime(message.settings);
    } else if (message.event === "paper") {
      if (message.paperId === context?.paperId) {
        // In the browser's PDF viewer the page only knows the arXiv number.
        if (message.title && !looksLikeId(message.title))
          pdfTitles.set(message.paperId, message.title);
        if (message.title && looksLikeId(context.title) && !looksLikeId(message.title)) {
          context.title = message.title;
          $("paper-title").textContent = message.title;
        }
        $("paper-status").textContent = `${message.pageCount} 页`;
        $("pdf-link").href = message.pdfUrl;
        $("pdf-link").hidden = false;
      }
      if (pending.get(message.requestId)?.type === "load") pending.delete(message.requestId);
    } else if (message.event === "status") {
      /* Progress is shown only as the single "thinking" indicator. */
    } else if (message.event === "delta" && turnFor(message.requestId)) {
      const turn = turnFor(message.requestId);
      turn.parts[message.itemId] = (turn.parts[message.itemId] || "") + message.text;
      turn.answer.text = Object.values(turn.parts).join("\n\n");
      if (turn === currentTurn()) scheduleStreamRender();
    } else if (message.event === "done" && turnFor(message.requestId)) {
      const turn = turnFor(message.requestId);
      const visible = turn === currentTurn();
      turn.answer.text =
        message.text || (message.interrupted ? "回答已停止。" : "没有返回回答，请重试。");
      turns.delete(turn.key);
      pending.delete(message.requestId);
      if (visible) notice();
      requestQuota();
      renderMessages();
      void persist(turn.key);
    } else if (message.event === "reset") {
      options.clearRuntime();
      const key = conversationKey(message.paperId);
      // A restored archive was already swapped in locally; only the model context resets.
      if (!message.restore) {
        const item = entry(key);
        if (item.messages.length) item.archives.push(item.messages);
        item.messages = [];
        void persist(key);
      }
      pending.delete(message.requestId);
      renderMessages();
    } else if (message.event === "cache-cleared") {
      pending.delete(message.requestId);
      notice(
        `已清理 ${(message.removedBytes / 1024 / 1024).toFixed(1)} MB 缓存，聊天记录保留。下次提问时重新获取 PDF。`,
      );
      if (context) $("paper-status").textContent = "";
      updateControls();
    } else if (message.event === "error") {
      settingsView.failed(request);
      const turn = turnFor(message.requestId);
      if (turn) {
        turn.answer.text = `${turn.answer.text || ""}\n\n未完成：${message.text}`;
        turns.delete(turn.key);
        renderMessages();
        void persist(turn.key);
      }
      if (!request?.paperId || conversationKey(request.paperId) === context?.key) {
        notice(message.text, true);
        if (request?.type === "load") $("paper-status").textContent = "PDF 读取失败";
      }
      pending.delete(message.requestId);
      updateControls();
    }
  });
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    connected = false;
    $("connection").textContent = "本机未连接";
    $("connection").dataset.state = "offline";
    notice(
      reason?.includes("not found")
        ? "首次使用：运行项目中的安装程序（macOS：install.command，Windows：install.bat），再重新打开面板。"
        : `本机连接已断开。${reason || ""} 请重新打开侧栏。`,
      true,
    );
    for (const turn of turns.values()) {
      turn.answer.text += "\n\n连接中断，回答未完成。";
      void persist(turn.key);
    }
    turns.clear();
    renderMessages();
  });
  port.postMessage({ type: "hello", requestId: crypto.randomUUID() });
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("question").value.trim();
  if (!question || !context || currentTurn() || !options.isReady()) return;
  try {
    const refreshed = await refreshContext();
    if (!refreshed || !context || currentTurn()) return;
    const item = entry(context.key);
    const history = item.messages.slice(-20).map(({ role, text }) => ({ role, text }));
    options.clearRuntime();
    const requestId = send("chat", {
      context,
      question,
      selection: selectedText,
      history,
      settings: options.value(),
    });
    item.messages.push({ role: "user", text: question, date: Date.now() });
    const answer = { role: "assistant", text: "", date: Date.now() };
    item.messages.push(answer);
    turns.set(context.key, {
      requestId,
      key: context.key,
      paperId: context.paperId,
      answer,
      parts: {},
      shown: 0,
    });
    void persist(context.key);
    $("question").value = "";
    resizeQuestion();
    selectedText = "";
    showSelection();
    notice();
    renderMessages();
  } catch (error) {
    notice(error.message, true);
  }
});
$("question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  } else if (event.key === "Escape" && currentTurn()) {
    event.preventDefault();
    $("stop").click();
  }
});
$("question").addEventListener("input", () => {
  resizeQuestion();
  updateControls();
});
$("stop").addEventListener("click", () => {
  const turn = currentTurn();
  if (!turn) return;
  try {
    send("cancel", { paperId: turn.paperId });
  } catch (error) {
    notice(error.message, true);
  }
});
$("conversation").addEventListener("scroll", updateJumpButton, { passive: true });
$("jump-latest").addEventListener("click", () => scrollToBottom(true));
$("reset").addEventListener("click", () => {
  if (context) send("reset", { paperId: context.paperId });
});

// Conversation history: every "＋" archives the previous conversation of the same paper.
function conversationSummary(messages) {
  const first = messages.find((message) => message.role === "user");
  const date = first?.date ? new Date(first.date) : null;
  const when = date
    ? `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : "较早";
  return {
    title: (first?.text || "（空对话）").replace(/\s+/g, " ").slice(0, 60),
    meta: `${when} · ${Math.ceil(messages.length / 2)} 轮`,
  };
}

function renderHistory() {
  const item = entry(context.key);
  const rows = [];
  const current = document.createElement("div");
  current.className = "history-current";
  current.textContent = item.messages.length
    ? `当前：${conversationSummary(item.messages).title}`
    : "当前：新对话";
  rows.push(current);
  item.archives
    .map((messages, index) => ({ messages, index }))
    .reverse()
    .forEach(({ messages, index }) => {
      const summary = conversationSummary(messages);
      const row = document.createElement("div");
      row.className = "history-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "history-open";
      const title = document.createElement("span");
      title.textContent = summary.title;
      const meta = document.createElement("small");
      meta.textContent = summary.meta;
      open.append(title, meta);
      open.addEventListener("click", () => restoreArchive(index));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button history-delete";
      remove.title = "删除这段对话";
      remove.setAttribute("aria-label", "删除这段对话");
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        if (!confirm("删除这段历史对话？此操作不能撤销。")) return;
        item.archives.splice(index, 1);
        void persist(context.key);
        if (item.archives.length) renderHistory();
        else $("history-menu").hidden = true;
        updateControls();
      });
      row.append(open, remove);
      rows.push(row);
    });
  $("history-list").replaceChildren(...rows);
}

function restoreArchive(index) {
  if (!context || currentTurn()) return;
  const item = entry(context.key);
  const [restored] = item.archives.splice(index, 1);
  if (item.messages.length) item.archives.push(item.messages);
  item.messages = restored;
  $("history-menu").hidden = true;
  void persist(context.key);
  renderMessages();
  try {
    // Drop the model's context so the next question continues from the restored history.
    send("reset", { paperId: context.paperId, restore: true });
  } catch {
    /* Without a connection there is no model context to reset. */
  }
}

$("history").addEventListener("click", () => {
  const menu = $("history-menu");
  if (!menu.hidden || !context) {
    menu.hidden = true;
    return;
  }
  renderHistory();
  menu.hidden = false;
});
document.addEventListener("click", (event) => {
  if (!$("history-menu").hidden && !event.target.closest("#history-menu, #history"))
    $("history-menu").hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("history-menu").hidden = true;
});
$("clear-cache").addEventListener("click", () => {
  try {
    send("clear-cache");
    updateControls();
    notice("正在清理论文缓存…");
  } catch (error) {
    notice(error.message, true);
  }
});
$("quote").addEventListener("click", async () => {
  try {
    const tab = await contextTab();
    if (!tab) return;
    const data = await chrome.tabs.sendMessage(tab.id, { type: "paper-context" });
    selectedText = data.selection || "";
    showSelection();
    if (!selectedText) notice("先在论文中选中一段文字，再点击引用。也可以直接输入页码提问。");
  } catch {
    notice("此 PDF 查看器不能提取选区；可以直接输入页码提问。");
  }
});
$("clear-selection").addEventListener("click", () => {
  selectedText = "";
  showSelection();
});
$("refresh-settings").addEventListener("click", () => {
  try {
    send("settings");
  } catch (error) {
    notice(error.message, true);
  }
});
document.querySelectorAll("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    $("question").value = button.dataset.prompt;
    resizeQuestion();
    updateControls();
    $("question").focus();
  }),
);
chrome.tabs.onActivated.addListener(() => {
  if (!boundTab) void refreshContext();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === lastTabId && (change.url || change.status === "complete")) void refreshContext();
});
// Also catches client-side navigation and delayed title/PDF-link hydration.
setInterval(() => {
  if (!document.hidden) void refreshContext();
}, 1600);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshContext();
});
window.addEventListener("pagehide", () => {
  for (const turn of turns.values()) void persist(turn.key);
});
if (embedded) {
  // Text selected on the paper page arrives here as a quote for the next question.
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.type !== "paper-sidecar-quote" ||
      typeof event.data.text !== "string"
    )
      return;
    selectedText = event.data.text.slice(0, 16000);
    showSelection();
    notice();
    $("question").focus();
  });
  $("close-panel").hidden = false;
  $("close-panel").addEventListener("click", () => {
    window.parent.postMessage({ type: "paper-sidecar-close" }, parentOrigin);
  });
}
// Show the last known models and settings immediately instead of "loading…".
const { settingsCache } = await chrome.storage.local.get("settingsCache");
if (settingsCache?.models) {
  options.initialize(settingsCache);
  settingsView.initialize(settingsCache);
}
connect();
await refreshContext();
// The panel reloads on every tab switch; show it only once the right paper is in place.
renderMessages();
document.body.classList.remove("booting");
if (embedded) window.parent.postMessage({ type: "paper-sidecar-ready" }, parentOrigin);
