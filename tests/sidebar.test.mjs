import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { paperIdFromUrl, pdfUrlForPaper } from "../extension/paper-context.js";
import { createConversationStore } from "../extension/conversation-store.js";
import { createReaderOptions } from "../extension/reader-options.js";
import { createSettingsView } from "../extension/settings-view.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function browserEvent() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

async function makeSidebar({ bound = false } = {}) {
  const html = await readFile(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
  // The real side panel is opened per tab as sidepanel.html?tabId=<id> (see background.js).
  const suffix = bound ? "?tabId=10" : "";
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: `https://test.invalid/sidepanel.html${suffix}`,
  });
  const { window } = dom;
  const sent = [],
    saved = [],
    created = [];
  const messages = browserEvent(),
    activated = browserEvent(),
    updated = browserEvent();
  let current = { id: 10, url: "https://www.alphaxiv.org/abs/1706.03762", title: "Paper A" };
  let otherActive = null;
  let stored = {};
  const storage = {
    get: async () => structuredClone(stored),
    set: async (value) => {
      stored = { ...stored, ...structuredClone(value) };
      saved.push(structuredClone(value));
    },
  };
  const conversations = createConversationStore(storage);
  window.TextEncoder = TextEncoder;
  window.structuredClone = structuredClone;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  window.renderMathInElement = () => {};
  window.setInterval = () => 0;
  window.chrome = {
    storage: { local: storage },
    runtime: {
      sendMessage: async (request) => ({ ok: true, ...(await conversations.save(request)) }),
      connectNative: () => ({
        onMessage: messages,
        onDisconnect: browserEvent(),
        postMessage: (message) => sent.push(message),
      }),
    },
    windows: {
      create: async (options) => {
        created.push(options);
        return { id: 77 };
      },
      remove: async (id) => created.push({ removed: id }),
    },
    tabs: {
      query: async () => [otherActive || current],
      get: async (id) => (id === current.id ? current : otherActive),
      sendMessage: async (id) => ({ ...(id === current.id ? current : otherActive), pdfLinks: [] }),
      onActivated: activated,
      onUpdated: updated,
    },
  };
  const source = (
    await readFile(new URL("../extension/sidepanel.js", import.meta.url), "utf8")
  ).replace(/^import .*\n/gm, "");
  await new window.Function(
    "paperIdFromUrl",
    "pdfUrlForPaper",
    "createReaderOptions",
    "createSettingsView",
    `return (async () => {${source}\n})();`,
  )(paperIdFromUrl, pdfUrlForPaper, createReaderOptions, createSettingsView);
  messages.emit({ event: "ready" });
  const settings = {
    event: "settings",
    requestId: sent.find((item) => item.type === "settings").requestId,
    models: [
      {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        efforts: ["low", "medium", "high"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      },
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        efforts: ["medium", "high", "max"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
      },
    ],
    defaults: { model: "gpt-6-sol", effort: "medium", speed: "fast" },
    prompt: {
      name: "内置默认提示词",
      path: "随扩展提供",
      text: "沿用这份阅读指令。",
    },
    defaultPrompt: { name: "内置默认提示词", path: "随扩展提供" },
    providers: [],
    account: { account: { type: "chatgpt", email: "me@example.com" }, requiresOpenaiAuth: true },
  };
  messages.emit(settings);
  await tick();
  return {
    dom,
    window,
    sent,
    saved,
    messages,
    settings,
    created,
    async activateOther() {
      otherActive = {
        id: 20,
        url: "https://www.alphaxiv.org/abs/2401.12345",
        title: "Another tab",
      };
      activated.emit({ tabId: otherActive.id });
      await tick();
    },
    async navigate(id, title) {
      current = { id: current.id, url: `https://www.alphaxiv.org/abs/${id}`, title };
      updated.emit(current.id, { url: current.url });
      await tick();
    },
  };
}

