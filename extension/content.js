(() => {
  // A script left behind by a reloaded extension may still own an icon; hide it for good.
  // (Removing it would only make the orphaned script append it again.)
  for (const stale of document.querySelectorAll(`#${PaperSidecarReader.rootId}`)) {
    stale.style.setProperty("display", "none", "important");
    stale.id = `${PaperSidecarReader.rootId}-stale`;
  }
  const reader = PaperSidecarReader.create();
  let lastSelection = "";
  let lastUrl = location.href;
  let stateRequest = 0;
  const isArxiv = /(^|\.)arxiv\.org$/.test(location.hostname);

  function pageContext() {
    const citation = document.querySelector('meta[name="citation_title"]')?.content?.trim();
    const heading = document.querySelector("h1")?.textContent?.trim();
    // arXiv's first <h1> is the subject breadcrumb; alphaXiv navigates client-side, where
    // the <h1> follows the current paper but the citation meta tag may lag behind.
    const title =
      (isArxiv ? citation : heading) ||
      citation ||
      heading ||
      document.title.replace(/\s*[|–]\s*alphaXiv.*$/i, "").replace(/^\[[^\]]+\]\s*/, "");
    const links = [...document.querySelectorAll("a[href]")].map((link) => link.href);
    const citationPdf = document.querySelector('meta[name="citation_pdf_url"]')?.content;
    if (citationPdf) links.unshift(citationPdf);
    return {
      url: location.href,
      title,
      pdfLinks: links.filter((link) => /\.pdf(?:$|[?#])|arxiv\.org\/pdf\//.test(link)),
      selection: lastSelection,
    };
  }

  async function refreshPaper() {
    const request = ++stateRequest;
    const data = pageContext();
    const state = await chrome.runtime.sendMessage({
      type: "paper-reader-state",
      pdfLinks: data.pdfLinks,
    });
    // A delayed response must never move the reader back to the previous paper.
    if (request !== stateRequest || data.url !== location.href) return false;
    reader.setPaper(state?.paperId ? { ...state, title: data.title || state.paperId } : null);
    return true;
  }

  function refreshAfterNavigation() {
    void refreshPaper().catch(() => reader.showError("扩展连接已失效，请刷新论文页面后重试。"));
  }

  function trackNavigation() {
    // After the extension is reloaded this script is orphaned: remove its icon and stop.
    if (!chrome.runtime?.id) {
      clearInterval(timer);
      reader.destroy();
      return;
    }
    reader.mount();
    if (lastUrl === location.href) return;
    lastSelection = "";
    lastUrl = location.href;
    refreshAfterNavigation();
  }

  document.addEventListener("selectionchange", () => {
    trackNavigation();
    const selected = window.getSelection()?.toString().trim();
    if (selected) lastSelection = selected.slice(0, 16000);
    else reader.hideAsk();
  });

  // Select text in the paper, then ask about it from a small bubble under the selection.
  function offerAsk() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    const node = selection?.anchorNode;
    const anchor = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (
      !text ||
      text.length < 2 ||
      !selection.rangeCount ||
      anchor?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') ||
      reader.host.contains(anchor)
    )
      return reader.hideAsk();
    const rects = selection.getRangeAt(0).getClientRects();
    const rect = rects[rects.length - 1] || selection.getRangeAt(0).getBoundingClientRect();
    reader.showAsk(rect, text);
  }
  document.addEventListener("mouseup", () => setTimeout(offerAsk, 0));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey) setTimeout(offerAsk, 0);
  });
  window.addEventListener("scroll", () => reader.hideAsk(), true);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type !== "paper-context") return;
    trackNavigation();
    reply(pageContext());
  });
  window.addEventListener("popstate", trackNavigation);
  window.addEventListener("hashchange", trackNavigation);
  // pushState navigation does not emit popstate. Poll only the URL, not the page DOM.
  const timer = setInterval(trackNavigation, 1000);
  refreshAfterNavigation();
})();
