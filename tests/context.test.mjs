import test from "node:test";
import assert from "node:assert/strict";
import { paperIdFromUrl, samePaper, pdfUrlForPaper } from "../extension/paper-context.js";

test("tracks the actual current paper and exact version", () => {
  assert.equal(
    paperIdFromUrl("https://www.alphaxiv.org/abs/1706.03762v7?x=1#page=2"),
    "1706.03762v7",
  );
  assert.equal(paperIdFromUrl("https://arxiv.org/pdf/hep-th/9901001v2"), "hep-th/9901001v2");
  assert.equal(paperIdFromUrl("https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"), "1706.03762v7");
  assert.equal(samePaper("1706.03762v1", "1706.03762v7"), false);
  assert.equal(samePaper("1706.03762", "1706.03762v7"), true);
});
test("home pages and unrelated sites never become paper context", () => {
  for (const url of [
    "https://www.alphaxiv.org/",
    "https://example.com/abs/1706.03762",
    "https://alphaxiv.org.evil.test/abs/1706.03762",
    "file:///tmp/1706.03762",
    "https://www.alphaxiv.org/explore",
  ]) {
    assert.equal(paperIdFromUrl(url), null);
  }
});

test("the reader selects the current PDF version and ignores unrelated or unsafe links", () => {
  assert.equal(
    pdfUrlForPaper("1706.03762v1", [
      "https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf",
      "https://arxiv.org:8080/pdf/1706.03762v1",
      "https://user:password@arxiv.org/pdf/1706.03762v1",
      "https://example.com/1706.03762v1.pdf",
    ]),
    "https://arxiv.org/pdf/1706.03762v1",
  );
  assert.equal(
    pdfUrlForPaper("1706.03762", ["https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"]),
    "https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf",
  );
});
