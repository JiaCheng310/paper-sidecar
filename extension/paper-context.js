/* Shared URL rules; do not guess a paper from the first related-paper link. */
export function paperIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      ![
        "alphaxiv.org",
        "www.alphaxiv.org",
        "arxiv.org",
        "www.arxiv.org",
        "pdfs.assets.alphaxiv.org",
      ].includes(url.hostname)
    )
      return null;
    const path = decodeURIComponent(url.pathname)
      .replace(/^\//, "")
      .replace(/^(abs|overview|pdf|html)\//, "")
      .replace(/\.pdf$/, "")
      .replace(/\/$/, "");
    return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/i.test(path)
      ? path
      : null;
  } catch {
    return null;
  }
}

export function samePaper(a, b) {
  if (!a || !b) return false;
  return /v\d+$/.test(a) ? a === b : a.replace(/v\d+$/, "") === b.replace(/v\d+$/, "");
}

export function pdfUrlForPaper(paperId, links = []) {
  for (const value of links) {
    try {
      const url = new URL(value);
      const arxiv = ["arxiv.org", "www.arxiv.org"].includes(url.hostname);
      const pdf = url.pathname.endsWith(".pdf") || (arxiv && url.pathname.startsWith("/pdf/"));
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        pdf &&
        ["arxiv.org", "www.arxiv.org", "pdfs.assets.alphaxiv.org"].includes(url.hostname) &&
        samePaper(paperId, paperIdFromUrl(value))
      )
        return url.href;
    } catch {
      /* Ignore malformed links in the page. */
    }
  }
  return `https://arxiv.org/pdf/${paperId}`;
}
