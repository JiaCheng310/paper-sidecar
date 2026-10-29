import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createReaderOptions } from "./reader-options.js";
import { createSettingsView } from "./settings-view.js";

const $ = (id) => document.getElementById(id);
const HOST = "org.local.paper_sidecar";
const panelParams = new URLSearchParams(location.search);
const embedded = panelParams.get("embedded") === "1";
const sourceTabId = Number(panelParams.get("tabId"));
const parentOrigin = panelParams.get("parent");
const validReader =
  !embedded ||
  (panelParams.has("tabId") &&
    Number.isSafeInteger(sourceTabId) &&
    sourceTabId >= 0 &&
    [
      "https://www.alphaxiv.org",
      "https://alphaxiv.org",
      "https://arxiv.org",
      "https://www.arxiv.org",
    ].includes(parentOrigin));
const library = (await chrome.storage.local.get("library")).library || {};
let context = null,
  port = null,
  connected = false,
  selectedText = "",
  activeTurn = null;
let refreshSequence = 0,
  lastTabId = null;
let saveQueue = Promise.resolve();
let streamTimer = null,
  streamRenderedAt = 0;
const STREAM_RENDER_INTERVAL = 80;
const pending = new Map();
const options = await createReaderOptions(document, chrome.storage.local, (text) =>
  notice(text, true),
);
if (embedded) document.documentElement.dataset.embedded = "true";

function notice(text = "", error = false) {
  // The settings sheet covers the chat, so it mirrors notices while it is open.
  for (const id of ["notice", "settings-notice"]) {
    $(id).hidden = !text || (id === "settings-notice" && !settingsView?.isOpen());
    $(id).textContent = text;
    $(id).classList.toggle("error", error);
  }
}

