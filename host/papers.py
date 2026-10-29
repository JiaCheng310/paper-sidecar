"""Fetch and parse public paper PDFs; text and page images are generated in memory."""

import base64
import re
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass

import pymupdf

MAX_PDF_BYTES = 24 * 1024 * 1024
MAX_CACHED_BYTES = 48 * 1024 * 1024
MAX_CACHED_PAPERS = 2
MAX_PAGES = 600
ARXIV_ID = re.compile(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v[1-9]\d*)?\Z", re.I)
PDF_HOSTS = {"arxiv.org", "www.arxiv.org", "export.arxiv.org", "pdfs.assets.alphaxiv.org"}
PAGE_HOSTS = {"www.alphaxiv.org", "alphaxiv.org", "arxiv.org", "www.arxiv.org"}


def validate_id(paper_id):
    if not isinstance(paper_id, str) or not ARXIV_ID.fullmatch(paper_id):
        raise ValueError("当前地址中没有可识别的 arXiv 论文编号。")
    return paper_id


def id_from_url(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in PAGE_HOSTS | PDF_HOSTS:
        return None
    path = urllib.parse.unquote(parsed.path).strip("/")
    path = re.sub(r"^(abs|html|pdf|overview)/", "", path)
    path = re.sub(r"\.pdf$", "", path)
    return path if ARXIV_ID.fullmatch(path) else None


def validate_pdf_url(url):
    parsed = urllib.parse.urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname not in PDF_HOSTS
            or parsed.port not in (None, 443) or parsed.username or parsed.password):
        raise ValueError("PDF 地址必须来自 arXiv 或 alphaXiv 的公开 PDF 域名。")
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        validate_pdf_url(new_url)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def fetch_pdf(url):
    """Bound response bytes before parsing; redirect validation also blocks local URLs."""
    validate_pdf_url(url)
    opener = urllib.request.build_opener(SafeRedirect())
    request = urllib.request.Request(url, headers={
        "User-Agent": "PaperSidecar/0.1 (personal academic reader)",
        "Accept": "application/pdf", "Cache-Control": "no-store",
    })
    with opener.open(request, timeout=30) as response:
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_PDF_BYTES:
            raise ValueError("PDF 超过 24 MB 读取上限，未加入缓存。")
        body = response.read(MAX_PDF_BYTES + 1)
        if len(body) > MAX_PDF_BYTES:
            raise ValueError("PDF 超过 24 MB 读取上限，未加入缓存。")
        if b"%PDF-" not in body[:1024]:
            raise ValueError("服务器没有返回 PDF，可能暂时限流或需要登录。")
        return body, response.url


def pdf_candidates(context):
    paper_id = validate_id(context.get("paperId"))
    if id_from_url(context.get("url", "")) != paper_id:
        raise ValueError("论文编号与页面地址不一致，请刷新页面。")
    candidates = []
    hinted = context.get("pdfUrl")
    if hinted:
        hinted_id = id_from_url(hinted)
        base = re.sub(r"v\d+$", "", paper_id)
        matches = (hinted_id == paper_id if re.search(r"v\d+$", paper_id)
                   else hinted_id and re.sub(r"v\d+$", "", hinted_id) == base)
        if matches:
            candidates.append(validate_pdf_url(hinted))
    candidates.append("https://arxiv.org/pdf/" + paper_id)
    return list(dict.fromkeys(candidates))


def first_page_title(document):
    """The largest-font text near the top of page 1, which is the title in almost every paper."""
    spans = []
    for block in document[0].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            if abs(line.get("dir", (1, 0))[1]) > 0.01:
                continue  # Skip rotated text such as arXiv's side stamp.
            for span in line["spans"]:
                text = span["text"].strip()
                if len(text) > 1 and span["bbox"][1] < document[0].rect.height * 0.5:
                    spans.append((round(span["size"], 1), span["bbox"][1], text))
    if not spans:
        return ""
    largest = max(size for size, _, _ in spans)
    words = [text for size, _, text in sorted(spans, key=lambda item: item[1]) if size == largest]
    title = " ".join(words).strip()
    return title if 8 <= len(title) <= 300 else ""


