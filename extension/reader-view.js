/* This frame occupies the native Assistant body; it never replaces the paper viewer. */
globalThis.PaperSidecarReader = (() => {
  const rootId = "paper-sidecar-root";

  function create({ onOpen }) {
    const host = document.createElement("div");
    host.id = rootId;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = /* HTML */ ` <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          pointer-events: none;
        }
        [hidden] {
          display: none !important;
        }
        iframe {
          position: fixed;
          border: 0;
          display: block;
          pointer-events: auto;
          background: white;
        }
        .error {
          position: fixed;
          right: 24px;
          bottom: 24px;
          max-width: 360px;
          padding: 12px 16px;
          border: 1px solid #e7cdd2;
          border-radius: 10px;
          background: #fff5f5;
          color: #972b40;
          pointer-events: auto;
          font:
            13px/1.6 -apple-system,
            BlinkMacSystemFont,
            "PingFang SC",
            sans-serif;
        }
        @media (prefers-color-scheme: dark) {
          iframe {
            background: #19191c;
          }
        }
      </style>
      <iframe title="论文伴读" hidden></iframe>
      <div class="error" role="status" hidden></div>`;
    const frame = shadow.querySelector("iframe");
    const error = shadow.querySelector(".error");
    const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
    let paper = null;
    const workspace = PaperSidecarWorkspace.create({
      onLayout: renderSlot,
      onProviderSelect: selectProvider,
    });

    function mount() {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
    }

    function updateFrame() {
      if (!paper) return;
      if (!frame.hasAttribute("src")) {
        const params = new URLSearchParams({
          embedded: "1",
          tabId: String(paper.tabId),
          parent: location.origin,
        });
        frame.src = `${chrome.runtime.getURL("sidepanel.html")}?${params}`;
      }
      frame.contentWindow?.postMessage({ type: "paper-sidecar-context-changed" }, extensionOrigin);
    }

    function renderSlot({ active, rect, zIndex }) {
      frame.hidden = !active || !paper;
      if (frame.hidden) return;
      if (!frame.hasAttribute("src")) updateFrame();
      host.style.zIndex = String(zIndex);
      Object.assign(frame.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }

    async function selectProvider(next) {
      try {
        if (next === "codex" && !(await onOpen())) return;
        error.hidden = true;
        workspace.select(next);
        await chrome.storage.local.set({ readerProvider: next });
      } catch {
        showError("论文伴读未能打开，请刷新论文页面后重试。");
      }
    }

    function setPaper(next) {
      paper = next;
      const supported = !!paper && /(^|\.)alphaxiv\.org$/.test(location.hostname);
      workspace.setEnabled(supported);
      if (!supported) {
        frame.hidden = true;
        frame.removeAttribute("src");
      } else if (frame.hasAttribute("src")) {
        updateFrame();
      }
    }

    function showError(message) {
      workspace.select("alphaxiv");
      error.textContent = message;
      error.hidden = false;
    }

    window.addEventListener("message", (event) => {
      if (
        event.source === frame.contentWindow &&
        event.origin === extensionOrigin &&
        event.data?.type === "paper-sidecar-collapse"
      )
        workspace.close();
    });
    void chrome.storage.local
      .get("readerProvider")
      .then((saved) => {
        const provider = saved.readerProvider === "codex" ? "codex" : "alphaxiv";
        workspace.select(provider);
      })
      .catch(() => {});
    mount();
    return { mount, setPaper, showError };
  }

  return { rootId, create };
})();
