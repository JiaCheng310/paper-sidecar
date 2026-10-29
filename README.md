<p align="center"><img src="extension/icons/icon-128.png" width="96" alt="" /></p>

<h1 align="center">Paper Sidecar</h1>

<p align="center">Read arXiv papers with AI, right next to the paper.<br />在论文旁边，用 AI 读懂 arXiv 论文。</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a></p>

---

## English

A browser extension for [alphaXiv](https://www.alphaxiv.org) and [arXiv](https://arxiv.org). The assistant reads the actual PDF and cites page numbers.

**Features**

- Works inside alphaXiv's Assistant panel; on arXiv, click the **Sidecar** button at the bottom right
- Use your ChatGPT account, or APIs like DeepSeek, Kimi, Qwen, OpenRouter, OpenAI, Claude and Ollama
- Each paper has its own conversation, with history
- Editable system prompt
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
3. Open a paper: on alphaXiv, expand the Assistant and pick **Sidecar**; on arXiv, click the **Sidecar** button at the bottom right.
4. Click **⚙** to sign in to ChatGPT or add an API key.

After updating the code, run `./install.command` again and click **Reload** on the extensions page.

### Tips

- **Enter** to send, **Shift+Enter** for a new line, **Esc** to stop.
- Select text on the page and click **引用选中内容** (quote selection) to ask about it.
- **＋** starts a new conversation; the clock button shows earlier ones.

### Privacy

Everything stays on your Mac: API keys and settings in `~/Library/Application Support/paper-sidecar/`, PDF cache in `~/Library/Caches/paper-sidecar/` (max 512 MB). Your questions are sent to the model provider you choose.

### Troubleshooting

- **No Sidecar button:** make sure it's an arXiv paper page with the Assistant open, then reload the extension and the page.
- **"本机未连接" (not connected):** run `./install.command` again and reopen the panel.
- **API error 401 / 404:** check the API key, base URL and model name.

---

## 中文

一个用于 [alphaXiv](https://www.alphaxiv.org) 和 [arXiv](https://arxiv.org) 的浏览器扩展。助手直接读取 PDF 原文，回答时标注页码。

**功能**

- 嵌入 alphaXiv 的 Assistant 面板；在 arXiv 上点击右下角的 **Sidecar** 按钮
- 支持 ChatGPT 账号，以及 DeepSeek、Kimi、通义千问、OpenRouter、OpenAI、Claude、Ollama 等 API
- 每篇论文独立对话，可查看历史
- 系统提示词可自行修改
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
3. 打开一篇论文：alphaXiv 上展开 Assistant 并选择 **Sidecar**；arXiv 上点击右下角的 **Sidecar** 按钮。
4. 点击 **⚙**，登录 ChatGPT 或添加 API Key。

更新代码后，重新运行 `./install.command`，并在扩展页点击**重新加载**。

### 使用技巧

- **Enter** 发送，**Shift+Enter** 换行，**Esc** 停止。
- 在网页上选中文字，点击**引用选中内容**，可以针对这段提问。
- **＋** 开始新对话，时钟按钮查看以前的对话。

### 隐私

数据都在你的 Mac 上：API Key 和设置在 `~/Library/Application Support/paper-sidecar/`，PDF 缓存在 `~/Library/Caches/paper-sidecar/`（最多 512 MB）。你的提问会发送给你选择的模型服务商。

### 常见问题

- **没有 Sidecar 按钮：** 确认是 arXiv 论文页面且已展开 Assistant，然后重新加载扩展并刷新页面。
- **提示“本机未连接”：** 重新运行 `./install.command`，再重新打开侧栏。
- **API 报错 401 / 404：** 检查 API Key、Base URL 和模型名称。

---

## Development · 开发

```bash
npm run check                                                   # JS tests
uv run python -m unittest discover -s tests -p 'test_*.py'      # Python tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout. 代码结构见 CONTRIBUTING.md。

## License · 许可证

[AGPL-3.0](LICENSE). Not affiliated with alphaXiv. 本项目与 alphaXiv 官方无关。
