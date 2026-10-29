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
  const prefetches = [];
  const options = [];
  let actionClick = null;
  let stored = {};
  const browser = {
    runtime: {
      id: extensionId,
      getURL: (path) => `${extensionOrigin}/${path}`,
      connectNative: () => {
        const listeners = [];
        return {
          onMessage: { addListener: (listener) => listeners.push(listener) },
          onDisconnect: { addListener() {} },
          postMessage: (message) => {
            prefetches.push(message);
            listeners.forEach((listener) => listener({ event: "paper" }));
          },
          disconnect() {},
        };
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener) {
          handlers.push(listener);
        },
      },
    },
    tabs: { onUpdated: { addListener() {} }, query: async () => [] },
    action: {
      onClicked: { addListener: (listener) => (actionClick = listener) },
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    sidePanel: {
      setOptions: async (value) => options.push(value),
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
  handle.prefetches = prefetches;
  handle.options = options;
  handle.clickAction = (tab) => actionClick(tab);
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
      id: extensionId,
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

test("the icon opens a wide in-page panel bound to its tab, and only that frame can close it", async () => {
  for (const origin of ["https://www.alphaxiv.org", "https://arxiv.org"]) {
    const app = await makeReader("/abs/1706.03762v7", "docked", origin);
    try {
      const { window } = app;
      app.launcher().click();
      const panel = app.root.querySelector(".panel");
      const frame = panel.querySelector("iframe");
      assert.equal(panel.hidden, false);
      assert.equal(app.launcher().hidden, true);
      const url = new URL(frame.src);
      assert.equal(url.pathname, "/sidepanel.html");
      assert.equal(url.searchParams.get("tabId"), "10");
      assert.equal(url.searchParams.get("parent"), origin);
      // About a third of the window, and the page is narrowed by the same width.
      const width = parseInt(panel.style.width);
      assert.ok(width >= 380 && width <= 600);
      assert.equal(window.document.documentElement.style.marginRight, `${width}px`);
      // Messages from anything but the panel frame are ignored.
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "paper-sidecar-close" },
          origin,
          source: window,
        }),
      );
      assert.equal(panel.hidden, false);
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "paper-sidecar-close" },
          origin: extensionOrigin,
          source: frame.contentWindow,
        }),
      );
      assert.equal(panel.hidden, true);
      assert.equal(app.launcher().hidden, false);
      assert.equal(window.document.documentElement.style.marginRight, "");
      // Reopening keeps the same frame (and conversation); leaving the paper unloads it.
      app.launcher().click();
      assert.equal(panel.querySelector("iframe"), frame);
      await app.navigate("/explore", "Explore");
      assert.equal(panel.hidden, true);
      assert.equal(panel.querySelector("iframe"), null);
    } finally {
      app.dom.window.close();
    }
  }
});

test("the icon has a fixed spot: above alphaXiv's corner buttons, in arXiv's corner", async () => {
  for (const [origin, bottom, right] of [
    ["https://www.alphaxiv.org", "222px", "23px"],
    ["https://arxiv.org", "24px", "24px"],
  ]) {
    const app = await makeReader("/abs/1706.03762v7", "docked", origin);
    try {
      const { window } = app;
      assert.equal(app.launcher().hidden, false);
      assert.equal(app.launcher().style.bottom, bottom);
      assert.equal(app.launcher().style.right, right);
      // Nothing on the page, scrolling or resizing ever moves it.
      window.dispatchEvent(new window.Event("resize"));
      window.document.dispatchEvent(new window.Event("selectionchange"));
      await app.navigate("/abs/2401.12345", "Paper B");
      assert.equal(app.launcher().style.bottom, bottom);
      assert.equal(app.launcher().style.right, right);
    } finally {
      app.dom.window.close();
    }
  }
});

