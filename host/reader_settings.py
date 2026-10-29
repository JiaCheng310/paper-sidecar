"""Reader-specific model controls and the effective system prompt."""

import asyncio
import hashlib

from host.user_settings import UserStore

DEFAULT_MODEL = "gpt-6-sol"
API_PREFIX = "api:"
BUILTIN_PROMPT = """你是一名严谨、耐心的论文阅读助手，帮助用户真正读懂当前这篇论文。

## 原则
- 先读 PDF 原文再下结论，引用具体页码；区分“论文声称的”与“你的解释或推断”。
- 原文没有的信息不要编造；不确定或没读到的地方直接说明。
- 默认用用户提问的语言回答，术语首次出现时保留英文原词。

## 开放式问题（如“这篇讲什么”“这个做了什么”）
1. 研究问题与动机：要解决什么，为什么重要，现有方法的不足。
2. 核心方法：先给直觉，再讲关键公式和流程，说明每个设计的作用。
3. 实验与证据：主要结果、对比基线、消融实验，哪些证据最有说服力。
4. 局限与疑点：假设是否成立，实验是否充分，有哪些可能的反例。
5. 延伸：与相关工作的关系，值得继续验证或改进的方向。

## 具体问题
用户只问某个概念、公式、图表或章节时，聚焦回答该问题，不必重复完整流程。

## 格式
使用 Markdown 分节，公式用 LaTeX，必要时用表格对比；保持段落简洁。"""


def fast_tier(model):
    return next((tier for tier in model["serviceTiers"]
                 if tier["name"].lower() == "fast" or tier["id"] in {"fast", "priority"}), None)


def text_prompt(name, path, text, custom=False):
    body = text.encode()
    return {"name": name, "path": path, "text": text, "custom": custom,
            "revision": hashlib.sha256(body).hexdigest()}


def api_model_id(provider_id, model):
    return f"{API_PREFIX}{provider_id}:{model}"


class ReaderSettings:
    def __init__(self, store=None):
        self.store = store if store is not None else UserStore(None)
        self.models = []
        self.defaults = None
        self.codex_error = None
        self.lock = asyncio.Lock()

    def default_prompt(self):
        return text_prompt("内置默认提示词", "随扩展提供", BUILTIN_PROMPT)

    def prompt(self):
        if self.store.prompt:
            return text_prompt("自定义提示词", "在设置中编辑", self.store.prompt, custom=True)
        return self.default_prompt()

    def api_models(self):
        return [{"id": api_model_id(provider["id"], model), "name": model, "group": provider["name"],
                 "provider": provider["id"], "efforts": [], "serviceTiers": []}
                for provider in self.store.data["providers"] for model in provider["models"]]

    async def prepare(self, client, *, refresh=False):
        async with self.lock:
            if self.models and not refresh:
                return
            models, cursor = [], None
            while True:
                response = await client.request("model/list", {"limit": 50, "cursor": cursor})
                models.extend(response.get("data", []))
                cursor = response.get("nextCursor")
                if not cursor:
                    break
            available = []
            for model in models:
                # Ultra delegates work; this reader only exposes single-agent effort levels.
                efforts = [item["reasoningEffort"] for item in model["supportedReasoningEfforts"]
                           if item["reasoningEffort"] != "ultra"]
                if efforts:
                    available.append({"id": model["model"], "name": model["displayName"],
                                      "efforts": efforts, "serviceTiers": model.get("serviceTiers", []),
                                      "isDefault": model.get("isDefault", False)})
            if not available:
                raise ValueError("当前 ChatGPT 账号没有可用模型，请检查登录状态。")
            default = next((model for model in available if model["id"] == DEFAULT_MODEL),
                           next((model for model in available if model["isDefault"]), available[0]))
            self.defaults = {"model": default["id"],
                             "effort": "medium" if "medium" in default["efforts"] else default["efforts"][0],
                             "speed": "fast" if fast_tier(default) else "standard"}
            self.models = available

    async def describe(self, client):
        # A signed-out Codex must not hide the user's own API models.
        try:
            await client.start()
            await self.prepare(client, refresh=True)
            self.codex_error = None
        except Exception as error:
            self.models, self.defaults = [], None
            self.codex_error = str(error)[:300]
        extra = self.api_models()
        defaults = self.defaults or (
            {"model": extra[0]["id"], "effort": "default", "speed": "standard"} if extra else None)
        default_prompt = self.default_prompt()
        try:
            account = await client.request("account/read", {"refreshToken": False})
        except Exception:
            account = {}
        return {"models": [{**model, "group": "ChatGPT 账号"} for model in self.models] + extra,
                "defaults": defaults, "codexError": self.codex_error,
                "prompt": self.prompt(), "defaultPrompt": default_prompt,
                "providers": self.store.public_providers(),
                "account": {"account": account.get("account"),
                            "requiresOpenaiAuth": account.get("requiresOpenaiAuth", False)}}

    def resolve_api(self, requested):
        _, _, rest = requested["model"].partition(API_PREFIX)
        provider_id, _, model = rest.partition(":")
        provider = self.store.provider(provider_id)
        if not provider or model not in provider["models"]:
            raise ValueError("该 API 模型已删除或不可用，请从面板中重新选择。")
        return {"model": requested["model"], "effort": "default", "speed": "standard",
                "serviceTier": None, "provider": provider, "apiModel": model}

    async def resolve(self, client, requested):
        if not isinstance(requested, dict):
            raise ValueError("模型设置格式无效。")
        if str(requested.get("model", "")).startswith(API_PREFIX):
            return self.resolve_api(requested)
        await client.start()
        await self.prepare(client)
        settings = {**self.defaults, **requested}
        model = next((item for item in self.models if item["id"] == settings["model"]), None)
        if model is None or settings["effort"] not in model["efforts"]:
            raise ValueError("该模型或推理强度不可用，请从面板中重新选择。")
        if settings["speed"] not in {"standard", "fast"}:
            raise ValueError("请选择标准或快速模式。")
        tier = fast_tier(model)
        if settings["speed"] == "fast" and not tier:
            raise ValueError("该模型不支持快速模式，请选择标准模式或其他模型。")
        return {"model": model["id"], "effort": settings["effort"], "speed": settings["speed"],
                "serviceTier": tier["id"] if settings["speed"] == "fast" else "default"}
