/* A floating icon on alphaXiv/arXiv paper pages that opens Paper Sidecar in a panel docked
   to the right edge. While it is open the page is narrowed by the panel's width (like a
   browser side panel), so nothing is covered; the site's own content is never modified. */
globalThis.PaperSidecarReader = (() => {
  const rootId = "paper-sidecar-root";

  function create() {
    const host = document.createElement("div");
    host.id = rootId;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = /* HTML */ ` <style>
        :host {
          all: initial;
          position: fixed;
          right: 0;
          bottom: 0;
          z-index: 2147483000;
        }
        [hidden] {
          display: none !important;
        }
        .launcher {
          position: fixed;
          right: 20px;
          bottom: 20px;
          display: grid;
          place-items: center;
          width: 46px;
          height: 46px;
          padding: 0;
          border: 0;
          border-radius: 14px;
          background: transparent;
          box-shadow: 0 6px 20px #00000033;
          cursor: pointer;
          transition:
            transform 160ms ease,
            box-shadow 160ms ease;
        }
        .launcher:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 26px #00000040;
        }
        .launcher:focus-visible {
          outline: 2px solid #a51f39;
          outline-offset: 3px;
        }
        .launcher img {
          width: 46px;
          height: 46px;
          border-radius: 14px;
        }
        .panel {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          display: flex;
          max-width: calc(100vw - 120px);
          background: #fff;
          box-shadow:
            -0.5px 0 0 rgb(0 0 0 / 0.12),
            -12px 0 40px rgb(0 0 0 / 0.12);
          animation: slide-in 180ms ease-out;
        }
        @keyframes slide-in {
          from {
            transform: translateX(24px);
            opacity: 0;
          }
        }
        .panel iframe {
          flex: 1;
          width: 100%;
          height: 100%;
          border: 0;
          background: transparent;
          color-scheme: normal;
        }
        .resize {
          position: absolute;
          top: 0;
          bottom: 0;
          left: -4px;
          width: 8px;
          cursor: col-resize;
          z-index: 1;
        }
        .resize:hover,
        .resizing .resize {
          background: linear-gradient(
            90deg,
            transparent 3px,
            #007aff 3px,
            #007aff 5px,
            transparent 5px
          );
        }
        .resizing iframe {
          pointer-events: none;
        }
        @media (prefers-color-scheme: dark) {
          .panel {
            background: #1e1e1e;
          }
        }
        .ask {
          position: fixed;
          display: flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px 0 6px;
          border: 0;
          border-radius: 8px;
          background: #fff;
          color: #1d1d1f;
          box-shadow:
            0 0 0 0.5px rgb(0 0 0 / 0.12),
            0 6px 20px rgb(0 0 0 / 0.16);
          font:
            500 12.5px -apple-system,
            BlinkMacSystemFont,
            "PingFang SC",
            sans-serif;
          cursor: pointer;
          animation: appear 120ms ease;
        }
        .ask img {
          width: 18px;
          height: 18px;
          border-radius: 5px;
        }
        .ask:hover {
          background: #f5f5f7;
        }
        @keyframes appear {
          from {
            opacity: 0;
            transform: translateY(-3px);
          }
        }
        @media (prefers-color-scheme: dark) {
          .ask {
            background: #2a2a2c;
            color: #f5f5f7;
          }
          .ask:hover {
            background: #323234;
          }
        }
        .error {
          position: fixed;
          right: 76px;
          bottom: 24px;
          max-width: 320px;
          padding: 10px 14px;
          border: 1px solid #e7cdd2;
          border-radius: 10px;
          background: #fff5f5;
          color: #972b40;
          font:
            13px/1.6 -apple-system,
            BlinkMacSystemFont,
            "PingFang SC",
            sans-serif;
        }
      </style>
      <button
        type="button"
        class="launcher"
        title="打开 Paper Sidecar"
        aria-label="打开 Paper Sidecar"
        hidden
      >
        <img alt="" />
      </button>
      <aside class="panel" aria-label="Paper Sidecar" hidden>
        <div class="resize" title="拖动调整宽度"></div>
      </aside>
      <button type="button" class="ask" hidden><img alt="" />问 Sidecar</button>
      <div class="error" role="status" hidden></div>`;
    const launcher = shadow.querySelector(".launcher");
    const error = shadow.querySelector(".error");
    const panel = shadow.querySelector(".panel");
    const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
    let paper = null;
    let frame = null;
    // Quotes wait until the panel has loaded and said it is ready.
    let frameReady = false;
    let pendingQuote = null;
    const ask = shadow.querySelector(".ask");
    ask.querySelector("img").src = chrome.runtime.getURL("icons/icon.svg");
    let askText = "";
    ask.addEventListener("mousedown", (event) => event.preventDefault()); // Keep the selection.
    ask.addEventListener("click", () => {
      quote(askText);
      hideAsk();
    });
    launcher.querySelector("img").src = chrome.runtime.getURL("icons/icon.svg");
    launcher.addEventListener("click", () => {
      error.hidden = true;
      open();
    });

    // Width: about a third of the window by default, user-resizable, remembered. The page
    // always keeps at least 360px.
    const MIN_WIDTH = 340;
    let width = null;
    const defaultWidth = () => Math.round(Math.min(600, Math.max(380, window.innerWidth * 0.32)));
    const clampWidth = (value) =>
      Math.round(
        Math.min(Math.max(value, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth - 360)),
      );

    // Narrow the page instead of covering it, and restore the page's own style on close.
    // Ordinary pages reflow when the root gets a right margin. The browser's PDF viewer is a
    // single full-window <embed> that ignores that margin, so it is narrowed directly.
    const saved = new Map();
    function setStyle(element, property, value) {
      if (!saved.has(element)) saved.set(element, new Map());
      const original = saved.get(element);
      if (!original.has(property))
        original.set(property, [
          element.style.getPropertyValue(property),
          element.style.getPropertyPriority(property),
        ]);
      element.style.setProperty(property, value, "important");
    }
    function pushPage(pixels) {
      if (pixels) {
        setStyle(document.documentElement, "margin-right", `${pixels}px`);
        for (const viewer of document.querySelectorAll('embed[type*="pdf"]'))
          setStyle(viewer, "width", `calc(100% - ${pixels}px)`);
        return;
      }
      for (const [element, properties] of saved)
        for (const [property, [value, priority]] of properties) {
          if (value) element.style.setProperty(property, value, priority);
          else element.style.removeProperty(property);
        }
      saved.clear();
    }

    function applyWidth() {
      const pixels = clampWidth(width ?? defaultWidth());
      panel.style.width = `${pixels}px`;
      if (!panel.hidden) pushPage(pixels);
    }
    void chrome.storage.local
      .get("panelWidth")
      .then(({ panelWidth }) => {
        if (Number.isFinite(panelWidth)) width = panelWidth;
        applyWidth();
      })
      .catch(() => {});
    shadow.querySelector(".resize").addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture?.(event.pointerId);
      panel.classList.add("resizing");
      const move = (moveEvent) => {
        width = clampWidth(window.innerWidth - moveEvent.clientX);
        applyWidth();
      };
      const stop = () => {
        panel.classList.remove("resizing");
        handle.removeEventListener("pointermove", move);
        void chrome.storage.local.set({ panelWidth: width }).catch(() => {});
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop, { once: true });
      handle.addEventListener("pointercancel", stop, { once: true });
    });

    function open() {
      if (!paper) return;
      if (!frame) {
        frame = document.createElement("iframe");
        frame.title = "Paper Sidecar";
        const params = new URLSearchParams({
          embedded: "1",
          tabId: String(paper.tabId),
          parent: location.origin,
        });
        frame.src = `${chrome.runtime.getURL("sidepanel.html")}?${params}`;
        frameReady = false;
        panel.append(frame);
      }
      panel.hidden = false;
      applyWidth();
      launcher.hidden = true;
      frame.focus();
    }

    function close() {
      panel.hidden = true;
      pushPage(0);
      launcher.hidden = !paper;
    }

    // Leaving the paper unloads the frame so its local assistant process is released.
    function unload() {
      close();
      hideAsk();
      frame?.remove();
      frame = null;
      frameReady = false;
      pendingQuote = null;
    }

    function deliverQuote() {
      if (!frameReady || !pendingQuote || !frame) return;
      frame.contentWindow.postMessage(
        { type: "paper-sidecar-quote", text: pendingQuote },
        extensionOrigin,
      );
      pendingQuote = null;
    }

    function quote(text) {
      if (!paper || !text) return;
      pendingQuote = text.slice(0, 16000);
      open();
      deliverQuote();
    }

    // "Ask" bubble under a text selection on the paper page.
    function showAsk(rect, text) {
      if (!paper || !text) return hideAsk();
      askText = text;
      ask.hidden = false;
      const width = ask.offsetWidth || 104;
      ask.style.left = `${Math.round(Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8))}px`;
      const below = rect.bottom + 8;
      ask.style.top = `${Math.round(below + 36 < window.innerHeight ? below : Math.max(8, rect.top - 36))}px`;
    }

    function hideAsk() {
      ask.hidden = true;
      askText = "";
    }

    window.addEventListener("message", (event) => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== extensionOrigin)
        return;
      if (event.data?.type === "paper-sidecar-close") close();
      if (event.data?.type === "paper-sidecar-ready") {
        frameReady = true;
        deliverQuote();
      }
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) close();
    });

    // A fixed spot that never moves. alphaXiv keeps up to three round buttons (52px, 20px
    // from the edges) in its bottom-right corner, so the icon sits above that column,
    // centred on it; arXiv has none, so the icon uses the corner itself.
    const POSITION = /(^|\.)alphaxiv\.org$/.test(location.hostname)
      ? { bottom: 222, right: 23 }
      : { bottom: 24, right: 24 };
    launcher.style.bottom = `${POSITION.bottom}px`;
    launcher.style.right = `${POSITION.right}px`;
    error.style.bottom = `${POSITION.bottom + 4}px`;
    error.style.right = `${POSITION.right + 56}px`;

    function mount() {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
    }

    function setPaper(next) {
      const changedTab = paper?.tabId !== next?.tabId;
      paper = next;
      if (!paper || changedTab) unload();
      if (!panel.hidden) return;
      launcher.hidden = !paper;
    }

    window.addEventListener("resize", () => {
      if (!panel.hidden) applyWidth();
    });

    function showError(message) {
      error.textContent = message;
      error.hidden = false;
    }

    function destroy() {
      pushPage(0);
      host.remove();
    }

    mount();
    return { mount, setPaper, showError, destroy, showAsk, hideAsk, host };
  }

  return { rootId, create };
})();
