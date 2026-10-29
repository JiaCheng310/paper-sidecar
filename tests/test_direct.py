import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import tempfile
import threading
import unittest
from pathlib import Path

from host.direct_client import DirectSession, list_models, merge_history
from host.main import Bridge
from host.reader_settings import ReaderSettings
from host.user_settings import UserStore


class FakeAPI(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "model-b"}, {"id": "model-a"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeAPI.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if body["model"] == "broken":
            self.send_response(401)
            self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "bad key"}}).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        first = len([item for item in FakeAPI.requests if item["path"] == self.path]) % 2 == 1
        events = self.anthropic(first) if self.path.endswith("/messages") else self.openai(first)
        for event in events:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        if not self.path.endswith("/messages"):
            self.wfile.write(b"data: [DONE]\n\n")

    @staticmethod
    def openai(first):
        if first:
            return [{"choices": [{"delta": {"content": "Let me read. "}}]},
                    {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {
                        "name": "read_paper_pages", "arguments": '{"start_'}}]}}]},
                    {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {
                        "arguments": 'page": 3}'}}]}}]}]
        return [{"choices": [{"delta": {"content": "Page 3 says hi."}}]}]

    @staticmethod
    def anthropic(first):
        if first:
            return [{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Looking. "}},
                    {"type": "content_block_start", "index": 1, "content_block": {
                        "type": "tool_use", "id": "t1", "name": "view_paper_page", "input": {}}},
                    {"type": "content_block_delta", "index": 1, "delta": {
                        "type": "input_json_delta", "partial_json": '{"page": 2}'}},
                    {"type": "message_stop"}]
        return [{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Figure on p2."}}]


class DirectEngineTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeAPI.requests.clear()

    async def run_session(self, provider, model="model-a"):
        deltas, calls = [], []

        async def call_tool(name, args):
            calls.append((name, args))
            if name == "view_paper_page":
                return {"text": "page 2", "image": "data:image/jpeg;base64,QUJD"}
            return {"text": "page text"}

        session = DirectSession(provider, model, "SYSTEM", call_tool,
                                lambda item, text: deltas.append((item, text)), lambda _: None)
        answer = await session.run([{"role": "assistant", "text": "orphan"},
                                    {"role": "user", "text": "Earlier"},
                                    {"role": "assistant", "text": "Reply"}], "Question")
        return answer, deltas, calls

    async def test_openai_compatible_stream_runs_pdf_tools_and_continues(self):
        provider = {"kind": "openai", "baseUrl": self.base + "/v1", "apiKey": "sk-test", "vision": False}
        answer, deltas, calls = await self.run_session(provider)
        self.assertEqual(answer, "Let me read. \n\nPage 3 says hi.")
        self.assertEqual(calls, [("read_paper_pages", {"start_page": 3})])
        self.assertEqual({item for item, _ in deltas}, {"round-0", "round-1"})
        first, second = FakeAPI.requests
        self.assertEqual(first["path"], "/v1/chat/completions")
        self.assertEqual(first["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(first["body"]["messages"][0], {"role": "system", "content": "SYSTEM"})
        self.assertEqual(first["body"]["messages"][1]["role"], "user")
        self.assertNotIn("view_paper_page", json.dumps(first["body"]["tools"]))
        self.assertEqual(second["body"]["messages"][-1],
                         {"role": "tool", "tool_call_id": "c1", "content": "page text"})

    async def test_anthropic_stream_sends_page_images_as_tool_results(self):
        provider = {"kind": "anthropic", "baseUrl": self.base, "apiKey": "sk-ant", "vision": True}
        answer, _, calls = await self.run_session(provider)
        self.assertEqual(answer, "Looking. \n\nFigure on p2.")
        self.assertEqual(calls, [("view_paper_page", {"page": 2})])
        first, second = FakeAPI.requests
        self.assertEqual(first["path"], "/v1/messages")
        self.assertEqual(first["headers"]["X-Api-Key"], "sk-ant")
        # The system prompt (which carries the paper) is marked for prompt caching.
        self.assertEqual(first["body"]["system"], [
            {"type": "text", "text": "SYSTEM", "cache_control": {"type": "ephemeral"}}])
        result = second["body"]["messages"][-1]["content"][0]
        self.assertEqual(result["tool_use_id"], "t1")
        self.assertEqual(result["content"][1]["source"], {
            "type": "base64", "media_type": "image/jpeg", "data": "QUJD"})

    async def test_http_errors_and_model_listing(self):
        provider = {"kind": "openai", "baseUrl": self.base + "/v1", "apiKey": "k", "vision": False}
        with self.assertRaisesRegex(RuntimeError, "API Key 无效.*bad key"):
            await self.run_session(provider, "broken")
        self.assertEqual(list_models(provider), ["model-a", "model-b"])

    def test_history_alternates_and_ends_with_the_question(self):
        turns = merge_history([{"role": "assistant", "text": "x"}, {"role": "user", "text": "a"},
                               {"role": "user", "text": "b"}, {"role": "assistant", "text": ""}], "Q")
        self.assertEqual(turns, [{"role": "user", "content": "a\n\nb\n\nQ"}])


class UserSettingsTest(unittest.IsolatedAsyncioTestCase):
    async def test_keys_stay_private_and_prompt_override_reaches_the_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            store = UserStore(path)
            saved = store.save_provider({"name": "DeepSeek", "kind": "openai", "baseUrl": "https://api.example.com/v1/",
                                         "apiKey": "sk-1234567890abcd", "models": "chat, reasoner"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            public = store.public_providers()[0]
            self.assertNotIn("apiKey", public)
            self.assertEqual(public["keyHint"], "sk-…abcd")
            self.assertEqual(public["baseUrl"], "https://api.example.com/v1")
            # Saving again without a key keeps the stored key.
            store.save_provider({**public, "apiKey": "", "models": ["chat"]})
            self.assertEqual(UserStore(path).provider(saved["id"])["apiKey"], "sk-1234567890abcd")
            for invalid in [{"name": "x", "kind": "openai", "baseUrl": "http://remote.example/v1", "apiKey": "k", "models": "m"},
                            {"name": "x", "kind": "other", "baseUrl": "https://a.example", "apiKey": "k", "models": "m"},
                            {"name": "x", "kind": "openai", "baseUrl": "https://a.example", "apiKey": "", "models": "m"}]:
                with self.assertRaises(ValueError):
                    store.save_provider(invalid)

            settings = ReaderSettings(store)
            self.assertFalse(settings.prompt()["custom"])
            store.set_prompt("  Answer like a reviewer.  ")
            self.assertEqual(settings.prompt()["text"], "Answer like a reviewer.")
            resolved = settings.resolve_api({"model": f"api:{saved['id']}:chat"})
            self.assertEqual(resolved["apiModel"], "chat")
            with self.assertRaises(ValueError):
                settings.resolve_api({"model": f"api:{saved['id']}:reasoner"})

            events = []
            bridge = Bridge(events.append, settings=settings)
            bridge.store_request({"type": "save-prompt", "requestId": "p", "text": ""})
            self.assertFalse(events[-1]["prompt"]["custom"])
            self.assertNotIn("sk-1234567890abcd", json.dumps(events))
            await bridge.close()


if __name__ == "__main__":
    unittest.main()
