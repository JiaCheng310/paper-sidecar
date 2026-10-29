import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from host.cache import DiskPaperCache, LATEST_VERSION_MAX_AGE
from host.main import Bridge
from tests.test_papers import make_paper

VERSIONED_URL = "https://arxiv.org/pdf/1706.03762v7"


class DiskCacheTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "cache"
        self.cache = DiskPaperCache(self.root)

    def test_reopened_cache_reuses_pdf_and_rejects_damaged_content(self):
        body = b"%PDF-fixture"
        self.assertTrue(self.cache.put(VERSIONED_URL, VERSIONED_URL, body))
        reopened = DiskPaperCache(self.root)
        self.assertEqual(reopened.get(VERSIONED_URL), (body, VERSIONED_URL))
        next(self.root.glob("*/document.pdf")).write_bytes(b"damaged")
        self.assertIsNone(reopened.get(VERSIONED_URL))

    def test_only_unversioned_urls_expire_after_one_day(self):
        latest_url = "https://arxiv.org/pdf/1706.03762"
        with patch("host.cache.time.time", return_value=1000):
            for url in [latest_url, VERSIONED_URL]:
                self.cache.put(url, url, b"%PDF-fixture")
        with patch("host.cache.time.time", return_value=1000 + LATEST_VERSION_MAX_AGE):
            self.assertIsNone(self.cache.get(latest_url))
            self.assertIsNotNone(self.cache.get(VERSIONED_URL))

    def test_limit_evicts_least_recently_used_paper(self):
        cache = DiskPaperCache(self.root, max_bytes=5000)
        urls = [f"https://arxiv.org/pdf/1706.0376{index}v1" for index in range(3)]
        body = b"%PDF-" + b"a" * 1995
        for url in urls[:2]:
            cache.put(url, url, body)
        for directory in self.root.iterdir():
            os.utime(directory, (1, 1))
        self.assertIsNotNone(cache.get(urls[0]))
        cache.put(urls[2], urls[2], body)
        self.assertIsNotNone(cache.get(urls[0]))
        self.assertIsNone(cache.get(urls[1]))
        self.assertIsNotNone(cache.get(urls[2]))
        self.assertLessEqual(cache.info()["bytes"], 5000)

    def test_clear_keeps_unrelated_files_and_does_not_follow_symlinks(self):
        self.cache.put(VERSIONED_URL, VERSIONED_URL, b"%PDF-fixture")
        note = self.root / "my-note.txt"
        note.write_text("keep")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (outside / "document.pdf").write_bytes(b"keep")
        (self.root / ("a" * 64)).symlink_to(outside, target_is_directory=True)
        self.assertGreater(self.cache.clear(), 0)
        self.assertEqual(self.cache.info()["bytes"], 0)
        self.assertIsNone(self.cache.get(VERSIONED_URL))
        self.assertEqual(note.read_text(), "keep")
        self.assertEqual((outside / "document.pdf").read_bytes(), b"keep")


class BridgeCacheTest(unittest.IsolatedAsyncioTestCase):
    async def test_reopen_avoids_fetch_and_clear_preserves_conversation_binding(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = make_paper("1706.03762v7")
            body = fixture.document.tobytes()
            fixture.close()
            context = {"paperId": "1706.03762v7", "url": "https://www.alphaxiv.org/abs/1706.03762v7"}
            first = Bridge(lambda _: None, DiskPaperCache(root))
            try:
                with patch("host.main.fetch_pdf", return_value=(body, VERSIONED_URL)) as fetch:
                    paper = await first.load(context)
                    self.assertEqual(paper.metadata()["storage"], "disk-cache")
                    self.assertEqual(fetch.call_count, 1)
            finally:
                await first.close()

            events = []
            second = Bridge(events.append, DiskPaperCache(root))
            try:
                with patch("host.main.fetch_pdf", side_effect=AssertionError("Unexpected network request")):
                    paper = await second.load(context)
                    self.assertEqual(len(paper.document), 3)
                second.threads[context["paperId"]] = "existing-conversation"
                second.thread_papers["existing-conversation"] = context["paperId"]
                await second.handle({"type": "clear-cache", "requestId": "clear"})
                self.assertEqual(events[-1]["event"], "cache-cleared")
                self.assertEqual(events[-1]["cache"]["bytes"], 0)
                self.assertEqual(second.threads[context["paperId"]], "existing-conversation")
                self.assertEqual(second.thread_papers["existing-conversation"], context["paperId"])
                self.assertTrue(paper.document.is_closed)
                with patch("host.main.fetch_pdf", return_value=(body, VERSIONED_URL)) as fetch:
                    await second.load(context)
                    self.assertEqual(fetch.call_count, 1)
            finally:
                await second.close()

    async def test_clear_during_active_answer_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            cache = DiskPaperCache(root)
            cache.put(VERSIONED_URL, VERSIONED_URL, b"%PDF-fixture")
            events = []
            bridge = Bridge(events.append, cache)
            try:
                bridge.turns = {"1706.03762v7": {"paperId": "1706.03762v7"}}
                await bridge.handle({"type": "clear-cache", "requestId": "busy-clear"})
                self.assertEqual(events[-1]["event"], "error")
                self.assertIsNotNone(cache.get(VERSIONED_URL))
            finally:
                await bridge.close()


if __name__ == "__main__":
    unittest.main()
