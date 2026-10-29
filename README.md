<p align="center"><img src="extension/icons/icon-128.png" width="96" alt="" /></p>

<h1 align="center">Paper Sidecar</h1>

<p align="center">Read arXiv papers with AI, right next to the paper.<br />在论文旁边，用 AI 读懂 arXiv 论文。</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a></p>

---

## English

A browser extension for [alphaXiv](https://www.alphaxiv.org) and [arXiv](https://arxiv.org). The assistant reads the actual PDF and cites page numbers.

**Features**

- A small icon at the bottom right of alphaXiv and arXiv paper pages opens a panel docked on the right that narrows the page instead of covering it; drag its edge to resize
- Use your ChatGPT account, or APIs like DeepSeek, Kimi, Qwen, OpenRouter, OpenAI, Claude and Ollama
- Each paper has its own conversation, with history
- A thorough default reading workflow based on [PaperForge](https://github.com/FeijiangHan/PaperForge), editable in settings
- Runs locally; API keys never leave your Mac

### Install

You need macOS, Edge or Chrome, [uv](https://docs.astral.sh/uv/) and Node.js 18+.

```bash
git clone https://github.com/JiaCheng310/paper-sidecar.git
cd paper-sidecar
./install.command
```

Then in your browser:

1. Open `edge://extensions` or `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Open a paper on alphaXiv or arXiv and click the robot icon at the bottom right. In arXiv's PDF view, click the toolbar icon (marked **AI**) to use the browser side panel.
4. Click **⚙** to sign in to ChatGPT or add an API key.

After updating the code, run `./install.command` again and click **Reload** on the extensions page.

### Tips

- **Enter** to send, **Shift+Enter** for a new line, **Esc** to stop.
- Select text on the paper page and click **问 Sidecar** to ask about it.
- **＋** starts a new conversation; the clock button shows earlier ones.
- Drag the panel's left edge to resize it; the width is remembered.
- With a ChatGPT account, the footer shows your plan usage (hover for reset times).

### Privacy

PDFs come only from arXiv. Everything stays on your Mac: API keys and settings in `~/Library/Application Support/paper-sidecar/`, PDF cache in `~/Library/Caches/paper-sidecar/` (max 512 MB). Your questions are sent to the model provider you choose.

### Troubleshooting

- **No icon on the page:** make sure it's a paper page (with an arXiv ID), then reload the extension and the page. In the PDF view, use the toolbar icon.
- **"本机未连接" (not connected):** run `./install.command` again and reopen the panel.
- **API error 401 / 404:** check the API key, base URL and model name.

---

## 中文

一个用于 [alphaXiv](https://www.alphaxiv.org) 和 [arXiv](https://arxiv.org) 的浏览器扩展。助手直接读取 PDF 原文，回答时标注页码。

**功能**

- 在 alphaXiv 和 arXiv 论文页右下角点击小图标，在页面右侧打开面板，页面会相应变窄而不是被遮住，拖动边缘可调整宽度
- 支持 ChatGPT 账号，以及 DeepSeek、Kimi、通义千问、OpenRouter、OpenAI、Claude、Ollama 等 API
- 每篇论文独立对话，可查看历史
- 默认采用 [PaperForge](https://github.com/FeijiangHan/PaperForge) 的论文精读流程，可在设置中修改
- 在本机运行，API Key 只保存在你的 Mac 上

### 安装

需要 macOS、Edge 或 Chrome、[uv](https://docs.astral.sh/uv/) 和 Node.js 18 以上。

```bash
git clone https://github.com/JiaCheng310/paper-sidecar.git
cd paper-sidecar
./install.command
```

然后在浏览器中：

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启**开发人员模式**。
2. 点击**加载解压缩的扩展**，选择 `extension` 文件夹。
3. 在 alphaXiv 或 arXiv 打开一篇论文，点击右下角的机器人图标。在 arXiv 的 PDF 页面，点击工具栏图标（带 **AI** 标记）使用浏览器侧栏。
4. 点击 **⚙**，登录 ChatGPT 或添加 API Key。

更新代码后，重新运行 `./install.command`，并在扩展页点击**重新加载**。

### 使用技巧

- **Enter** 发送，**Shift+Enter** 换行，**Esc** 停止。
- 在论文页上选中文字，点击弹出的**问 Sidecar**，就能针对这段提问。
- **＋** 开始新对话，时钟按钮查看以前的对话。
- 拖动面板左边缘可以调整宽度，会自动记住。
- 登录 ChatGPT 账号后，底部会显示额度使用情况（悬停查看重置时间）。

### 隐私

PDF 只从 arXiv 下载。数据都在你的 Mac 上：API Key 和设置在 `~/Library/Application Support/paper-sidecar/`，PDF 缓存在 `~/Library/Caches/paper-sidecar/`（最多 512 MB）。你的提问会发送给你选择的模型服务商。

### 常见问题

- **页面上没有图标：** 确认是带 arXiv 编号的论文页面，然后重新加载扩展并刷新页面。PDF 页面请使用工具栏图标。
- **提示“本机未连接”：** 重新运行 `./install.command`，再重新打开侧栏。
- **API 报错 401 / 404：** 检查 API Key、Base URL 和模型名称。

---

## Development · 开发

```bash
npm run check                                                   # JS tests
uv run python -m unittest discover -s tests -p 'test_*.py'      # Python tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout. 代码结构见 CONTRIBUTING.md。

## Disclaimer · 免责声明

Paper Sidecar is an independent, non-commercial open-source project. It is not affiliated with, endorsed by or sponsored by arXiv or alphaXiv; their names are trademarks of their respective owners and are used only to describe compatibility.

- It only adds a small button and its own panel on top of paper pages in **your own browser**. It does not change alphaXiv's or arXiv's content, and does not call alphaXiv's AI or servers.
- PDFs are downloaded **only from arXiv**, one at a time with at least 3 seconds between requests, and cached on your Mac for your personal reading. Nothing is redistributed.
- You are responsible for following the terms of the sites you use, the license of each paper, and the terms of the model provider you choose.

Paper Sidecar 是独立的非商业开源项目，与 arXiv、alphaXiv 没有任何关联，也未获得其认可或赞助；相关名称归各自所有者，仅用于说明兼容性。

- 它只在**你自己浏览器**的论文页上加一个小按钮和自己的面板，不修改 alphaXiv 或 arXiv 的页面内容，也不调用 alphaXiv 的 AI 或服务器。
- PDF **只从 arXiv 下载**，每次一个、间隔至少 3 秒，仅缓存在你的 Mac 上供个人阅读，不会再分发。
- 请自行遵守所用网站的条款、每篇论文的许可，以及你所选模型服务商的条款。

## License · 许可证

[AGPL-3.0](LICENSE). The default system prompt (`host/default_prompt.md`) comes from [PaperForge](https://github.com/FeijiangHan/PaperForge) by FeijiangHan. 默认系统提示词来自 FeijiangHan 的 PaperForge。