@dataclass
class Paper:
    paper_id: str
    url: str
    title: str
    byte_count: int
    document: object
    storage: str = "memory"

    @classmethod
    def from_bytes(cls, paper_id, url, title, body):
        document = pymupdf.open(stream=body, filetype="pdf")
        if document.needs_pass or not 0 < len(document) <= MAX_PAGES:
            document.close()
            raise ValueError("PDF 加密、没有页面或超过 600 页，无法完整读取。")
        # The PDF viewer only knows the arXiv number; read the real title from the PDF.
        if not title or re.fullmatch(r"\[?[\w./-]*\d{4}\.?\d*(v\d+)?\]?", title.strip()):
            title = document.metadata.get("title") or first_page_title(document) or paper_id
        return cls(paper_id, url, title[:500], len(body), document)

    def metadata(self):
        sample = self.document[0].get_text()
        return {"paperId": self.paper_id, "title": self.title, "pdfUrl": self.url,
                "pageCount": len(self.document), "bytes": self.byte_count,
                "hasTextLayer": len(sample.strip()) > 40,
                "storage": self.storage, "outline": self.document.get_toc()[:60]}

    def read_pages(self, start_page=1, count=4, offset=0, max_chars=16000):
        if not 1 <= start_page <= len(self.document) or not 1 <= count <= 8:
            raise ValueError("页码超出范围；每次可读取 1–8 页。")
        if offset < 0 or not 100 <= max_chars <= 24000:
            raise ValueError("读取偏移或字数上限不合法。")
        remaining, pages, next_cursor = max_chars, [], None
        end = min(start_page + count - 1, len(self.document))
        for page_number in range(start_page, end + 1):
            text = self.document[page_number - 1].get_text(sort=True)
            begin = offset if page_number == start_page else 0
            chunk = text[begin:begin + remaining]
            pages.append({"page": page_number, "text": chunk, "offset": begin,
                          "hasText": bool(text.strip())})
            remaining -= len(chunk)
            if begin + len(chunk) < len(text):
                next_cursor = {"start_page": page_number, "offset": begin + len(chunk)}
                break
            if remaining == 0 or page_number == end:
                if page_number < len(self.document):
                    next_cursor = {"start_page": page_number + 1, "offset": 0}
                break
        return {"pages": pages, "total_pages": len(self.document),
                "next_cursor": next_cursor, "source": self.url,
                "note": "Only the returned pages were read. Use next_cursor to continue; use view_paper_page for figures, formulas or scanned pages."}

    def search(self, query):
        terms = list(dict.fromkeys(re.findall(r"[\w-]{2,}", query.lower())))[:20]
        if not terms:
            raise ValueError("请提供搜索关键词。")
        hits = []
        for index in range(len(self.document)):
            text = self.document[index].get_text(sort=True)
            lower = text.lower()
            score = sum(lower.count(term) for term in terms)
            if score:
                first = min(lower.find(term) for term in terms if term in lower)
                hits.append({"page": index + 1, "score": score,
                             "snippet": text[max(0, first - 220):first + 900]})
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        return {"matches": hits[:10], "matched_pages": len(hits), "total_pages": len(self.document)}

    def page_image(self, page):
        if not 1 <= page <= len(self.document):
            raise ValueError("页码超出范围。")
        pdf_page = self.document[page - 1]
        scale = min(1.8, 1600 / max(pdf_page.rect.width, pdf_page.rect.height))
        pixmap = pdf_page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        image = pixmap.tobytes("jpeg", jpg_quality=82)
        return "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")

    def close(self):
        self.document.close()


class PaperStore:
    def __init__(self):
        self.papers = OrderedDict()

    def get(self, paper_id):
        paper = self.papers.get(paper_id)
        if paper:
            self.papers.move_to_end(paper_id)
        return paper

    def put(self, paper, protected=None):
        old = self.papers.pop(paper.paper_id, None)
        if old and old is not paper:
            old.close()
        self.papers[paper.paper_id] = paper
        while (len(self.papers) > MAX_CACHED_PAPERS or
               sum(item.byte_count for item in self.papers.values()) > MAX_CACHED_BYTES):
            keep = {paper.paper_id, *(protected if isinstance(protected, (set, list, tuple)) else [protected])}
            victim = next((key for key in self.papers if key not in keep), None)
            if victim is None:
                break
            self.papers.pop(victim).close()

    def close(self):
        for paper in self.papers.values():
            paper.close()
        self.papers.clear()