test("browsing follows the paper and prefetches each PDF exactly once", async () => {
  const app = await makeSidebar();
  try {
    const loads = () =>
      app.sent
        .filter((message) => message.type === "load")
        .map((message) => message.context.paperId);
    assert.equal(app.window.document.getElementById("paper-id").textContent, "1706.03762");
    assert.deepEqual(loads(), ["1706.03762"]);
    await app.navigate("2401.12345v2", "Paper B");
    assert.equal(app.window.document.getElementById("paper-title").textContent, "Paper B");
    assert.deepEqual(loads(), ["1706.03762", "2401.12345v2"]);
    await app.navigate("2401.12345v2", "Paper B");
    assert.deepEqual(loads(), ["1706.03762", "2401.12345v2"]);
    app.messages.emit({
      event: "paper",
      paperId: "1706.03762",
      pageCount: 15,
      hasTextLayer: true,
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
    });
    // Status stays quiet: no explanatory text, and another paper's PDF never shows here.
    assert.equal(app.window.document.getElementById("paper-status").textContent, "");
  } finally {
    app.dom.window.close();
  }
});

test("late answers stay with their paper and model HTML cannot load remote images", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    doc.getElementById("question").value = "Explain Figure 1";
    doc
      .getElementById("composer")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    await tick();
    const request = app.sent.find((message) => message.type === "chat");
    assert.equal(request.context.paperId, "1706.03762");
    app.messages.emit({
      event: "delta",
      requestId: request.requestId,
      paperId: "1706.03762",
      itemId: "one",
      text: '<img src="https://evil.test/pixel" onerror="alert(1)"><svg><image href="https://evil.test/pixel" /></svg><video poster="https://evil.test/pixel"></video>Answer',
    });
    assert.equal(doc.querySelectorAll(".body img, .body svg, .body video, .body audio").length, 0);
    await app.navigate("2401.12345", "Paper B");
    app.messages.emit({
      event: "done",
      requestId: request.requestId,
      paperId: "1706.03762",
      text: "Answer to Paper A",
    });
    await tick();
    assert.equal(doc.querySelectorAll(".message").length, 0);
    assert.equal(app.saved.at(-1).library["1706.03762"].messages.at(-1).text, "Answer to Paper A");
    await app.navigate("1706.03762", "Paper A");
    assert.match(doc.getElementById("messages").textContent, /Answer to Paper A/);
  } finally {
    app.dom.window.close();
  }
});

test("cache cleanup updates usage without deleting the visible or saved conversation", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    const cache = {
      path: "/test/Library/Caches/paper-sidecar",
      bytes: 2 * 1024 * 1024,
      maxBytes: 512 * 1024 * 1024,
    };
    app.messages.emit({ event: "ready", cache });
    assert.equal(doc.getElementById("cache-size").textContent, "缓存 2.0 MB");
    assert.match(doc.getElementById("clear-cache").title, /paper-sidecar/);
    doc.getElementById("question").value = "Explain the method";
    doc
      .getElementById("composer")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    await tick();
    assert.equal(doc.getElementById("clear-cache").disabled, true);
    const chat = app.sent.find((message) => message.type === "chat");
    app.messages.emit({
      event: "done",
      requestId: chat.requestId,
      paperId: "1706.03762",
      text: "The method uses attention.",
    });
    await tick();
    const history = JSON.stringify(app.saved);
    doc.getElementById("clear-cache").click();
    const cleanup = app.sent.find((message) => message.type === "clear-cache");
    assert.ok(cleanup);
    assert.equal(doc.getElementById("clear-cache").disabled, true);
    app.messages.emit({
      event: "cache-cleared",
      requestId: cleanup.requestId,
      removedBytes: cache.bytes,
      cache: { ...cache, bytes: 0 },
    });
    assert.equal(doc.getElementById("cache-size").textContent, "缓存 0.0 MB");
    assert.equal(doc.getElementById("clear-cache").disabled, false);
    assert.match(doc.getElementById("messages").textContent, /The method uses attention/);
    assert.equal(JSON.stringify(app.saved), history);
    assert.equal(
      app.sent.some((message) => message.type === "reset"),
      false,
    );
  } finally {
    app.dom.window.close();
  }
});

