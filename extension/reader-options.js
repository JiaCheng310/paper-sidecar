/* Model choices come from the installed Codex catalog, never a hard-coded UI list. */
export async function createReaderOptions(document, storage, onError) {
  const model = document.getElementById("model-choice");
  const effort = document.getElementById("effort-choice");
  const speed = document.getElementById("speed-choice");
  let saved = (await storage.get("readerOptions")).readerOptions || {};
  let catalog = [];
  let ready = false;
  let busy = false;

  function fill(select, items, preferred) {
    const groups = new Map();
    for (const { value, label, description, group, disabled } of items) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.title = description || label;
      option.disabled = !!disabled;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    }
    // Group options by source (Codex, then each API) only when there is more than one source.
    select.replaceChildren(
      ...[...groups].flatMap(([group, options]) => {
        if (!group || groups.size < 2) return options;
        const element = document.createElement("optgroup");
        element.label = group;
        element.append(...options);
        return [element];
      }),
    );
    const usable = items.filter((item) => !item.disabled);
    select.value = usable.some((item) => item.value === preferred)
      ? preferred
      : usable[0]?.value || "";
  }

  function updateCapabilities(preferred) {
    const selected = catalog.find((item) => item.id === model.value);
    if (!selected) return updateDisabled();
    // Third-party API models have no Codex effort or speed tiers.
    const efforts = selected.efforts.length ? selected.efforts : ["default"];
    fill(
      effort,
      efforts.map((value) => ({ value, label: value === "default" ? "默认" : value })),
      efforts.includes(preferred.effort) ? preferred.effort : "medium",
    );
    const tier = selected.serviceTiers.find(
      (item) => item.name.toLowerCase() === "fast" || ["fast", "priority"].includes(item.id),
    );
    const speeds = [{ value: "standard", label: "标准" }];
    if (tier) {
      const multiplier = tier.description.match(/([\d.]+)x/i)?.[1];
      speeds.push({
        value: "fast",
        label: multiplier ? `Fast · ${multiplier}×` : "Fast",
        description: `${tier.description}；实际速度由模型和服务决定，快速模式额度消耗更高。`,
      });
    }
    fill(speed, speeds, preferred.speed || "fast");
    updateDisabled();
  }

  function value() {
    return { model: model.value, effort: effort.value, speed: speed.value };
  }
  function updateDisabled() {
    model.disabled = !ready || busy;
    // A single choice (API models) is shown for information only.
    effort.disabled = !ready || busy || effort.options.length < 2;
    speed.disabled = !ready || busy || speed.options.length < 2;
  }
  async function save() {
    saved = value();
    try {
      await storage.set({ readerOptions: saved });
    } catch {
      onError("模型设置未能保存；本次选择仍会用于下一条消息。");
    }
  }
  model.addEventListener("change", () => {
    updateCapabilities({ ...value(), effort: effort.value || "medium" });
    void save();
  });
  effort.addEventListener("change", () => void save());
  speed.addEventListener("change", () => void save());
  updateDisabled();

  return {
    value,
    isReady: () => ready,
    setBusy(value) {
      busy = value;
      updateDisabled();
    },
    initialize(message) {
      // ChatGPT-account models need a sign-in; API models never do.
      const signedOut = !!message.account?.requiresOpenaiAuth && !message.account?.account;
      const items = (message.models || []).map((item) => ({
        value: item.id,
        label: signedOut && !item.provider ? `${item.name}（需登录）` : item.name,
        group: item.group,
        disabled: signedOut && !item.provider,
      }));
      catalog = (message.models || []).filter((item) => !(signedOut && !item.provider));
      if (!catalog.length) {
        ready = false;
        fill(
          model,
          [{ value: "", label: "请在 ⚙ 设置中登录 ChatGPT 或添加 API", disabled: false }, ...items],
          "",
        );
        effort.replaceChildren();
        speed.replaceChildren();
        updateDisabled();
        return;
      }
      const preferred = { ...message.defaults, ...saved };
      if (!catalog.some((item) => item.id === preferred.model)) {
        preferred.model = catalog.some((item) => item.id === message.defaults?.model)
          ? message.defaults.model
          : catalog[0].id;
      }
      fill(model, items, preferred.model);
      ready = true;
      updateCapabilities(preferred);
      document.getElementById("model").textContent = "本机运行";
    },
    showRuntime(settings) {
      const name = catalog.find((item) => item.id === settings.model)?.name || settings.model;
      document.getElementById("model").textContent =
        settings.label ||
        `${name} · ${settings.effort} · ${settings.speed === "fast" ? "Fast" : "标准"}`;
    },
    clearRuntime() {},
  };
}
