"""Bounded, disposable PDF storage in one user-owned cache directory."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.parse

from host.papers import MAX_PDF_BYTES, validate_pdf_url
from host.user_settings import CACHE_DIR

DEFAULT_CACHE_DIR = CACHE_DIR
MAX_DISK_CACHE_BYTES = 512 * 1024 * 1024
LATEST_VERSION_MAX_AGE = 24 * 60 * 60
ENTRY_NAME = re.compile(r"[a-f0-9]{64}\Z")


class DiskPaperCache:
    def __init__(self, root=DEFAULT_CACHE_DIR, max_bytes=MAX_DISK_CACHE_BYTES):
        self.root = Path(root)
        self.max_bytes = max_bytes

    def _directory(self, url):
        return self.root / hashlib.sha256(url.encode()).hexdigest()

    def _entries(self):
        if not self.root.exists():
            return []
        if self.root.is_symlink():
            raise ValueError("缓存目录不能是符号链接。")
        entries = []
        for folder in self.root.iterdir():
            if not ENTRY_NAME.fullmatch(folder.name) or folder.is_symlink() or not folder.is_dir():
                continue
            try:
                size = sum(path.stat().st_size for path in folder.iterdir()
                           if path.is_file() and not path.is_symlink())
                entries.append((folder, size, folder.stat().st_mtime))
            except FileNotFoundError:
                continue  # Another sidebar may have cleared the same disposable entry.
        return entries

    def info(self):
        try:
            entries = self._entries()
        except (OSError, ValueError) as error:
            return {"path": str(self.root), "bytes": None, "papers": None,
                    "maxBytes": self.max_bytes, "error": str(error)}
        return {"path": str(self.root), "bytes": sum(size for _, size, _ in entries),
                "papers": len(entries), "maxBytes": self.max_bytes}

    def get(self, url):
        folder = self._directory(url)
        try:
            if self.root.is_symlink() or folder.is_symlink():
                return None
            metadata_path, pdf_path = folder / "metadata.json", folder / "document.pdf"
            if metadata_path.is_symlink() or pdf_path.is_symlink():
                return None
            with metadata_path.open("rb") as stream:
                metadata = json.loads(stream.read(4096))
            if metadata.get("sourceUrl") != url:
                return None
            versioned = re.search(r"v[1-9]\d*(?:\.pdf)?$", urllib.parse.urlparse(url).path)
            if not versioned and time.time() - metadata["fetchedAt"] >= LATEST_VERSION_MAX_AGE:
                return None
            with pdf_path.open("rb") as stream:
                body = stream.read(MAX_PDF_BYTES + 1)
            if (len(body) > MAX_PDF_BYTES or
                    hashlib.sha256(body).hexdigest() != metadata["sha256"]):
                return None
            final_url = validate_pdf_url(metadata["pdfUrl"])
            os.utime(folder, None)
            return body, final_url
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return None  # A missing, stale or damaged entry is fetched again.

    def put(self, url, final_url, body):
        if len(body) > MAX_PDF_BYTES:
            return False
        folder = self._directory(url)
        try:
            if self.root.is_symlink() or folder.is_symlink():
                return False
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            metadata = {"sourceUrl": url, "pdfUrl": final_url, "fetchedAt": time.time(),
                        "sha256": hashlib.sha256(body).hexdigest()}
            self._write_atomic(folder / "document.pdf", body)
            self._write_atomic(folder / "metadata.json", json.dumps(metadata).encode())
            os.utime(folder, None)
            self._prune()
            return (folder / "document.pdf").exists()
        except (OSError, ValueError):
            return False  # Cache failure must not prevent reading the fetched PDF.

    @staticmethod
    def _write_atomic(path, content):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".write-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            temporary.replace(path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def _prune(self):
        entries = sorted(self._entries(), key=lambda item: item[2])
        total = sum(size for _, size, _ in entries)
        for folder, size, _ in entries:
            if total <= self.max_bytes:
                break
            self._remove(folder)
            total -= size

    @staticmethod
    def _remove(folder):
        try:
            shutil.rmtree(folder)
        except FileNotFoundError:
            pass

    def clear(self):
        removed = 0
        for folder, size, _ in self._entries():
            self._remove(folder)
            removed += size
        return removed


def main():
    parser = argparse.ArgumentParser(description="查看或清理 Paper Sidecar 的论文缓存；保留聊天记录。")
    parser.add_argument("--clear", action="store_true", help="清理固定目录中的论文缓存")
    args = parser.parse_args()
    cache = DiskPaperCache()
    if args.clear:
        removed = cache.clear()
        print(f"已清理 {removed / 1024 / 1024:.1f} MB 论文缓存，聊天记录保留。")
    print(json.dumps(cache.info(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