test("an orphaned script removes its icon, and a new script hides stale ones", async () => {
  const app = await makeReader();
  try {
    const { window } = app;
    // Simulate an extension reload: the old script loses its runtime.
    const runtime = window.chrome.runtime;
    window.chrome.runtime = {};
    window.document.dispatchEvent(new window.Event("selectionchange"));
    assert.equal(window.document.getElementById("paper-sidecar-root"), null);
    // A leftover icon from an older version is hidden by the next script.
    const stale = window.document.createElement("div");
    stale.id = "paper-sidecar-root";
    window.document.body.append(stale);
    window.chrome.runtime = runtime;
    window.eval(contentSource);
    await app.settle();
    assert.equal(stale.style.display, "none");
    assert.notEqual(stale.id, "paper-sidecar-root");
    assert.ok(window.document.getElementById("paper-sidecar-root"));
  } finally {
    app.dom.window.close();
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

test("selecting text shows an Ask bubble that opens the panel with the quote", async () => {
  const app = await makeReader();
  try {
    const { window } = app;
    const document = window.document;
    const ask = app.root.querySelector(".ask");
    // Select a phrase in the paper text.
    const heading = document.querySelector("h1");
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.getClientRects = () => [{ top: 100, bottom: 120, left: 200, right: 400 }];
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await app.settle();
    assert.equal(ask.hidden, false);
    assert.equal(ask.style.top, "128px");
    // Typing in the site's own text box never offers the bubble.
    const draft = document.querySelector("textarea");
    window.getSelection().removeAllRanges();
    const inField = document.createRange();
    inField.selectNodeContents(draft);
    window.getSelection().addRange(inField);
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await app.settle();
    assert.equal(ask.hidden, true);
    // Ask about the heading: the panel opens and the quote waits for the panel to be ready.
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await app.settle();
    ask.click();
    const panel = app.root.querySelector(".panel");
    const frame = panel.querySelector("iframe");
    assert.equal(panel.hidden, false);
    assert.equal(ask.hidden, true);
    const delivered = [];
    // jsdom gives frames inside a shadow root no window; stand one in.
    const frameWindow = { postMessage: (message, origin) => delivered.push({ message, origin }) };
    Object.defineProperty(frame, "contentWindow", { value: frameWindow });
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "paper-sidecar-ready" },
        origin: extensionOrigin,
        source: frameWindow,
      }),
    );
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].message.type, "paper-sidecar-quote");
    assert.equal(delivered[0].message.text, "Paper A");
    assert.equal(delivered[0].origin, extensionOrigin);
  } finally {
    app.dom.window.close();
  }
});

test("opening a paper page prefetches its PDF once, from arXiv", async () => {
  const app = await makeReader();
  try {
    const loads = app.handle.prefetches;
    assert.equal(loads.length, 1);
    assert.equal(loads[0].type, "load");
    assert.equal(loads[0].context.paperId, "1706.03762v7");
    assert.equal(loads[0].context.pdfUrl, "https://arxiv.org/pdf/1706.03762v7");
    await app.navigate("/abs/2401.12345", "Paper B");
    await app.navigate("/abs/1706.03762v7", "Paper A");
    assert.deepEqual(
      loads.map((load) => load.context.paperId),
      ["1706.03762v7", "2401.12345"],
    );
  } finally {
    app.dom.window.close();
  }
});

test("the toolbar icon opens the side panel on any paper tab, including arXiv's PDF view", () => {
  const handle = backgroundHandler();
  handle.clickAction({ id: 5, url: "https://arxiv.org/pdf/2507.07955" });
  assert.deepEqual(handle.options.at(-1), {
    tabId: 5,
    path: "sidepanel.html?tabId=5",
    enabled: true,
  });
  assert.deepEqual(handle.opened.at(-1), { tabId: 5 });
  // Not a paper: nothing opens.
  handle.clickAction({ id: 6, url: "https://en.wikipedia.org/wiki/ArXiv" });
  assert.equal(handle.opened.length, 1);
});

test("in the browser's PDF viewer the PDF itself is narrowed, and restored on close", async () => {
  const app = await makeReader();
  try {
    const { window } = app;
    const viewer = window.document.createElement("embed");
    viewer.setAttribute("type", "application/pdf");
    viewer.style.width = "100%";
    window.document.body.append(viewer);
    app.launcher().click();
    const width = parseInt(app.root.querySelector(".panel").style.width);
    assert.equal(viewer.style.width, `calc(100% - ${width}px)`);
    assert.equal(viewer.style.getPropertyPriority("width"), "important");
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "paper-sidecar-close" },
        origin: extensionOrigin,
        source: app.root.querySelector("iframe").contentWindow,
      }),
    );
    assert.equal(viewer.style.width, "100%");
    assert.equal(viewer.style.getPropertyPriority("width"), "");
    assert.equal(window.document.documentElement.style.marginRight, "");
  } finally {
    app.dom.window.close();
  }
});

test("a narrowed page left by a reloaded extension is restored by the next script", async () => {
  const app = await makeReader();
  try {
    const { window } = app;
    const document = window.document;
    const viewer = document.createElement("embed");
    viewer.setAttribute("type", "application/pdf");
    document.body.append(viewer);
    app.launcher().click();
    assert.match(viewer.style.width, /calc/);
    assert.match(document.documentElement.style.marginRight, /px/);
    // The extension is reloaded while the panel is open: the old script disappears without
    // closing anything, and a new one starts.
    document.getElementById("paper-sidecar-root").remove();
    window.eval(contentSource);
    await app.settle();
    assert.equal(viewer.style.width, "");
    assert.equal(document.documentElement.style.marginRight, "");
    assert.equal(document.querySelector("[data-paper-sidecar-saved]"), null);
  } finally {
    app.dom.window.close();
  }
});
