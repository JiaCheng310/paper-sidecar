import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createConversationStore } from "./conversation-store.js";

const conversations = createConversationStore(chrome.storage.local);
const PAPER_SITE = /^https:\/\/(www\.)?(alphaxiv|arxiv)\.org\//;
const CONTENT_SCRIPTS = ["reader-view.js", "content.js"];
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
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
  reply({ paperId, tabId: sender.tab.id, pdfUrl: paperId ? pdfUrlForPaper(paperId, links) : null });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    message.type !== "open-side-panel" ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id)
  )
    return;
  const tabId = sender.tab.id;
  // open() must run synchronously inside the click's user gesture; enabling first would
  // break the gesture, so the tab is configured beforehand by onUpdated.
  chrome.sidePanel.open({ tabId }).catch(() => {});
  void configurePanel(tabId, sender.tab.url);
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