test("a tab's side panel stays bound to that tab's paper", async () => {
  const app = await makeSidebar({ bound: true });
  try {
    const doc = app.window.document;
    await app.activateOther();
    assert.equal(doc.getElementById("paper-id").textContent, "1706.03762");
    doc.getElementById("question").value = "Explain this paper";
    doc
      .getElementById("composer")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    await tick();
    assert.equal(app.sent.find((message) => message.type === "chat").context.paperId, "1706.03762");
  } finally {
    app.dom.window.close();
  }
});

test("model controls use real catalog tiers, persist choices and send them with the question", async () => {
  const app = await makeSidebar({ bound: true });
  try {
    const doc = app.window.document;
    const model = doc.getElementById("model-choice"),
      effort = doc.getElementById("effort-choice"),
      speed = doc.getElementById("speed-choice");
    assert.equal(model.value, "gpt-6-sol");
    assert.equal(effort.value, "medium");
    assert.equal(speed.value, "fast");
    assert.match(speed.selectedOptions[0].textContent, /1.5×/);
    assert.equal(doc.getElementById("prompt-editor").value, "沿用这份阅读指令。");
    assert.equal(doc.getElementById("settings-view").hidden, true);
    model.value = "gpt-6-astra";
    model.dispatchEvent(new app.window.Event("change"));
    assert.match(speed.selectedOptions[0].textContent, /2×/);
    effort.value = "high";
    effort.dispatchEvent(new app.window.Event("change"));
    speed.value = "standard";
    speed.dispatchEvent(new app.window.Event("change"));
    await tick();
    assert.deepEqual(app.saved.at(-1).readerOptions, {
      model: "gpt-6-astra",
      effort: "high",
      speed: "standard",
    });
    doc.getElementById("question").value = "Explain the method";
    doc
      .getElementById("composer")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    await tick();
    assert.deepEqual(structuredClone(app.sent.find((item) => item.type === "chat").settings), {
      model: "gpt-6-astra",
      effort: "high",
      speed: "standard",
    });
    assert.equal(model.disabled, true);
    assert.equal(effort.disabled, true);
    assert.equal(speed.disabled, true);
    const chat = app.sent.find((item) => item.type === "chat");
    app.messages.emit({
      event: "runtime-settings",
      requestId: chat.requestId,
      paperId: chat.context.paperId,
      settings: chat.settings,
      prompt: { ...app.settings.prompt, text: "新指令已传给模型。", revision: "updated" },
    });
    assert.equal(doc.getElementById("model").textContent, "GPT-6 Astra · high · 标准");
  } finally {
    app.dom.window.close();
  }
});

