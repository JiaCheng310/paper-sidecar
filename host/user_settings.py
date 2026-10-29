"""User-editable settings: the custom system prompt and third-party model APIs.

Everything lives in one private file outside the repository. API keys are stored there
(mode 0600) and are never sent back to the extension page; the page only sees a masked hint.
"""

import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
from urllib.parse import urlparse


def platform_dirs(platform=sys.platform, environ=os.environ, home=None):
    """Where settings and the PDF cache live on macOS, Windows and Linux."""
    home = Path(home or Path.home())
    if platform == "win32":
        local = Path(environ.get("LOCALAPPDATA") or home / "AppData/Local")
        return local / "paper-sidecar", local / "paper-sidecar/cache"
    if platform == "darwin":
        return (home / "Library/Application Support/paper-sidecar",
                home / "Library/Caches/paper-sidecar")
    data = Path(environ.get("XDG_DATA_HOME") or home / ".local/share")
    cache = Path(environ.get("XDG_CACHE_HOME") or home / ".cache")
    return data / "paper-sidecar", cache / "paper-sidecar"


DATA_DIR, CACHE_DIR = platform_dirs()
APP_DIR = Path(os.environ.get("PAPER_SIDECAR_HOME", DATA_DIR))
LEGACY_NAME = "alphaxiv-codex-sidebar"
# The extension signs in to Codex separately, so logging in or out here never touches ~/.codex.
CODEX_HOME = APP_DIR / "codex"
MAX_PROMPT_CHARS = 64000
PROVIDER_KINDS = {"openai", "anthropic"}


def migrate_legacy_dirs():
    """Move settings, login and cache from the project's former name, once."""
    if "PAPER_SIDECAR_HOME" in os.environ or sys.platform != "darwin":
        return
    library = Path.home() / "Library"
    for parent, new in [(library / "Application Support", APP_DIR),
                        (library / "Caches", library / "Caches/paper-sidecar")]:
        old = parent / LEGACY_NAME
        if old.is_dir() and not new.exists():
            try:
                old.rename(new)
            except OSError:
                pass


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def mask(key):
    if not key:
        return ""
    return f"{key[:3]}…{key[-4:]}" if len(key) > 10 else "已保存"


def parse_models(value):
    items = value if isinstance(value, list) else re.split(r"[\s,，]+", str(value or ""))
    models = []
    for item in items:
        item = str(item).strip()
        if item and item not in models and len(item) <= 200:
            models.append(item)
    return models[:100]


class UserStore:
    """Persistent store; ``path=None`` keeps everything in memory (used by tests)."""

    def __init__(self, path=APP_DIR / "settings.json"):
        self.path = Path(path) if path else None
        self.data = {"prompt": None, "providers": []}
        if self.path and self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text())
                if isinstance(loaded, dict):
                    self.data.update({key: loaded[key] for key in self.data if key in loaded})
            except (OSError, ValueError):
                pass

    def save(self):
        if not self.path:
            return
        private_dir(self.path.parent)
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".settings-")
        try:
            with os.fdopen(fd, "w") as target:
                json.dump(self.data, target, ensure_ascii=False, indent=2)
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    # Prompt -----------------------------------------------------------------
    @property
    def prompt(self):
        return self.data.get("prompt") or None

    def set_prompt(self, text):
        if text is not None and not isinstance(text, str):
            raise ValueError("提示词格式无效。")
        text = (text or "").strip()
        if len(text) > MAX_PROMPT_CHARS:
            raise ValueError(f"提示词不能超过 {MAX_PROMPT_CHARS} 字。")
        self.data["prompt"] = text or None
        self.save()

    # Providers --------------------------------------------------------------
    def provider(self, provider_id):
        return next((item for item in self.data["providers"] if item["id"] == provider_id), None)

    def public_providers(self):
        return [{**{key: value for key, value in item.items() if key != "apiKey"},
                 "keyHint": mask(item.get("apiKey"))} for item in self.data["providers"]]

    def normalize(self, draft):
        """Validate a provider sent by the page; an empty key keeps the saved key."""
        if not isinstance(draft, dict):
            raise ValueError("API 设置格式无效。")
        existing = self.provider(draft.get("id")) if draft.get("id") else None
        name = str(draft.get("name") or "").strip()[:60]
        kind = draft.get("kind")
        base_url = str(draft.get("baseUrl") or "").strip().rstrip("/")
        url = urlparse(base_url)
        if not name:
            raise ValueError("请填写 API 名称。")
        if kind not in PROVIDER_KINDS:
            raise ValueError("请选择接口类型。")
        if url.scheme not in {"https", "http"} or not url.netloc or url.username or url.password:
            raise ValueError("Base URL 需要以 https:// 或 http:// 开头，且不能包含账号密码。")
        if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("非本机地址必须使用 https://，避免 API Key 明文传输。")
        api_key = str(draft.get("apiKey") or "").strip() or (existing or {}).get("apiKey", "")
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if not api_key and not local:
            raise ValueError("请填写 API Key。")
        return {"id": existing["id"] if existing else "p" + secrets.token_hex(4), "name": name,
                "kind": kind, "baseUrl": base_url, "apiKey": api_key,
                "models": parse_models(draft.get("models")), "vision": bool(draft.get("vision"))}

    def save_provider(self, draft):
        provider = self.normalize(draft)
        if not provider["models"]:
            raise ValueError("请至少填写一个模型名称，或点击“获取模型列表”。")
        providers = self.data["providers"]
        index = next((i for i, item in enumerate(providers) if item["id"] == provider["id"]), None)
        if index is None:
            if len(providers) >= 20:
                raise ValueError("最多保存 20 个 API。")
            providers.append(provider)
        else:
            providers[index] = provider
        self.save()
        return provider

    def delete_provider(self, provider_id):
        self.data["providers"] = [item for item in self.data["providers"] if item["id"] != provider_id]
        self.save()
