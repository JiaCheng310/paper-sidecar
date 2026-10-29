/* The only module coupled to alphaXiv's native Assistant workspace. */
globalThis.PaperSidecarWorkspace = (() => {
  const labels = (name) => `[aria-label="${name}"], [title="${name}"]`;

  function readSlot(workspace) {
    const body =
      workspace.querySelector('[role="region"][aria-label="Assistant"]') ||
      [...workspace.querySelectorAll('[aria-label="Assistant"]')].find(
        (element) =>
          !element.matches('input, textarea, [contenteditable="true"]') &&
          element.querySelector('textarea, [contenteditable="true"]'),
      );
    const close = workspace.querySelector(labels("Close assistant"));
    if (!body || !close) return null;
    const rect = body.getBoundingClientRect();
    const visible =
      rect.width > 100 &&
      rect.height > 50 &&
      !body.closest("[hidden]") &&
      !body.parentElement.closest('[aria-hidden="true"], [inert]') &&
      getComputedStyle(body).display !== "none";
    let zIndex = 0;
    for (let ancestor = workspace; ancestor; ancestor = ancestor.parentElement) {
      const value = getComputedStyle(ancestor).zIndex;
      if (value !== "auto" && Number.isFinite(Number(value))) zIndex = Number(value);
    }
    return { workspace, body, close, rect, visible, zIndex };
  }

  function findSlot() {
    const slots = [
      ...document.querySelectorAll('[aria-label="Paper workspace"], #popout-assistant-panel'),
    ]
      .map(readSlot)
      .filter(Boolean);
    // alphaXiv keeps the floating assistant mounted even when the docked one is open.
    return slots.find((slot) => slot.visible) || slots[0] || null;
  }

  function create({ onLayout, onProviderSelect }) {
    let enabled = false;
    let provider = "alphaxiv";
    let current = null;
    let original = null;
    let queued = false;
    const switchHost = document.createElement("span");
    switchHost.dataset.paperSidecar = "provider";
    switchHost.style.cssText =
      "display:inline-flex;align-items:center;margin-right:8px;flex-shrink:0";
    const shadow = switchHost.attachShadow({ mode: "open" });
    shadow.innerHTML = /* HTML */ ` <style>
        :host {
          color-scheme: light dark;
        }
        .switch {
          display: inline-flex;
          gap: 2px;
          padding: 3px;
          border-radius: 9px;
          border: 1px solid #e4dfe0;
          background: #f7f5f5;
        }
        button {
          border: 0;
          border-radius: 6px;
          padding: 4px 9px;
          color: #797174;
          background: transparent;
          font:
            12px -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
          cursor: pointer;
        }
        button[aria-pressed="true"] {
          color: #a51f39;
          background: white;
          box-shadow: 0 1px 3px #0000000d;
        }
        button:focus-visible {
          outline: 2px solid #b65769;
          outline-offset: 2px;
        }
        @media (prefers-color-scheme: dark) {
          .switch {
            background: #282326;
            border-color: #484044;
          }
          button {
            color: #b6aeb1;
          }
          button[aria-pressed="true"] {
            color: #f0a8b6;
            background: #403137;
          }
        }
      </style>
      <span class="switch" role="group" aria-label="选择论文助手">
        <button type="button" data-provider="alphaxiv" aria-pressed="true">alphaXiv</button>
        <button type="button" data-provider="codex" aria-pressed="false">伴读</button>
      </span>`;
    shadow.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => onProviderSelect(button.dataset.provider));
    });

    function restoreBody() {
      if (!original) return;
      const { element, visibility, priority, ariaHidden, inert } = original;
      if (visibility) element.style.setProperty("visibility", visibility, priority);
      else element.style.removeProperty("visibility");
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
      element.inert = inert;
      original = null;
    }

    function hideBody(element) {
      if (original?.element === element) return;
      restoreBody();
      original = {
        element,
        visibility: element.style.getPropertyValue("visibility"),
        priority: element.style.getPropertyPriority("visibility"),
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.inert,
      };
      // Keep alphaXiv's layout and draft mounted; only the active provider is interactive.
      element.style.setProperty("visibility", "hidden", "important");
      element.setAttribute("aria-hidden", "true");
      element.inert = true;
    }

    const resize = new ResizeObserver(() => schedule());
    const position = new MutationObserver(() => schedule());
    function refresh() {
      queued = false;
      const next = enabled ? findSlot() : null;
      if (next?.body !== current?.body || next?.workspace !== current?.workspace) {
        restoreBody();
        resize.disconnect();
        position.disconnect();
        if (next) {
          resize.observe(next.body);
          resize.observe(next.workspace);
          position.observe(next.workspace, {
            attributes: true,
            attributeFilter: ["style", "class"],
          });
        }
      }
      current = next;
      if (next && switchHost.parentElement !== next.close.parentElement) {
        next.close.before(switchHost);
      } else if (!next && switchHost.isConnected) {
        switchHost.remove();
      }
      const active = enabled && provider === "codex" && !!next?.visible;
      if (active) hideBody(next.body);
      else restoreBody();
      shadow.querySelectorAll("button").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.provider === provider));
      });
      onLayout({ active, rect: next?.rect, zIndex: next?.zIndex || 0 });
    }

    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "inert", "aria-expanded", "data-state"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return {
      refresh,
      setEnabled(value) {
        enabled = value;
        refresh();
      },
      select(value) {
        provider = value;
        refresh();
      },
      close() {
        current?.close.click();
        schedule();
      },
    };
  }

  return { create };
})();
