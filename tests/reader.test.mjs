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
  const opened = [];
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
      open: async (options) => opened.push(options),
    },
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          stored = structuredClone(value);
        },
      },
    },
  };
  new Function(
    "chrome",
    "paperIdFromUrl",
    "pdfUrlForPaper",
    "createConversationStore",
    backgroundSource,
  )(browser, paperIdFromUrl, pdfUrlForPaper, createConversationStore);
  const handle = (...args) => handlers.forEach((handler) => handler(...args));
  handle.opened = opened;
  return handle;
}

async function makeReader(
  path = "/abs/1706.03762v7",
  layout = "docked",
  origin = "https://www.alphaxiv.org",
) {
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
    { runScripts: "outside-only", url: `${origin}${path}` },
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
    handle,
    launcher: () => host.shadowRoot.querySelector(".launcher"),
    async navigate(path, title) {
      window.history.pushState({}, "", path);
      window.document.querySelector("h1").textContent = title;
      poll();
      await settle();
    },
  };
}

test("paper pages get only a floating icon; the site's own assistant is untouched", async () => {
  for (const layout of ["docked", "floating"]) {
    const app = await makeReader("/abs/1706.03762v7", layout);
    try {
      const document = app.window.document;
      assert.equal(app.launcher().hidden, false);
      assert.equal(app.root.querySelector("iframe"), null);
      assert.equal(document.querySelector('[data-paper-sidecar="provider"]'), null);
      const body = document.querySelector('div[aria-label="Assistant"]');
      assert.equal(body.style.visibility, "");
      assert.equal(body.hasAttribute("aria-hidden"), false);
      assert.equal(body.hasAttribute("inert"), false);
      assert.equal(document.querySelector("textarea").value, "Original draft");
      assert.equal(
        document.getElementById("original-pdf").src,
        "https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf",
      );
    } finally {
      app.dom.window.close();
    }
  }
});

test("the icon opens the side panel for its own tab, on alphaXiv and arXiv", async () => {
  for (const origin of ["https://www.alphaxiv.org", "https://arxiv.org"]) {
    const app = await makeReader("/abs/1706.03762v7", "docked", origin);
    try {
      app.launcher().click();
      await app.settle();
      assert.equal(JSON.stringify(app.handle.opened), JSON.stringify([{ tabId: 10 }]));
    } finally {
      app.dom.window.close();
    }
  }
});

test("the icon follows in-site navigation and hides away from paper pages", async () => {
  const app = await makeReader();
  try {
    await app.navigate("/pdf/2401.12345v2", "Paper B");
    assert.equal(app.launcher().hidden, false);
    await app.navigate("/explore", "Explore");
    assert.equal(app.launcher().hidden, true);
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
    { id: extensionId, url: `${extensionOrigin}/sidepanel.html?tabId=10` },
    (value) => {
      response = value;
    },
  );
  await tick();
  assert.equal(response.ok, true);
  assert.equal(response.revision, 1);
});
