"""Opt-in live PDF + Codex test. Uses the existing account for two short turns."""
import asyncio
import json
from host.main import Bridge


async def main():
    events = []
    def receive(event):
        events.append(event)
        if event["event"] != "delta":
            print(json.dumps(event, ensure_ascii=False), flush=True)
    bridge = Bridge(receive)
    context = {"paperId": "1706.03762v7", "url": "https://www.alphaxiv.org/abs/1706.03762v7",
               "title": "Attention Is All You Need", "pdfUrl": "https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"}
    try:
        await bridge.handle({"type": "load", "requestId": "load-test", "context": context})
        assert events[-1]["event"] == "paper", events[-1]
        paper = bridge.papers.get(context["paperId"])
        assert paper.metadata()["pageCount"] == 15
        print("PDF page render bytes:", len(paper.page_image(3)), flush=True)
        await bridge.handle({"type": "chat", "requestId": "chat-one", "context": context,
                             "question": "请读取 PDF 第 3 页，并查看该页图片。用一句中文描述 Figure 1，标注页码。"})
        assert events[-1]["event"] == "done", events[-1]
        assert events[-1]["text"], "No answer"
        thread = bridge.threads[context["paperId"]]
        await bridge.handle({"type": "chat", "requestId": "chat-two", "context": context,
                             "question": "刚才我们讨论的是哪个图、哪一页？只回答图号和页码。"})
        assert bridge.threads[context["paperId"]] == thread, "Thread changed"
        assert events[-1]["event"] == "done", events[-1]
    finally:
        await bridge.close()


asyncio.run(main())
