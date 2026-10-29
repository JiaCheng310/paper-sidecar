"""Direct streaming clients for third-party model APIs, with the same local PDF tools.

Two wire formats cover most providers: OpenAI-compatible Chat Completions (OpenAI, DeepSeek,
Kimi, Qwen, OpenRouter, Ollama, ...) and Anthropic Messages. Only the standard library is used;
blocking HTTP runs in a worker thread and streams Server-Sent Events back to the event loop.
"""

import asyncio
import json
import threading
import urllib.error
import urllib.request

from host.codex_client import READER_INSTRUCTIONS, paper_tools

MAX_TOOL_ROUNDS = 16
USER_AGENT = "paper-sidecar/0.1"

DIRECT_INSTRUCTIONS = "\n".join(
    line for line in READER_INSTRUCTIONS.splitlines()
    if "web search" not in line.lower() and "search could not" not in line
) + """
Web search is not available with this model. If background or follow-up research is needed,
say so and answer from the paper and general knowledge, clearly labelled as such.
"""


class DirectAPIError(RuntimeError):
    pass


def chat_url(provider):
    return provider["baseUrl"].rstrip("/") + "/chat/completions"


def anthropic_root(provider):
    base = provider["baseUrl"].rstrip("/")
    return base if base.endswith("/v1") else base + "/v1"


def headers_for(provider):
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    key = provider.get("apiKey")
    if provider["kind"] == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
    elif key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def describe_http_error(error):
    try:
        body = error.read().decode("utf-8", "replace")
        detail = json.loads(body)
        detail = detail.get("error", detail)
        message = detail.get("message") if isinstance(detail, dict) else str(detail)
    except Exception:
        message = ""
    finally:
        error.close()
    hints = {401: "API Key 无效或已过期", 403: "没有访问权限", 404: "地址或模型名称不存在",
             429: "请求过于频繁或额度不足"}
    prefix = hints.get(error.code, f"HTTP {error.code}")
    return f"{prefix}{'：' + message[:300] if message else ''}"


def list_models(provider, timeout=20):
    url = (anthropic_root(provider) if provider["kind"] == "anthropic"
           else provider["baseUrl"].rstrip("/")) + "/models"
    request = urllib.request.Request(url, headers=headers_for(provider))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise DirectAPIError("获取模型列表失败：" + describe_http_error(error)) from error
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise DirectAPIError(f"获取模型列表失败：{getattr(error, 'reason', error)}") from error
    items = payload.get("data", payload.get("models", [])) if isinstance(payload, dict) else payload
    return sorted({str(item.get("id") or item.get("name")) for item in items
                   if isinstance(item, dict) and (item.get("id") or item.get("name"))})


async def stream_events(url, headers, body, cancel):
    """Yield parsed ``data:`` payloads from an SSE response without blocking the loop."""
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    done = object()

    def worker():
        request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers,
                                         method="POST")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                for raw in response:
                    if cancel.is_set():
                        break
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data and data != "[DONE]":
                            loop.call_soon_threadsafe(queue.put_nowait, data)
        except urllib.error.HTTPError as error:
            loop.call_soon_threadsafe(queue.put_nowait, DirectAPIError(describe_http_error(error)))
        except Exception as error:
            reason = getattr(error, "reason", None) or error
            loop.call_soon_threadsafe(queue.put_nowait, DirectAPIError(f"无法连接 API：{reason}"))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    threading.Thread(target=worker, daemon=True).start()
    while (item := await queue.get()) is not done:
        if isinstance(item, Exception):
            raise item
        try:
            yield json.loads(item)
        except ValueError:
            continue


def tool_specs(vision):
    tools = paper_tools()
    return [tool for tool in tools if vision or tool["name"] != "view_paper_page"]


def merge_history(history, question):
    """Alternate user/assistant turns (Anthropic requires it) and end with the question."""
    turns = []
    for item in history:
        role = item.get("role") if isinstance(item, dict) else None
        text = str(item.get("text") or "").strip() if role else ""
        if role not in {"user", "assistant"} or not text:
            continue
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + text
        else:
            turns.append({"role": role, "content": text})
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    if turns and turns[-1]["role"] == "user":
        turns[-1]["content"] += "\n\n" + question
    else:
        turns.append({"role": "user", "content": question})
    return turns


