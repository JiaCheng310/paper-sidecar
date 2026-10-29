import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createConversationStore } from "./conversation-store.js";

const conversations = createConversationStore(chrome.storage.local);
const PAPER_SITE = /^https:\/\/(www\.)?(alphaxiv|arxiv)\.org\//;

// The side panel belongs to one alphaXiv/arXiv tab. Other sites never show it, and
// switching tabs never carries a conversation over to a different page.
async function configurePanel(tabId, url) {
  try {
    if (PAPER_SITE.test(url || "")) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: `sidepanel.html?tabId=${tabId}`,
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch {
    /* The tab may have closed in the meantime. */
  }
}

async function initialize() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: false });
  // Without the "tabs" permission, URLs are visible only on the paper sites themselves.
  for (const tab of await chrome.tabs.query({})) await configurePanel(tab.id, tab.url);
}

chrome.runtime.onInstalled.addListener(() => void initialize());
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