test("settings refresh adds new model choices without changing a saved selection", async () => {
  const app = await makeSidebar({ bound: true });
  try {
    const doc = app.window.document;
    const model = doc.getElementById("model-choice");
    doc.getElementById("refresh-settings").click();
    const refresh = app.sent.at(-1);
    assert.equal(refresh.type, "settings");
    app.messages.emit({
      ...app.settings,
      requestId: refresh.requestId,
      models: [
        { ...app.settings.models[1], id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        ...app.settings.models,
      ],
    });
    assert.equal(model.value, "gpt-6-sol");
    assert.ok([...model.options].some((option) => option.value === "gpt-6.1-sol"));
    model.value = "gpt-6.1-sol";
    model.dispatchEvent(new app.window.Event("change"));
    await tick();
    assert.equal(app.saved.at(-1).readerOptions.model, "gpt-6.1-sol");
    assert.match(doc.getElementById("speed-choice").selectedOptions[0].textContent, /2×/);
  } finally {
    app.dom.window.close();
  }
});

test("streaming updates only the active answer and finished answers can be copied", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    const send = doc.getElementById("send");
    assert.equal(send.disabled, true);
    doc.getElementById("question").value = "Explain the method";
    doc.getElementById("question").dispatchEvent(new app.window.Event("input"));
    assert.equal(send.disabled, false);
    doc
      .getElementById("composer")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    await tick();
    assert.equal(doc.querySelector(".message.streaming .thinking").textContent, "思考中");
    assert.equal(doc.querySelector(".message .label"), null);
    assert.equal(doc.getElementById("notice").hidden, true);
    const question = doc.querySelector(".message.user");
    const chat = app.sent.find((message) => message.type === "chat");
    const delta = (text) =>
      app.messages.emit({
        event: "delta",
        requestId: chat.requestId,
        paperId: "1706.03762",
        itemId: "one",
        text,
      });
    const frames = () => new Promise((resolve) => setTimeout(resolve, 150));
    delta("First paragraph.\n\nSecond");
    await frames();
    const body = doc.querySelector(".message.streaming .body");
    assert.match(body.textContent, /First paragraph\.\s*Second/);
    // Finished paragraphs are rendered once and kept; only the tail re-renders.
    const stable = body.querySelector(".stream-stable");
    const firstParagraph = stable.firstElementChild;
    delta(" paragraph grows");
    await frames();
    assert.equal(stable.firstElementChild, firstParagraph);
    assert.match(body.querySelector(".stream-tail").textContent, /Second paragraph grows/);
    assert.equal(doc.querySelector(".message.user"), question);
    app.messages.emit({
      event: "done",
      requestId: chat.requestId,
      paperId: "1706.03762",
      text: "Final answer",
    });
    assert.equal(doc.querySelector(".message.streaming"), null);
    assert.equal(doc.querySelectorAll(".message.assistant .copy-button").length, 1);
    assert.match(doc.querySelector(".message.assistant .body").textContent, /Final answer/);
  } finally {
    app.dom.window.close();
  }
});

