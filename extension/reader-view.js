/* A floating icon on alphaXiv/arXiv paper pages that opens the browser side panel.
   The site's own page, assistant and PDF viewer are never modified. */
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
      <div class="error" role="status" hidden></div>`;
    const launcher = shadow.querySelector(".launcher");
    const error = shadow.querySelector(".error");
    launcher.querySelector("img").src = chrome.runtime.getURL("icons/icon.svg");
    launcher.addEventListener("click", () => {
      error.hidden = true;
      chrome.runtime.sendMessage({ type: "open-side-panel" }).catch(() => {
        showError("扩展连接已失效，请刷新页面后重试。");
      });
    });

    function mount() {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
    }

    function setPaper(paper) {
      launcher.hidden = !paper;
    }

    function showError(message) {
      error.textContent = message;
      error.hidden = false;
    }

    mount();
    return { mount, setPaper, showError };
  }

  return { rootId, create };
})();
