/* Settings sheet: ChatGPT account (via the bundled Codex runtime), the editable system prompt and third-party model APIs.
   API keys go to the local host once and are never read back; the page only sees a hint. */
export const PROVIDER_PRESETS = [
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com" },
  {
    id: "moonshot",
    name: "Kimi（Moonshot）",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "qwen",
    name: "通义千问（DashScope）",
    kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    vision: true,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    vision: true,
  },
  { id: "ollama", name: "Ollama（本机）", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "custom", name: "自定义", kind: "openai", baseUrl: "" },
];

export function createSettingsView(document, { send, notice, openUrl, onClose }) {
  const $ = (id) => document.getElementById(id);
  const view = $("settings-view");
  let providers = [];
  let defaultPrompt = null;
  let loginId = null;
  let editing = null;

  function request(type, payload = {}) {
    try {
      return send(type, payload);
    } catch (error) {
      notice(error.message, true);
      return null;
    }
  }

  function open() {
    view.hidden = false;
    document.documentElement.dataset.settings = "open";
    request("account");
    $("close-settings").focus();
  }

  function close() {
    view.hidden = true;
    delete document.documentElement.dataset.settings;
    hideForm();
    onClose?.();
  }

  function busy(button, value) {
    if (button) button.disabled = value;
  }

  // Account ----------------------------------------------------------------
  function showAccount(state) {
    const account = state?.account;
    const status = $("account-status");
    status.dataset.state = account ? "online" : "offline";
    if (!account) {
      status.textContent = state?.requiresOpenaiAuth === false ? "无需登录" : "未登录";
    } else if (account.type === "chatgpt") {
      status.textContent = `ChatGPT 账号${account.email ? ` · ${account.email}` : ""}${
        account.planType && account.planType !== "unknown" ? ` · ${account.planType}` : ""
      }`;
    } else if (account.type === "apiKey") {
      status.textContent = "OpenAI API Key";
    } else {
      status.textContent = account.type;
    }
    $("logout").hidden = !account;
    $("login-actions").hidden = !!account;
  }

  function showLoginPending(text, code) {
    $("login-pending").hidden = !text;
    $("login-pending-text").textContent = text || "";
    $("login-code").hidden = !code;
    $("login-code").textContent = code || "";
  }

  $("login-chatgpt").addEventListener("click", () => request("login", { method: "chatgpt" }));
  $("login-device").addEventListener("click", () =>
    request("login", { method: "chatgptDeviceCode" }),
  );
  $("login-key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const apiKey = $("login-key").value.trim();
    if (!apiKey) return;
    if (request("login", { method: "apiKey", apiKey })) $("login-key").value = "";
  });
  $("login-cancel").addEventListener("click", () => {
    if (loginId) request("login-cancel", { loginId });
    loginId = null;
    showLoginPending("");
  });
  $("logout").addEventListener("click", () => request("logout"));

  // Prompt -----------------------------------------------------------------
  function showPrompt(prompt, fallback) {
    if (fallback) defaultPrompt = fallback;
    const editor = $("prompt-editor");
    // Never overwrite text the user is still editing.
    if (document.activeElement !== editor || !editor.dataset.dirty) {
      editor.value = prompt?.text || "";
      delete editor.dataset.dirty;
    }
    $("prompt-source").textContent = prompt?.custom
      ? "当前使用你编辑的提示词。"
      : `当前使用默认提示词（${defaultPrompt?.path || prompt?.path || ""}）。修改后保存即可覆盖。`;
    $("prompt-reset").disabled = !prompt?.custom;
  }

  $("prompt-editor").addEventListener("input", () => {
    $("prompt-editor").dataset.dirty = "1";
    $("prompt-saved").textContent = "";
  });
  $("prompt-save").addEventListener("click", () => {
    if (request("save-prompt", { text: $("prompt-editor").value })) {
      delete $("prompt-editor").dataset.dirty;
      $("prompt-saved").textContent = "正在保存…";
    }
  });
  $("prompt-reset").addEventListener("click", () => {
    if (request("save-prompt", { text: "" })) {
      delete $("prompt-editor").dataset.dirty;
      $("prompt-saved").textContent = "已恢复默认";
    }
  });

  // Providers --------------------------------------------------------------
  function renderProviders() {
    const list = $("provider-list");
    list.replaceChildren(
      ...providers.map((provider) => {
        const item = document.createElement("li");
        const text = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = provider.name;
        const meta = document.createElement("span");
        meta.textContent = `${provider.models.length} 个模型 · ${provider.keyHint || "无 Key"}`;
        meta.title = provider.baseUrl;
        text.append(name, meta);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "text-button";
        edit.textContent = "编辑";
        edit.addEventListener("click", () => showForm(provider));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "text-button danger";
        remove.textContent = "删除";
        remove.addEventListener("click", () => {
          if (confirm(`删除 ${provider.name}？保存在本机的 API Key 也会删除。`))
            request("delete-provider", { id: provider.id });
        });
        item.append(text, edit, remove);
        return item;
      }),
    );
    $("provider-empty").hidden = providers.length > 0;
  }

  function applyPreset(preset) {
    $("provider-name").value = preset.id === "custom" ? "" : preset.name;
    $("provider-kind").value = preset.kind;
    $("provider-url").value = preset.baseUrl;
    $("provider-vision").checked = !!preset.vision;
  }

  function showForm(provider = null) {
    editing = provider;
    $("provider-form").hidden = false;
    $("provider-add").hidden = true;
    $("provider-preset").closest("label").hidden = !!provider;
    $("provider-form-title").textContent = provider ? `编辑 ${provider.name}` : "添加 API";
    if (provider) {
      $("provider-name").value = provider.name;
      $("provider-kind").value = provider.kind;
      $("provider-url").value = provider.baseUrl;
      $("provider-vision").checked = provider.vision;
      $("provider-models").value = provider.models.join("\n");
    } else {
      $("provider-preset").value = PROVIDER_PRESETS[0].id;
      applyPreset(PROVIDER_PRESETS[0]);
      $("provider-models").value = "";
    }
    $("provider-key").value = "";
    $("provider-key").placeholder = provider?.keyHint
      ? `已保存 ${provider.keyHint}，留空则不修改`
      : "sk-…";
    $("provider-name").focus();
  }

  function hideForm() {
    editing = null;
    $("provider-form").hidden = true;
    $("provider-add").hidden = false;
  }

  function draft() {
    return {
      id: editing?.id,
      name: $("provider-name").value,
      kind: $("provider-kind").value,
      baseUrl: $("provider-url").value,
      apiKey: $("provider-key").value,
      models: $("provider-models").value,
      vision: $("provider-vision").checked,
    };
  }

  $("provider-preset").replaceChildren(
    ...PROVIDER_PRESETS.map((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      return option;
    }),
  );
  $("provider-preset").addEventListener("change", (event) =>
    applyPreset(PROVIDER_PRESETS.find((preset) => preset.id === event.target.value)),
  );
  $("provider-add").addEventListener("click", () => showForm());
  $("provider-cancel").addEventListener("click", hideForm);
  $("provider-fetch").addEventListener("click", () => {
    if (request("provider-models", { provider: draft() })) {
      busy($("provider-fetch"), true);
      $("provider-fetch").textContent = "正在获取…";
    }
  });
  $("provider-form").addEventListener("submit", (event) => {
    event.preventDefault();
    request("save-provider", { provider: draft() });
  });

  // Wiring -----------------------------------------------------------------
  $("open-settings").addEventListener("click", open);
  $("close-settings").addEventListener("click", close);
  view.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return {
    open,
    close,
    isOpen: () => !view.hidden,
    /** Settings catalog from the host: prompt, providers and account. */
    initialize(message) {
      providers = message.providers || [];
      renderProviders();
      showPrompt(message.prompt, message.defaultPrompt);
      if (message.account) showAccount(message.account);
      $("codex-error").hidden = !message.codexError;
      $("codex-error").textContent = message.codexError
        ? `ChatGPT 账号模型暂不可用：${message.codexError}`
        : "";
    },
    /** Returns true when the event belonged to the settings view. */
    handle(message, request) {
      switch (message.event) {
        case "account":
          showAccount(message);
          if (message.account) showLoginPending("");
          return true;
        case "login-started":
          loginId = message.loginId || null;
          if (message.type === "chatgpt") {
            openUrl(message.authUrl);
            showLoginPending("已在新标签页打开登录页面，完成后回到这里。");
          } else if (message.type === "chatgptDeviceCode") {
            openUrl(message.verificationUrl);
            showLoginPending("在打开的页面登录后，输入下面的一次性代码：", message.userCode);
          }
          return true;
        case "account-changed":
          if (message.method === "account/login/completed") {
            loginId = null;
            showLoginPending("");
            if (!message.success) notice(`登录未完成：${message.error || "已取消"}`, true);
          }
          return true;
        case "user-settings":
          providers = message.providers || [];
          renderProviders();
          showPrompt(message.prompt, message.defaultPrompt);
          if (request?.type === "save-prompt") {
            $("prompt-saved").textContent = message.prompt.custom ? "已保存" : "已恢复默认";
          }
          if (request?.type === "save-provider") hideForm();
          return true;
        case "provider-models": {
          busy($("provider-fetch"), false);
          $("provider-fetch").textContent = "获取模型列表";
          const current = $("provider-models").value.trim();
          if (!message.models.length) notice("该 API 没有返回模型，请手动填写模型名称。", true);
          else if (!current || confirm(`获取到 ${message.models.length} 个模型，替换当前列表？`))
            $("provider-models").value = message.models.join("\n");
          return true;
        }
        default:
          return false;
      }
    },
    /** A failed host request that the settings view started. */
    failed(request) {
      if (request?.type === "provider-models") {
        busy($("provider-fetch"), false);
        $("provider-fetch").textContent = "获取模型列表";
      }
      if (request?.type === "save-prompt") $("prompt-saved").textContent = "";
    },
  };
}