test("settings edit the prompt, add third-party APIs and sign in to ChatGPT", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    const click = (id) => doc.getElementById(id).click();
    const last = (type) => app.sent.filter((message) => message.type === type).at(-1);
    assert.equal(doc.getElementById("prompt-details"), null);
    click("open-settings");
    assert.equal(doc.getElementById("settings-view").hidden, false);
    assert.ok(last("account"));
    assert.match(doc.getElementById("account-status").textContent, /me@example.com/);

    doc.getElementById("prompt-editor").value = "像审稿人一样回答。";
    click("prompt-save");
    const savePrompt = last("save-prompt");
    assert.equal(savePrompt.text, "像审稿人一样回答。");
    app.messages.emit({
      event: "user-settings",
      requestId: savePrompt.requestId,
      prompt: { name: "自定义提示词", text: "像审稿人一样回答。", custom: true },
      providers: [],
    });
    assert.equal(doc.getElementById("prompt-saved").textContent, "已保存");
    assert.equal(doc.getElementById("prompt-reset").disabled, false);

    click("provider-add");
    assert.equal(doc.getElementById("provider-url").value, "https://api.deepseek.com");
    doc.getElementById("provider-key").value = "sk-secret";
    doc.getElementById("provider-models").value = "deepseek-chat";
    doc
      .getElementById("provider-form")
      .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
    const saveProvider = last("save-provider");
    assert.equal(saveProvider.provider.apiKey, "sk-secret");
    assert.equal(saveProvider.provider.kind, "openai");
    const provider = {
      id: "p1",
      name: "DeepSeek",
      kind: "openai",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-chat"],
      vision: false,
      keyHint: "sk-…cret",
    };
    app.messages.emit({
      event: "user-settings",
      requestId: saveProvider.requestId,
      prompt: { text: "像审稿人一样回答。", custom: true },
      providers: [provider],
    });
    assert.equal(doc.getElementById("provider-form").hidden, true);
    assert.match(doc.getElementById("provider-list").textContent, /DeepSeek.*sk-…cret/);
    const refresh = last("settings");
    app.messages.emit({
      ...app.settings,
      requestId: refresh.requestId,
      models: [
        ...app.settings.models.map((model) => ({ ...model, group: "ChatGPT 账号" })),
        {
          id: "api:p1:deepseek-chat",
          name: "deepseek-chat",
          group: "DeepSeek",
          provider: "p1",
          efforts: [],
          serviceTiers: [],
        },
      ],
      providers: [provider],
    });
    const model = doc.getElementById("model-choice");
    assert.deepEqual(
      [...model.querySelectorAll("optgroup")].map((group) => group.label),
      ["ChatGPT 账号", "DeepSeek"],
    );
    model.value = "api:p1:deepseek-chat";
    model.dispatchEvent(new app.window.Event("change"));
    assert.equal(doc.getElementById("effort-choice").value, "default");
    assert.equal(doc.getElementById("speed-choice").value, "standard");
    assert.equal(doc.getElementById("effort-choice").disabled, true);

    click("logout");
    const logout = last("logout");
    app.messages.emit({
      event: "account",
      requestId: logout.requestId,
      account: null,
      requiresOpenaiAuth: true,
    });
    assert.equal(doc.getElementById("account-status").textContent, "未登录");
    assert.equal(last("settings").requestId !== refresh.requestId, true);
    click("login-chatgpt");
    const login = last("login");
    assert.equal(login.method, "chatgpt");
    app.messages.emit({
      event: "login-started",
      requestId: login.requestId,
      type: "chatgpt",
      loginId: "L1",
      authUrl: "https://auth.openai.com/oauth?x=1",
    });
    await tick();
    // A popup window, not a tab: switching tabs would close this panel and the
    // local sign-in callback server with it.
    const popup = app.created[0];
    assert.equal(popup.url, "https://auth.openai.com/oauth?x=1");
    assert.equal(popup.type, "popup");
    assert.equal(doc.getElementById("login-pending").hidden, false);
    app.messages.emit({
      event: "account-changed",
      method: "account/login/completed",
      success: true,
    });
    assert.equal(doc.getElementById("login-pending").hidden, true);
    assert.equal(app.created.at(-1).removed, 77);

    doc
      .getElementById("settings-view")
      .dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(doc.getElementById("settings-view").hidden, true);
  } finally {
    app.dom.window.close();
  }
});

