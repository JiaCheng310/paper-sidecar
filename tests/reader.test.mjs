import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { paperIdFromUrl, pdfUrlForPaper } from "../extension/paper-context.js";
import { createConversationStore } from "../extension/conversation-store.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const extensionId = "testextension";
const extensionOrigin = `chrome-extension://${extensionId}`;
const manifest = JSON.parse(
  await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
);
const contentSource = (
  await Promise.all(
    manifest.content_scripts[0].js.map((path) =>
      readFile(new URL(`../extension/${path}`, import.meta.url), "utf8"),
    ),
  )
).join("\n");
const backgroundSource = (
  await readFile(new URL("../extension/background.js", import.meta.url), "utf8")
).replace(/^import .*\n/gm, "");

function backgroundHandler() {
  const handlers = [];
  let stored = {};
  const browser = {
    runtime: {
      id: extensionId,
      getURL: (path) => `${extensionOrigin}/${path}`,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener) {
          handlers.push(listener);
        },
      },
    },
    tabs: { onUpdated: { addListener() {} }, query: async () => [] },
    sidePanel: {
      setOptions: async () => {},
      setPanelBehavior: async () => {},
      open: async () => {},
    },
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          stored = structuredClone(value);
        },
      },
    },
    sidePanel: { setPanelBehavior() {} },
  };
  new Function(
    "chrome",
    "paperIdFromUrl",
    "pdfUrlForPaper",
    "createConversationStore",
    backgroundSource,
  )(browser, paperIdFromUrl, pdfUrlForPaper, createConversationStore);
  return (...args) => handlers.forEach((handler) => handler(...args));
}

async function makeReader(path = "/abs/1706.03762v7", layout = "docked") {
  const floating = layout === "floating";
  const dom = new JSDOM(
    `
    <main id="paper"><h1>Paper A</h1><a href="https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf">PDF</a>
      <iframe id="original-pdf" src="https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"></iframe></main>
    ${floating ? '<section id="popout-assistant-panel" style="position:fixed;z-index:50">' : '<aside aria-label="Paper workspace">'}
    <div id="native-panel" ${floating ? 'aria-hidden="true" inert' : ""}>
      <header><h2>Assistant</h2><div><button aria-label="Close assistant">Close</button></div></header>
      <div role="region" aria-label="Assistant"><textarea aria-label="Assistant">Original draft</textarea></div>
    </div><button aria-label="Ask the assistant">Ask</button>${floating ? "</section>" : "</aside>"}`,
    { runScripts: "outside-only", url: `https://www.alphaxiv.org${path}` },
  );
  const { window } = dom;
  let poll;
  window.setInterval = (callback) => {
    poll = callback;
    return 0;
  };
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.closest("[hidden]")
      ? { left: 0, top: 0, width: 0, height: 0 }
      : { left: 700, top: 52, width: 500, height: 700 };
  };
  const panel = window.document.getElementById("native-panel");
  function setCollapsed(collapsed) {
    if (floating) {
      // The live popout preserves its inner size while aria-hidden/inert hides it.
      panel.setAttribute("aria-hidden", String(collapsed));
      panel.toggleAttribute("inert", collapsed);
    } else panel.hidden = collapsed;
  }
  window.document.querySelector('[aria-label="Close assistant"]').onclick = () => {
    setCollapsed(true);
  };
  window.document.querySelector('[aria-label="Ask the assistant"]').onclick = () => {
    setCollapsed(false);
  };
  const handle = backgroundHandler();
  let stored = {};
  window.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          stored = { ...stored, ...value };
        },
      },
    },
    runtime: {
      getURL: (path) => `${extensionOrigin}/${path}`,
      onMessage: { addListener() {} },
      sendMessage: async (message) =>
        new Promise((resolve) =>
          handle(
            message,
            {
              id: extensionId,
              frameId: 0,
              url: window.location.href,
              tab: { id: 10, url: window.location.href },
            },
            resolve,
          ),
        ),
    },
  };
  window.eval(contentSource);
  const settle = () => new Promise((resolve) => window.setTimeout(resolve, 15));
  await settle();
  const host = window.document.getElementById("paper-sidecar-root");
  return {
    dom,
    window,
    host,
    root: host.shadowRoot,
    panel,
    settle,
    provider: () => window.document.querySelector('[data-paper-sidecar="provider"]')?.shadowRoot,
    async select(provider) {
      this.provider().querySelector(`[data-provider="${provider}"]`).click();
      await settle();
    },
    async navigate(path, title) {
      window.history.pushState({}, "", path);
      window.document.querySelector("h1").textContent = title;
      poll();
      await settle();
    },
  };
}