const settingsView = createSettingsView(document, {
  send,
  notice,
  openUrl: (url) => {
    if (/^https:\/\//.test(url || "")) void chrome.tabs.create({ url });
  },
  onClose: () => notice(),
});

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

function entry(key) {
  return (library[key] ||= { messages: [], archives: [], updated: Date.now() });
}

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
  if (!message.text && streaming) {
    const typing = document.createElement("span");
    typing.className = "typing";
    typing.setAttribute("aria-label", "正在思考");
    typing.append(...[0, 1, 2].map(() => document.createElement("i")));
    body.replaceChildren(typing);
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
  const streaming = message === activeTurn?.answer;
  const node = document.createElement("article");
  node.className = `message ${message.role}${streaming ? " streaming" : ""}`;
  const label = document.createElement("div");
  label.className = "label";
  const name = document.createElement("span");
  name.textContent = message.role === "user" ? "你" : "伴读";
  label.append(name);
  if (message.role === "assistant" && !streaming && message.text) label.append(copyButton(message));
  const body = document.createElement("div");
  body.className = "body";
  if (message.role === "user") renderBody(body, message.text, true);
  else renderAnswer(body, message, streaming);
  node.append(label, body);
  return node;
}

function renderMessages() {
  clearTimeout(streamTimer);
  streamTimer = null;
  const shouldScroll = nearBottom();
  const messages = context ? entry(context.paperId).messages : [];
  $("welcome").hidden = messages.length > 0;
  $("messages").replaceChildren(...messages.map(messageNode));
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
  updateControls();
}

// Streaming re-renders only the answer being written, at most every 80 ms. Rebuilding
// every message (Markdown and KaTeX included) on each delta made long chats sluggish.
function renderStreaming() {
  streamTimer = null;
  streamRenderedAt = Date.now();
  if (!activeTurn || activeTurn.paperId !== context?.paperId) return;
  const node = $("messages").lastElementChild;
  if (!node?.classList.contains("streaming")) return renderMessages();
  const shouldScroll = nearBottom();
  renderAnswer(node.querySelector(".body"), activeTurn.answer, true);
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
}

function scheduleStreamRender() {
  if (streamTimer) return;
  const wait = STREAM_RENDER_INTERVAL - (Date.now() - streamRenderedAt);
  if (wait <= 0) renderStreaming();
  else streamTimer = setTimeout(renderStreaming, wait);
}

function resizeQuestion() {
  const question = $("question");
  question.style.height = "auto";
  question.style.height = `${Math.min(question.scrollHeight, 150)}px`;
  question.style.overflowY = question.scrollHeight > 150 ? "auto" : "hidden";
}

function updateControls() {
  $("send").hidden = !!activeTurn;
  $("stop").hidden = !activeTurn;
  $("send").disabled = !connected || !context || !options.isReady() || !$("question").value.trim();
  $("reset").disabled = !context || !!activeTurn;
  $("question").disabled = !context;
  options.setBusy(!connected || !!activeTurn);
  $("refresh-settings").disabled = !connected || !!activeTurn;
  $("clear-cache").disabled =
    !connected ||
    !!activeTurn ||
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
  lastTabId = tab.id;
  if (!paperId) {
    context = null;
    $("paper-title").textContent = "打开一篇论文";
    $("paper-id").textContent = "";
    $("paper-status").textContent = "支持 alphaXiv 与 arXiv 的论文页面";
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
  context = { paperId, url: data.url, title: data.title || paperId, pdfUrl };
  $("paper-title").textContent = context.title;
  $("paper-id").textContent = paperId;
  if (changed) {
    options.clearRuntime();
    selectedText = "";
    showSelection();
    $("pdf-link").hidden = true;
    $("paper-status").textContent = connected ? "已识别 · 提问时读取 PDF" : "等待本机连接";
    notice();
    renderMessages();
  }
  updateControls();
  return true;
}

async function contextTab() {
  if (embedded) return validReader ? chrome.tabs.get(sourceTabId) : null;
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
      if (context) $("paper-status").textContent = "已识别 · 提问时读取 PDF";
      send("settings");
    } else if (message.event === "settings") {
      pending.delete(message.requestId);
      options.initialize(message);
      settingsView.initialize(message);
      updateControls();
    } else if (
      message.event === "runtime-settings" &&
      message.requestId === activeTurn?.requestId
    ) {
      options.showRuntime(message.settings);
    } else if (message.event === "paper") {
      if (message.paperId === context?.paperId) {
        $("paper-status").textContent =
          `${message.pageCount} 页 · ${message.hasTextLayer ? "原文可读取" : "可按页查看图片"}`;
        $("pdf-link").href = message.pdfUrl;
        $("pdf-link").hidden = false;
      }
      if (pending.get(message.requestId)?.type === "load") pending.delete(message.requestId);
    } else if (message.event === "status") {
      if (message.paperId === context?.paperId) notice(message.text);
    } else if (message.event === "delta" && message.requestId === activeTurn?.requestId) {
      activeTurn.parts[message.itemId] = (activeTurn.parts[message.itemId] || "") + message.text;
      activeTurn.answer.text = Object.values(activeTurn.parts).join("\n\n");
      if (message.paperId === context?.paperId) scheduleStreamRender();
    } else if (message.event === "done" && message.requestId === activeTurn?.requestId) {
      activeTurn.answer.text =
        message.text || (message.interrupted ? "回答已停止。" : "没有返回回答，请重试。");
      activeTurn = null;
      pending.delete(message.requestId);
      notice(message.interrupted ? "回答已停止" : "");
      renderMessages();
      void persist(message.paperId);
    } else if (message.event === "reset") {
      options.clearRuntime();
      const item = entry(message.paperId);
      if (item.messages.length) item.archives.push(item.messages);
      item.messages = [];
      pending.delete(message.requestId);
      renderMessages();
      void persist(message.paperId);
    } else if (message.event === "cache-cleared") {
      pending.delete(message.requestId);
      notice(
        `已清理 ${(message.removedBytes / 1024 / 1024).toFixed(1)} MB 缓存，聊天记录保留。下次提问时重新获取 PDF。`,
      );
      if (context) $("paper-status").textContent = "已识别 · 提问时读取 PDF";
      updateControls();
    } else if (message.event === "error") {
      settingsView.failed(request);
      if (message.requestId === activeTurn?.requestId) {
        const paperId = activeTurn.paperId;
        activeTurn.answer.text = `${activeTurn.answer.text || ""}\n\n未完成：${message.text}`;
        activeTurn = null;
        renderMessages();
        void persist(paperId);
      }
      if (!request?.paperId || request.paperId === context?.paperId) {
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
        ? "首次使用：运行项目中的 install.command，再重新打开侧栏。"
        : `本机连接已断开。${reason || ""} 请重新打开侧栏。`,
      true,
    );
    if (activeTurn) {
      activeTurn.answer.text += "\n\n连接中断，回答未完成。";
      void persist(activeTurn.paperId);
    }
    activeTurn = null;
    renderMessages();
  });
  port.postMessage({ type: "hello", requestId: crypto.randomUUID() });
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("question").value.trim();
  if (!question || !context || activeTurn || !options.isReady()) return;
  try {
    const refreshed = await refreshContext();
    if (!refreshed || !context || activeTurn) return;
    const item = entry(context.paperId);
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
    activeTurn = { requestId, paperId: context.paperId, answer, parts: {} };
    void persist(context.paperId);
    $("question").value = "";
    resizeQuestion();
    selectedText = "";
    showSelection();
    notice("正在阅读并思考…");
    renderMessages();
  } catch (error) {
    notice(error.message, true);
  }
});
$("question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  } else if (event.key === "Escape" && activeTurn) {
    event.preventDefault();
    $("stop").click();
  }
});
$("question").addEventListener("input", () => {
  resizeQuestion();
  updateControls();
});
$("stop").addEventListener("click", () => {
  try {
    send("cancel");
    notice("正在停止…");
  } catch (error) {
    notice(error.message, true);
  }
});
$("conversation").addEventListener("scroll", updateJumpButton, { passive: true });
$("jump-latest").addEventListener("click", () => scrollToBottom(true));
$("reset").addEventListener("click", () => {
  if (context) send("reset", { paperId: context.paperId });
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
  if (!embedded) void refreshContext();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === lastTabId && (change.url || change.status === "complete")) void refreshContext();
});
// Also catches client-side navigation and delayed title/PDF-link hydration.
setInterval(() => {
  if (!document.hidden) void refreshContext();
}, 1600);
if (embedded && validReader) {
  $("collapse-panel").hidden = false;
  $("collapse-panel").addEventListener("click", () => {
    window.parent.postMessage({ type: "paper-sidecar-collapse" }, parentOrigin);
  });
  window.addEventListener("message", (event) => {
    if (
      event.source === window.parent &&
      event.origin === parentOrigin &&
      event.data?.type === "paper-sidecar-context-changed"
    )
      void refreshContext();
  });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshContext();
});
window.addEventListener("pagehide", () => {
  if (activeTurn) void persist(activeTurn.paperId);
});
if (validReader) {
  connect();
  await refreshContext();
} else {
  notice("阅读区连接信息不完整，请回到论文页面重新打开。", true);
  updateControls();
}