test("papers answer independently, share history across versions and restore archives", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    const ask = async (text) => {
      doc.getElementById("question").value = text;
      doc
        .getElementById("composer")
        .dispatchEvent(new app.window.Event("submit", { cancelable: true }));
      await tick();
      return app.sent.filter((message) => message.type === "chat").at(-1);
    };
    const chatA = await ask("Question about A");
    assert.equal(doc.getElementById("stop").hidden, false);

    // While A is still answering, paper B is fully usable and unaffected by A's stream.
    await app.navigate("2401.12345", "Paper B");
    assert.equal(doc.getElementById("stop").hidden, true);
    assert.equal(doc.getElementById("send").hidden, false);
    app.messages.emit({
      event: "delta",
      requestId: chatA.requestId,
      paperId: "1706.03762",
      itemId: "a",
      text: "Streaming A",
    });
    assert.doesNotMatch(doc.getElementById("messages").textContent, /Streaming A/);
    const chatB = await ask("Question about B");
    assert.notEqual(chatB.requestId, chatA.requestId);
    doc.getElementById("stop").click();
    assert.equal(app.sent.at(-1).type, "cancel");
    assert.equal(app.sent.at(-1).paperId, "2401.12345");
    app.messages.emit({
      event: "done",
      requestId: chatB.requestId,
      paperId: "2401.12345",
      text: "B done",
    });

    // Another version of paper A shows A's conversation and A's still-running answer.
    await app.navigate("1706.03762v7", "Paper A v7");
    assert.match(doc.getElementById("messages").textContent, /Question about A.*Streaming A/s);
    assert.equal(doc.getElementById("stop").hidden, false);
    app.messages.emit({
      event: "done",
      requestId: chatA.requestId,
      paperId: "1706.03762",
      text: "A done",
    });
    await tick();
    assert.equal(app.saved.at(-1).library["1706.03762"].messages.at(-1).text, "A done");

    // "＋" archives the conversation; the history menu restores it.
    assert.equal(doc.getElementById("history").disabled, true);
    doc.getElementById("reset").click();
    const reset = app.sent.at(-1);
    app.messages.emit({ event: "reset", requestId: reset.requestId, paperId: "1706.03762v7" });
    assert.equal(doc.querySelectorAll(".message").length, 0);
    assert.equal(doc.getElementById("history").disabled, false);
    doc.getElementById("history").click();
    assert.equal(doc.getElementById("history-menu").hidden, false);
    assert.match(doc.getElementById("history-list").textContent, /Question about A/);
    doc.querySelector(".history-open").click();
    const restore = app.sent.at(-1);
    assert.equal(restore.type, "reset");
    assert.equal(restore.restore, true);
    app.messages.emit({
      event: "reset",
      requestId: restore.requestId,
      paperId: "1706.03762v7",
      restore: true,
    });
    await tick();
    assert.match(doc.getElementById("messages").textContent, /A done/);
    assert.equal(doc.getElementById("history-menu").hidden, true);
    assert.equal(app.saved.at(-1).library["1706.03762"].archives.length, 0);
  } finally {
    app.dom.window.close();
  }
});

test("in the browser PDF viewer the real title is loaded from the PDF right away", async () => {
  const app = await makeSidebar();
  try {
    const doc = app.window.document;
    await app.navigate("2401.12345", "2401.12345");
    const load = app.sent.filter((message) => message.type === "load").at(-1);
    assert.equal(load.context.paperId, "2401.12345");
    app.messages.emit({
      event: "paper",
      requestId: load.requestId,
      paperId: "2401.12345",
      title: "Distributionally Robust Receive Combining",
      pageCount: 12,
      hasTextLayer: true,
      pdfUrl: "https://arxiv.org/pdf/2401.12345",
    });
    assert.equal(
      doc.getElementById("paper-title").textContent,
      "Distributionally Robust Receive Combining",
    );
    await app.navigate("2401.12345", "2401.12345");
    assert.equal(
      app.sent.filter(
        (message) => message.type === "load" && message.context.paperId === "2401.12345",
      ).length,
      1,
    );
    assert.equal(
      doc.getElementById("paper-title").textContent,
      "Distributionally Robust Receive Combining",
    );
  } finally {
    app.dom.window.close();
  }
});

test("the footer shows ChatGPT plan usage, and the in-page panel can ask to close", async () => {
  const app = await makeSidebar({ bound: true });
  try {
    const doc = app.window.document;
    // makeSidebar signs in with a ChatGPT account, so the quota is requested.
    const quota = app.sent.filter((message) => message.type === "quota").at(-1);
    assert.ok(quota);
    app.messages.emit({
      event: "quota",
      requestId: quota.requestId,
      windows: [
        { minutes: 300, usedPercent: 23.4, resetsAt: 1793260000 },
        { minutes: 10080, usedPercent: 41, resetsAt: null },
      ],
    });
    assert.equal(doc.getElementById("quota").textContent, "额度 5h 23% · 周 41%");
    assert.match(doc.getElementById("quota").title, /5h窗口已用 23%/);
    app.messages.emit({ event: "quota", windows: [], reached: "rate_limit" });
    assert.equal(doc.getElementById("quota").textContent, "额度已用完");
    assert.equal(doc.getElementById("close-panel").hidden, true);
  } finally {
    app.dom.window.close();
  }
});