class DirectSession:
    """Run one answer: stream text, execute PDF tool calls, repeat until the model is done."""

    def __init__(self, provider, model, system, call_tool, on_delta, on_status):
        self.provider, self.model, self.system = provider, model, system
        self.call_tool, self.on_delta, self.on_status = call_tool, on_delta, on_status
        self.cancel = threading.Event()
        self.texts = []

    async def run(self, history, question):
        turns = merge_history(history, question)
        runner = self.run_anthropic if self.provider["kind"] == "anthropic" else self.run_openai
        await runner(turns)
        return "\n\n".join(text for text in self.texts if text.strip())

    def emit(self, round_index, text):
        while len(self.texts) <= round_index:
            self.texts.append("")
        self.texts[round_index] += text
        self.on_delta(f"round-{round_index}", text)

    async def use_tool(self, name, raw_arguments):
        try:
            args = json.loads(raw_arguments or "{}") if isinstance(raw_arguments, str) else raw_arguments
            return await self.call_tool(name, args or {})
        except Exception as error:
            return {"text": f"Tool error: {error}"}

    # OpenAI-compatible Chat Completions --------------------------------------
    async def run_openai(self, turns):
        messages = [{"role": "system", "content": self.system}, *turns]
        tools = [{"type": "function", "function": {"name": tool["name"], "description": tool["description"],
                                                    "parameters": tool["inputSchema"]}}
                 for tool in tool_specs(self.provider.get("vision"))]
        for round_index in range(MAX_TOOL_ROUNDS + 1):
            body = {"model": self.model, "messages": messages, "stream": True}
            if round_index < MAX_TOOL_ROUNDS:
                body["tools"] = tools
            text, reasoning, calls = "", "", {}
            async for chunk in stream_events(chat_url(self.provider), headers_for(self.provider),
                                             body, self.cancel):
                if chunk.get("error"):
                    raise DirectAPIError(str(chunk["error"].get("message", chunk["error"]))[:300])
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        text += delta["content"]
                        self.emit(round_index, delta["content"])
                    if delta.get("reasoning_content"):
                        if not reasoning:
                            self.on_status("模型正在推理")
                        reasoning += delta["reasoning_content"]
                    for call in delta.get("tool_calls") or []:
                        slot = calls.setdefault(call.get("index", len(calls)),
                                                {"id": "", "name": "", "arguments": ""})
                        slot["id"] = call.get("id") or slot["id"]
                        function = call.get("function") or {}
                        slot["name"] += function.get("name") or ""
                        slot["arguments"] += function.get("arguments") or ""
            if self.cancel.is_set() or not calls:
                return
            assistant = {"role": "assistant", "content": text or None, "tool_calls": [
                {"id": call["id"] or f"call_{index}", "type": "function",
                 "function": {"name": call["name"], "arguments": call["arguments"] or "{}"}}
                for index, call in sorted(calls.items())]}
            if reasoning:
                assistant["reasoning_content"] = reasoning  # DeepSeek needs it during tool loops.
            messages.append(assistant)
            images = []
            for call in assistant["tool_calls"]:
                result = await self.use_tool(call["function"]["name"], call["function"]["arguments"])
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": result["text"]})
                if result.get("image"):
                    images.append(result["image"])
            if images:
                messages.append({"role": "user", "content": [
                    {"type": "text", "text": "Rendered PDF page image(s) returned by view_paper_page."},
                    *({"type": "image_url", "image_url": {"url": image}} for image in images)]})
            if self.cancel.is_set():
                return

    # Anthropic Messages -------------------------------------------------------
    async def run_anthropic(self, turns):
        messages = [dict(turn) for turn in turns]
        tools = [{"name": tool["name"], "description": tool["description"],
                  "input_schema": tool["inputSchema"]} for tool in tool_specs(self.provider.get("vision"))]
        url = anthropic_root(self.provider) + "/messages"
        for round_index in range(MAX_TOOL_ROUNDS + 1):
            body = {"model": self.model, "max_tokens": 16000, "system": self.system,
                    "messages": messages, "stream": True}
            if round_index < MAX_TOOL_ROUNDS:
                body["tools"] = tools
            blocks = {}
            async for event in stream_events(url, headers_for(self.provider), body, self.cancel):
                kind = event.get("type")
                if kind == "error":
                    raise DirectAPIError(str((event.get("error") or {}).get("message", event))[:300])
                if kind == "content_block_start":
                    block = dict(event["content_block"])
                    if block.get("type") == "tool_use":
                        block["partial"] = ""
                    blocks[event["index"]] = block
                elif kind == "content_block_delta":
                    block, delta = blocks.get(event["index"]), event.get("delta") or {}
                    if not block:
                        continue
                    if delta.get("type") == "text_delta":
                        block["text"] = block.get("text", "") + delta["text"]
                        self.emit(round_index, delta["text"])
                    elif delta.get("type") == "input_json_delta":
                        block["partial"] += delta.get("partial_json", "")
                    elif delta.get("type") == "thinking_delta":
                        block["thinking"] = block.get("thinking", "") + delta.get("thinking", "")
                    elif delta.get("type") == "signature_delta":
                        block["signature"] = block.get("signature", "") + delta.get("signature", "")
            if self.cancel.is_set():
                return
            content, uses = [], []
            for _, block in sorted(blocks.items()):
                if block.get("type") == "tool_use":
                    try:
                        block["input"] = json.loads(block.pop("partial") or "{}")
                    except ValueError:
                        block["input"] = {}
                    uses.append(block)
                if block.get("type") != "text" or block.get("text"):
                    content.append(block)
            if not uses:
                return
            messages.append({"role": "assistant", "content": content})
            results = []
            for use in uses:
                result = await self.use_tool(use["name"], use["input"])
                parts = [{"type": "text", "text": result["text"]}]
                if result.get("image"):
                    media, _, data = result["image"].partition(";base64,")
                    parts.append({"type": "image", "source": {
                        "type": "base64", "media_type": media.removeprefix("data:"), "data": data}})
                results.append({"type": "tool_result", "tool_use_id": use["id"], "content": parts})
            messages.append({"role": "user", "content": results})