test("Codex replaces only the native Assistant body and restores the original draft", async () => {
  const app = await makeReader();
  try {
    const doc = app.window.document;
    const pdf = doc.getElementById("original-pdf"),
      pdfUrl = pdf.src;
    const body = doc.querySelector('div[aria-label="Assistant"]');
    const frame = app.root.querySelector("iframe");
    assert.equal(frame.hasAttribute("src"), false);
    await app.select("codex");
    assert.equal(frame.hidden, false);
    assert.equal(body.style.visibility, "hidden");
    assert.equal(frame.style.left, "700px");
    assert.equal(new URL(frame.src).searchParams.get("tabId"), "10");
    const chatUrl = frame.src;
    assert.equal(app.root.querySelector("dialog"), null);
    assert.equal(doc.getElementById("original-pdf"), pdf);
    assert.equal(pdf.src, pdfUrl);
    assert.equal(app.window.location.pathname, "/abs/1706.03762v7");
    await app.select("alphaxiv");
    assert.equal(frame.hidden, true);
    assert.equal(body.style.visibility, "");
    assert.equal(body.getAttribute("aria-hidden"), null);
    assert.equal(body.querySelector("textarea").value, "Original draft");
    await app.select("codex");
    assert.equal(frame.src, chatUrl);
    assert.equal(pdf.src, pdfUrl);
  } finally {
    app.dom.window.close();
  }
});

test("native collapse and reopen keep the Codex frame; only that frame can request collapse", async () => {
  const app = await makeReader();
  try {
    await app.select("codex");
    const frame = app.root.querySelector("iframe"),
      chatUrl = frame.src;
    app.window.dispatchEvent(
      new app.window.MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://www.alphaxiv.org",
        data: { type: "paper-sidecar-collapse" },
      }),
    );
    await app.settle();
    assert.equal(app.panel.hidden, false);
    app.window.dispatchEvent(
      new app.window.MessageEvent("message", {
        source: frame.contentWindow,
        origin: extensionOrigin,
        data: { type: "paper-sidecar-collapse" },
      }),
    );
    await app.settle();
    assert.equal(app.panel.hidden, true);
    assert.equal(frame.hidden, true);
    assert.equal(frame.src, chatUrl);
    app.window.document.querySelector('[aria-label="Ask the assistant"]').click();
    await app.settle();
    assert.equal(frame.hidden, false);
    assert.equal(frame.src, chatUrl);
  } finally {
    app.dom.window.close();
  }
});

test("the live floating Assistant exposes Codex and remains hidden while its parent is collapsed", async () => {
  const app = await makeReader("/abs/1706.03762v7", "floating");
  try {
    const doc = app.window.document;
    const frame = app.root.querySelector("iframe");
    const editor = doc.querySelector("textarea");
    editor.remove();
    await app.settle();
    assert.equal(doc.querySelector('[aria-label="Paper workspace"]'), null);
    assert.equal(frame.hidden, true);
    doc.querySelector('[aria-label="Ask the assistant"]').click();
    await app.settle();
    assert.ok(app.provider(), "the floating Assistant needs the provider switch too");
    doc.querySelector('[role="region"][aria-label="Assistant"]').append(editor);
    await app.settle();
    await app.select("codex");
    assert.equal(frame.hidden, false);
    assert.equal(app.host.style.zIndex, "50");
    const chatUrl = frame.src;
    doc.querySelector('[aria-label="Close assistant"]').click();
    await app.settle();
    assert.equal(frame.hidden, true, "a collapsed popout still has a nonzero inner rectangle");
    assert.equal(frame.src, chatUrl);
    doc.querySelector('[aria-label="Ask the assistant"]').click();
    await app.settle();
    assert.equal(frame.hidden, false);
    assert.equal(frame.src, chatUrl);
    await app.select("alphaxiv");
    assert.equal(doc.querySelector("textarea").value, "Original draft");
  } finally {
    app.dom.window.close();
  }
});

test("paper navigation follows the source tab and unsupported pages restore the site", async () => {
  const app = await makeReader();
  try {
    await app.select("codex");
    const frame = app.root.querySelector("iframe"),
      chatUrl = frame.src;
    await app.navigate("/pdf/2401.12345v2", "Paper B");
    assert.equal(frame.hidden, false);
    assert.equal(frame.src, chatUrl);
    await app.navigate("/explore", "Explore");
    assert.equal(frame.hasAttribute("src"), false);
    assert.equal(app.provider(), undefined);
    assert.equal(
      app.window.document.querySelector('div[aria-label="Assistant"]').style.visibility,
      "",
    );
  } finally {
    app.dom.window.close();
  }
});

test("only the extension chat page can save conversations through the background worker", async () => {
  const handle = backgroundHandler();
  const request = {
    type: "save-conversation",
    paperId: "1706.03762",
    expectedRevision: 0,
    conversation: { messages: [{ role: "user", text: "Keep this question" }], archives: [] },
  };
  let response;
  for (const sender of [
    { id: extensionId, url: "https://www.alphaxiv.org/abs/1706.03762" },
    { id: "another-extension", url: `${extensionOrigin}/sidepanel.html` },
    { id: extensionId, url: `${extensionOrigin}/sidepanel.html.fake` },
  ])
    handle(request, sender, (value) => {
      response = value;
    });
  await tick();
  assert.equal(response, undefined);
  handle(
    request,
    { id: extensionId, url: `${extensionOrigin}/sidepanel.html?embedded=1&tabId=10` },
    (value) => {
      response = value;
    },
  );
  await tick();
  assert.equal(response.ok, true);
  assert.equal(response.revision, 1);
});
