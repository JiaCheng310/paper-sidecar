import asyncio
from pathlib import Path
import tempfile
import unittest

from host.cache import DiskPaperCache
from host.main import Bridge
from host.reader_settings import BUILTIN_PROMPT, ReaderSettings
from host.user_settings import UserStore


MODELS = [
    {"model": "gpt-6-sol", "displayName": "GPT-6 Sol", "isDefault": False,
     "supportedReasoningEfforts": [{"reasoningEffort": effort} for effort in ["low", "medium", "high", "ultra"]],
     "serviceTiers": [{"id": "priority", "name": "Fast", "description": "1.5x speed"}]},
    {"model": "gpt-6-astra", "displayName": "GPT-6 Astra", "isDefault": True,
     "supportedReasoningEfforts": [{"reasoningEffort": effort} for effort in ["medium", "high", "max"]],
     "serviceTiers": [{"id": "priority", "name": "Fast", "description": "2x speed"}]},
]


class FakeClient:
    def __init__(self, bridge=None):
        self.calls = []
        self.bridge = bridge
        self.next_thread = 0
        self.models = MODELS

    async def start(self):
        pass

    async def close(self):
        pass

    async def request(self, method, params):
        self.calls.append((method, params))
        if method == "model/list":
            return {"data": self.models, "nextCursor": None}
        if method == "thread/start":
            self.next_thread += 1
            return {"thread": {"id": f"thread-{self.next_thread}"}}
        if method == "turn/start":
            common = {"threadId": params["threadId"]}
            self.bridge.on_codex_event("item/completed", {**common, "item": {
                "type": "agentMessage", "phase": "final_answer", "text": "A verified answer."}})
            self.bridge.on_codex_event("turn/completed", {**common, "turn": {"id": "turn", "status": "completed"}})
            return {"turn": {"id": "turn"}}
        return {}


class ReaderSettingsTest(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_discovers_new_models_and_their_actual_fast_tiers(self):
        settings, client = ReaderSettings(), FakeClient()
        await settings.describe(client)
        client.models = [{**MODELS[0], "model": "gpt-6.1-sol", "displayName": "GPT-6.1 Sol",
                          "serviceTiers": [{"id": "priority", "name": "Fast", "description": "2x speed"}]}]
        refreshed = await settings.describe(client)
        self.assertEqual([item["id"] for item in refreshed["models"]], ["gpt-6.1-sol"])
        self.assertEqual(refreshed["models"][0]["serviceTiers"][0]["description"], "2x speed")
        resolved = await settings.resolve(client, {"model": "gpt-6.1-sol"})
        self.assertEqual(resolved["serviceTier"], "priority")
        self.assertEqual(sum(method == "model/list" for method, _ in client.calls), 2)

    async def test_defaults_and_validation_follow_the_real_model_catalog(self):
        client, settings = FakeClient(), ReaderSettings()
        resolved = await settings.resolve(client, {})
        self.assertEqual(resolved, {"model": "gpt-6-sol", "effort": "medium", "speed": "fast", "serviceTier": "priority"})
        normal = await settings.resolve(client, {"model": "gpt-6-astra", "effort": "max", "speed": "standard"})
        self.assertEqual(normal["serviceTier"], "default")
        for invalid in [{"model": "invented"}, {"effort": "ultra"}, {"speed": "1.5"}]:
            with self.assertRaises(ValueError):
                await settings.resolve(client, invalid)
        self.assertEqual(sum(method == "model/list" for method, _ in client.calls), 1)

    async def test_builtin_prompt_is_used_until_the_user_saves_one(self):
        store = UserStore(None)
        settings = ReaderSettings(store)
        default = settings.prompt()
        self.assertEqual((default["text"], default["custom"]), (BUILTIN_PROMPT, False))
        store.set_prompt("Answer like a careful reviewer.")
        custom = settings.prompt()
        self.assertTrue(custom["custom"])
        self.assertNotEqual(custom["revision"], default["revision"])
        store.set_prompt("   ")
        self.assertEqual(settings.prompt(), default)
        with self.assertRaises(ValueError):
            store.set_prompt("x" * 70000)

    async def test_turn_controls_and_prompt_updates_reach_codex_without_changing_global_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = UserStore(None)
            store.set_prompt("Use my reading workflow exactly.")
            settings = ReaderSettings(store)
            events = []
            bridge = Bridge(events.append, cache=DiskPaperCache(root / "cache"), settings=settings)
            client = FakeClient(bridge)
            bridge.client = client
            class LoadedPaper:
                def metadata(self):
                    return {"paperId": "1706.03762", "pageCount": 15, "title": "Paper"}
            async def load(_):
                return LoadedPaper()
            bridge.load = load
            message = {"type": "chat", "requestId": "one", "context": {"paperId": "1706.03762"}, "question": "Explain the method"}
            try:
                await bridge.handle(message)
                self.assertEqual(events[-1]["event"], "done", events[-1])
                start = next(params for method, params in client.calls if method == "thread/start")
                self.assertIn("Use my reading workflow exactly.", start["baseInstructions"])
                self.assertEqual(start["config"]["model_reasoning_effort"], "medium")
                turn = next(params for method, params in client.calls if method == "turn/start")
                self.assertEqual((turn["model"], turn["effort"], turn["serviceTier"]), ("gpt-6-sol", "medium", "priority"))
                await bridge.handle({**message, "requestId": "two", "settings": {"model": "gpt-6-astra", "effort": "high", "speed": "standard"}})
                turns = [params for method, params in client.calls if method == "turn/start"]
                self.assertEqual(turns[-1]["serviceTier"], "default")
                self.assertEqual(turns[-1]["threadId"], turns[0]["threadId"])
                store.set_prompt("Use the updated reading workflow.")
                await bridge.handle({**message, "requestId": "three", "history": [{"role": "user", "text": "Earlier question"}]})
                starts = [params for method, params in client.calls if method == "thread/start"]
                self.assertEqual(len(starts), 2)
                self.assertIn("Use the updated reading workflow.", starts[-1]["baseInstructions"])
                turns = [params for method, params in client.calls if method == "turn/start"]
                self.assertIn("Earlier question", turns[-1]["input"][0]["text"])
                self.assertTrue(any(method == "thread/unsubscribe" for method, _ in client.calls))
                self.assertFalse(any(method.startswith("config/") for method, _ in client.calls))
                applied = [event for event in events if event["event"] == "runtime-settings"]
                self.assertEqual(applied[-1]["prompt"], settings.prompt())

                async def reject_turn(method, params):
                    if method == "turn/start":
                        raise RuntimeError("Model unavailable")
                    return {}
                client.request = reject_turn
                events.clear()
                await bridge.handle({**message, "requestId": "rejected"})
                self.assertEqual(events[-1]["event"], "error")
                self.assertFalse(any(event["event"] == "runtime-settings" for event in events))
            finally:
                await bridge.close()


if __name__ == "__main__":
    unittest.main()
