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
        for url in ["http://127.0.0.1/private", "file:///etc/passwd", "https://arxiv.org.evil.test/a", "https://arxiv.org:444/a"]:
            with self.assertRaises(ValueError):
                validate_pdf_url(url)
        context["paperId"] = "../../etc/passwd"
        with self.assertRaises(ValueError):
            pdf_candidates(context)

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
