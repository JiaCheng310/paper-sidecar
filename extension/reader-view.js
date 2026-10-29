/* A floating icon on alphaXiv/arXiv paper pages that opens Paper Sidecar in a panel on the
   right edge of the page. The panel is our own extension frame laid over the page; the
   site's own content, assistant and PDF viewer are never modified. */
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

    // Width: wide by default (covers the site's right-hand column), user-resizable, remembered.
    const MIN_WIDTH = 360;
    let width = null;
    const defaultWidth = () => Math.round(Math.min(760, Math.max(420, window.innerWidth * 0.4)));
    const clampWidth = (value) =>
      Math.round(
        Math.min(Math.max(value, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth - 120)),
      );
    function applyWidth() {
      panel.style.width = `${clampWidth(width ?? defaultWidth())}px`;
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
      applyWidth();
      panel.hidden = false;
      launcher.hidden = true;
      frame.focus();
    }

    function close() {
      panel.hidden = true;
      launcher.hidden = !paper;
      if (paper) place(true);
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

    // Move only after two identical readings, so animations on the page never make it jump.
    let placed = null,
      candidate = null,
      checkedAt = 0;
    function place(force = false) {
      // mount() also runs on every selection change; probing that often is wasted work.
      if (!force && performance.now() - checkedAt < 500) return;
      checkedAt = performance.now();
      const next = target();
      const same = (a, b) =>
        a && Math.abs(a.bottom - b.bottom) < 4 && Math.abs(a.right - b.right) < 4;
      if (same(placed, next)) return (candidate = null);
      if (!force && placed && !same(candidate, next)) return (candidate = next);
      placed = next;
      candidate = null;
      launcher.style.bottom = `${next.bottom}px`;
      launcher.style.right = `${next.right}px`;
      error.style.bottom = `${next.bottom + 4}px`;
      error.style.right = `${next.right + 56}px`;
    }

    function mount() {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
      if (!launcher.hidden) place();
    }

    function setPaper(next) {
      const changedTab = paper?.tabId !== next?.tabId;
      paper = next;
      if (!paper || changedTab) unload();
      if (!panel.hidden) return;
      const wasHidden = launcher.hidden;
      launcher.hidden = !paper;
      if (paper) place(wasHidden);
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
      host.remove();
    }

    mount();
    return { mount, setPaper, showError, destroy };
  }

  return { rootId, create };
})();
