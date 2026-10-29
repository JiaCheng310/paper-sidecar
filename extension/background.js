import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createConversationStore } from "./conversation-store.js";

const conversations = createConversationStore(chrome.storage.local);
const PAPER_SITE = /^https:\/\/(www\.)?(alphaxiv|arxiv)\.org\//;
const CONTENT_SCRIPTS = ["reader-view.js", "content.js"];
const HOST = "org.local.paper_sidecar";

// Download, check and cache a paper's PDF as soon as its page opens, so the panel and the
// first question never wait for it. This uses no model quota. Once per paper per session.
const prefetched = new Set();
function prefetchPdf(paperId, url, pdfUrl) {
  if (prefetched.has(paperId)) return;
  prefetched.add(paperId);
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    return;
  }
  const finish = () => {
    clearTimeout(timer);
    try {
      port.disconnect();
    } catch {
      /* Already closed. */
    }
  };
  const timer = setTimeout(finish, 120000);
  port.onMessage.addListener((message) => {
    if (message.event === "paper" || message.event === "error") finish();
  });
  port.onDisconnect.addListener(() => {
    clearTimeout(timer);
    void chrome.runtime.lastError; // Not installed yet: the panel explains how to fix it.
  });
  port.postMessage({
    type: "load",
    requestId: "prefetch",
    context: { paperId, url, pdfUrl, title: "" },
  });
}
// The browser's PDF viewer does not run content scripts, so the floating icon cannot
// appear there; a badge on the toolbar icon points to the side panel instead.
const PDF_VIEWER = /^https:\/\/(www\.)?arxiv\.org\/pdf\//;

// The side panel belongs to one paper tab. Any other page (another site, or a non-paper
// page such as alphaXiv's home) closes it, and switching tabs never mixes conversations.
async function configurePanel(tabId, url) {
  try {
    if (url && paperIdFromUrl(url)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: `sidepanel.html?tabId=${tabId}`,
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
    const pdf = PDF_VIEWER.test(url || "");
    await chrome.action.setBadgeText({ tabId, text: pdf ? "AI" : "" });
    if (pdf) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a51f39" });
  } catch {
    /* The tab may have closed in the meantime. */
  }
}

async function initialize(reinject = false) {
  // The toolbar click is handled below, so a paper tab's panel always opens even if the
  // browser missed enabling it earlier (e.g. tabs that were open before a reload).
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
  // Without the "tabs" permission, URLs are visible only on the paper sites themselves.
  for (const tab of await chrome.tabs.query({})) {
    await configurePanel(tab.id, tab.url);
    // Reloading the extension orphans the scripts already running in open tabs; replace them
    // so the page never keeps a stale icon until it is refreshed.
    if (reinject && PAPER_SITE.test(tab.url || ""))
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS })
        .catch(() => {});
  }
}

// Only a fresh install or a reload of the extension leaves pages without a live script.
chrome.runtime.onInstalled.addListener(
  ({ reason }) => void initialize(reason === "install" || reason === "update"),
);
chrome.runtime.onStartup.addListener(() => void initialize());
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab?.id) || !paperIdFromUrl(tab.url || "")) return;
  // Both calls are made inside the click, without awaiting in between: open() needs the
  // user gesture, and the browser applies the options before opening.
  void chrome.sidePanel
    .setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true })
    .catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === "loading") void configurePanel(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message.type !== "paper-reader-state" ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id)
  )
    return;
  const paperId = paperIdFromUrl(sender.url || sender.tab.url);
  const links = Array.isArray(message.pdfLinks)
    ? message.pdfLinks.filter((link) => typeof link === "string").slice(0, 100)
    : [];
  const pdfUrl = paperId ? pdfUrlForPaper(paperId, links) : null;
  if (paperId) prefetchPdf(paperId, sender.url || sender.tab.url, pdfUrl);
  reply({ paperId, tabId: sender.tab.id, pdfUrl });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message.type !== "save-conversation" ||
    sender.id !== chrome.runtime.id ||
    sender.url?.split("?")[0] !== chrome.runtime.getURL("sidepanel.html")
  )
    return;
  conversations.save(message).then(
    (result) => reply({ ok: true, ...result }),
    (error) => reply({ ok: false, error: error.message }),
  );
  return true;
});
