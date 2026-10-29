import { paperIdFromUrl, pdfUrlForPaper } from "./paper-context.js";
import { createConversationStore } from "./conversation-store.js";

const conversations = createConversationStore(chrome.storage.local);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
