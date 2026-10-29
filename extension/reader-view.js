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
            bottom 220ms ease,
            right 220ms ease,
            transform 160ms ease,
            box-shadow 160ms ease;
        }
        .launcher.settling {
          opacity: 0;
          pointer-events: none;
        }
        .launcher:not(.settling) {
          animation: appear 200ms ease;
        }
        @keyframes appear {
          from {
            opacity: 0;
          }
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
      <div class="error" role="status" hidden></div>`;
    const launcher = shadow.querySelector(".launcher");
    const error = shadow.querySelector(".error");
    const panel = shadow.querySelector(".panel");
    const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
    let paper = null;
    let frame = null;
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
    const root = document.documentElement;
    let savedMargin = null;
    function pushPage(pixels) {
      if (pixels) {
        savedMargin ??= [
          root.style.getPropertyValue("margin-right"),
          root.style.getPropertyPriority("margin-right"),
        ];
        root.style.setProperty("margin-right", `${pixels}px`, "important");
      } else if (savedMargin) {
        const [value, priority] = savedMargin;
        if (value) root.style.setProperty("margin-right", value, priority);
        else root.style.removeProperty("margin-right");
        savedMargin = null;
      }
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
      if (paper) place();
    }

    // Leaving the paper unloads the frame so its local assistant process is released.
    function unload() {
      close();
      frame?.remove();
      frame = null;
    }

    window.addEventListener("message", (event) => {
      if (
        frame &&
        event.source === frame.contentWindow &&
        event.origin === extensionOrigin &&
        event.data?.type === "paper-sidecar-close"
      )
        close();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) close();
    });

    function pinnedAncestor(element) {
      for (let node = element, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return node;
      }
      return null;
    }

    // Floating buttons the site keeps in the bottom-right corner, e.g. alphaXiv's
    // stack of round buttons. Found at runtime so layout changes are handled.
    function cornerButtons() {
      const width = window.innerWidth,
        height = window.innerHeight;
      const found = new Set();
      for (const x of [width - 30, width - 46, width - 62])
        for (let y = height - 16; y > height - 520; y -= 12)
          for (const element of document.elementsFromPoint?.(x, y) || []) {
            if (
              element === host ||
              element === document.body ||
              element === document.documentElement
            )
              continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 120 && rect.height <= 120 && pinnedAncestor(element))
              found.add(element);
          }
      return [...found].map((element) => element.getBoundingClientRect());
    }

    // Sit above the whole stack (never between its buttons), centred on its column.
    function target() {
      const rects = cornerButtons().sort((a, b) => b.bottom - a.bottom);
      if (!rects.length) return { bottom: 20, right: 20 };
      let top = rects[0].top;
      let left = rects[0].left,
        right = rects[0].right;
      for (const rect of rects.slice(1)) {
        if (rect.bottom < top - 40) break; // A gap: the rest is not part of this stack.
        top = Math.min(top, rect.top);
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
      }
      const centre = (left + right) / 2;
      return {
        bottom: Math.round(window.innerHeight - top + 12),
        right: Math.max(8, Math.round(window.innerWidth - centre - 23)),
      };
    }

    // The icon is placed once the page has settled, then only ever moves up (when the site
    // adds buttons to its corner stack), after two identical readings. It never chases
    // buttons that appear and disappear while scrolling.
    let placed = null,
      candidate = null,
      checkedAt = 0,
      settleTimer = 0;
    function apply(next) {
      placed = next;
      candidate = null;
      launcher.style.bottom = `${next.bottom}px`;
      launcher.style.right = `${next.right}px`;
      error.style.bottom = `${next.bottom + 4}px`;
      error.style.right = `${next.right + 56}px`;
    }
    function place(force = false) {
      // mount() also runs on every selection change; probing that often is wasted work.
      if (!force && performance.now() - checkedAt < 500) return;
      checkedAt = performance.now();
      const next = target();
      if (force || !placed) return apply(next);
      if (next.bottom <= placed.bottom + 3) return (candidate = null);
      if (candidate && Math.abs(candidate.bottom - next.bottom) < 4) apply(next);
      else candidate = next;
    }
    function settle() {
      launcher.classList.add("settling");
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        place(true);
        launcher.classList.remove("settling");
      }, 900);
    }

    function mount() {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
      if (!launcher.hidden) place();
    }

    function setPaper(next) {
      // Read this first: closing the panel below un-hides the icon.
      const wasHidden = launcher.hidden;
      const changedTab = paper?.tabId !== next?.tabId;
      paper = next;
      if (!paper || changedTab) unload();
      if (!panel.hidden) return;
      launcher.hidden = !paper;
      if (paper && wasHidden) {
        place(true);
        settle();
      }
    }

    window.addEventListener("resize", () => {
      if (!launcher.hidden) place(true);
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
    return { mount, setPaper, showError, destroy };
  }

  return { rootId, create };
})();
