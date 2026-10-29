import unittest
import pymupdf

from host.papers import Paper, PaperStore, pdf_candidates, validate_pdf_url


def make_paper(key="1706.03762"):
    doc = pymupdf.open()
    for index in range(3):
        page = doc.new_page()
        page.insert_text((50, 50), f"Page {index + 1}: Attention and transformers. " * 5)
    body = doc.tobytes()
    doc.close()
    return Paper.from_bytes(key, "https://arxiv.org/pdf/" + key, "Fixture", body)


class PapersTest(unittest.TestCase):
    def test_full_text_covers_every_page_and_marks_where_it_stops(self):
        paper = make_paper()
        text, cursor = paper.full_text()
        self.assertIsNone(cursor)
        for page in (1, 2, 3):
            self.assertIn(f"[PDF page {page}]\nPage {page}:", text)
        first_page = len(" ".join(paper.document[0].get_text(sort=True).split()))
        cut, cursor = paper.full_text(max_chars=first_page + 10)
        self.assertEqual(cursor, {"start_page": 2, "offset": 10})
        self.assertIn("[PDF page 2]", cut)
        self.assertNotIn("[PDF page 3]", cut)

    def test_page_reads_resume_without_losing_text(self):
        paper = make_paper()
        first = paper.read_pages(1, 1, max_chars=100)
        cursor = first["next_cursor"]
        second = paper.read_pages(cursor["start_page"], 1, cursor["offset"])
        self.assertEqual(first["pages"][0]["text"] + second["pages"][0]["text"], paper.document[0].get_text(sort=True))
        self.assertEqual(first["pages"][0]["page"], 1)
        self.assertTrue(paper.page_image(2).startswith("data:image/jpeg;base64,"))
        self.assertEqual(paper.search("transformers")["matched_pages"], 3)
        paper.close()

    def test_only_matching_public_pdf_urls_are_used(self):
        context = {"paperId": "1706.03762v1", "url": "https://www.alphaxiv.org/abs/1706.03762v1",
                   "pdfUrl": "https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"}
        self.assertEqual(pdf_candidates(context), ["https://arxiv.org/pdf/1706.03762v1"])
        # alphaXiv asset links are never fetched; their version maps to arXiv.
        latest = {**context, "paperId": "1706.03762", "url": "https://www.alphaxiv.org/abs/1706.03762"}
        self.assertEqual(pdf_candidates(latest), ["https://arxiv.org/pdf/1706.03762v7", "https://arxiv.org/pdf/1706.03762"])
        with self.assertRaises(ValueError):
            validate_pdf_url("https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf")
        for url in ["http://127.0.0.1/private", "file:///etc/passwd", "https://arxiv.org.evil.test/a", "https://arxiv.org:444/a"]:
            with self.assertRaises(ValueError):
                validate_pdf_url(url)
        context["paperId"] = "../../etc/passwd"
        with self.assertRaises(ValueError):
            pdf_candidates(context)

    def test_arxiv_downloads_are_spaced_and_identify_the_tool(self):
        import time
        from unittest import mock
        from host import papers
        calls = []

        def download(opener, request):
            calls.append((time.monotonic(), request.get_header("User-agent")))
            return b"%PDF-", request.full_url

        with mock.patch.object(papers, "ARXIV_REQUEST_GAP", 0.2), mock.patch.object(papers, "_download", download):
            papers.fetch_pdf("https://arxiv.org/pdf/1706.03762")
            papers.fetch_pdf("https://arxiv.org/pdf/2401.12345")
        self.assertGreaterEqual(calls[1][0] - calls[0][0], 0.19)
        self.assertIn("github.com/JiaCheng310/paper-sidecar", calls[0][1])

    def test_memory_cache_evicts_old_documents_but_protects_active_paper(self):
        store = PaperStore()
        first = make_paper("1706.03762")
        second = make_paper("1706.03763")
        third = make_paper("1706.03764")
        store.put(first)
        store.put(second)
        store.put(third, protected=first.paper_id)
        self.assertIs(store.get(first.paper_id), first)
        self.assertIsNone(store.get(second.paper_id))
        self.assertTrue(second.document.is_closed)
        store.close()


if __name__ == "__main__":
    unittest.main()
