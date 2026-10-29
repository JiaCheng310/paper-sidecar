<p align="center"><img src="extension/icons/icon-128.png" width="96" alt="" /></p>

<h1 align="center">Paper Sidecar</h1>

<p align="center">Read arXiv papers with AI, right next to the paper.<br />在论文旁边，用 AI 读懂 arXiv 论文。</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a></p>

---

## English

A browser extension for [alphaXiv](https://www.alphaxiv.org) and [arXiv](https://arxiv.org). The assistant reads the whole PDF and cites page numbers.

- Click the robot icon on a paper page; a panel opens on the right
- Use your ChatGPT account, or DeepSeek, Kimi, Qwen, OpenRouter, OpenAI, Claude, Ollama
- Each paper keeps its own conversations
- Default reading workflow from [PaperForge](https://github.com/FeijiangHan/PaperForge), editable in settings
- Works on macOS and Windows; everything stays on your computer

### Install

**1. Install two tools** (once): [Node.js](https://nodejs.org) (LTS) and [uv](https://docs.astral.sh/uv/getting-started/installation/).

**2. Download** this project: click **Code → Download ZIP** above and unzip it, or `git clone https://github.com/JiaCheng310/paper-sidecar.git`.

**3. Run the installer** in the project folder:

- **macOS:** double-click `install.command`
- **Windows:** double-click `install.bat`

**4. Load the extension** in Edge or Chrome:

1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder (its path is already on your clipboard).
3. Open a paper on alphaXiv or arXiv, click the robot icon, then **⚙** to sign in to ChatGPT or add an API key.

To update: download the new version, run the installer again, and click **Reload** on the extensions page.

### Tips

- **Enter** sends, **Shift+Enter** adds a line, **Esc** stops.
- Select text on the paper and click **问 Sidecar** to ask about it.
- **＋** starts a new conversation; the clock button shows earlier ones.
- Drag the panel's left edge to resize it. In arXiv's PDF view, use the toolbar icon.

### Troubleshooting

- **macOS says the installer can't be opened:** right-click `install.command` → **Open**, or run `zsh install.command` in Terminal.
- **Windows shows "Windows protected your PC":** click **More info → Run anyway**.
- **"本机未连接" (not connected):** run the installer again, then reopen the panel.
- **No icon on the page:** make sure it is a paper page, then reload the extension.
- **API error 401 / 404:** check the API key, base URL and model name.

---

## 中文

一个用于 [alphaXiv](https://www.alphaxiv.org) 和 [arXiv](https://arxiv.org) 的浏览器扩展。助手读取整篇 PDF，回答时标注页码。

- 在论文页点击机器人图标，右侧打开面板
- 支持 ChatGPT 账号，以及 DeepSeek、Kimi、通义千问、OpenRouter、OpenAI、Claude、Ollama
- 每篇论文的对话互不干扰
- 默认采用 [PaperForge](https://github.com/FeijiangHan/PaperForge) 的精读流程，可在设置中修改
- 支持 macOS 和 Windows，数据都留在你的电脑上

### 安装

**1. 安装两个工具**（只需一次）：[Node.js](https://nodejs.org)（LTS 版）和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

**2. 下载**本项目：点上方 **Code → Download ZIP** 并解压，或 `git clone https://github.com/JiaCheng310/paper-sidecar.git`。

**3. 运行安装程序**（在项目文件夹里）：

- **macOS：** 双击 `install.command`
- **Windows：** 双击 `install.bat`

**4. 在 Edge 或 Chrome 中加载扩展：**

1. 打开 `edge://extensions`（或 `chrome://extensions`），开启**开发人员模式**。
2. 点击**加载解压缩的扩展**，选择 `extension` 文件夹（路径已复制到剪贴板）。
3. 打开 alphaXiv 或 arXiv 的论文，点击机器人图标，再点 **⚙** 登录 ChatGPT 或添加 API Key。

更新：下载新版本，重新运行安装程序，在扩展页点击**重新加载**。

### 使用技巧

- **Enter** 发送，**Shift+Enter** 换行，**Esc** 停止。
- 在论文上选中文字，点击 **问 Sidecar**，就能针对这段提问。
- **＋** 开始新对话，时钟按钮查看以前的对话。
- 拖动面板左边缘调整宽度。arXiv 的 PDF 页面请点工具栏图标。

### 常见问题

- **macOS 提示无法打开安装程序：** 右键 `install.command` → **打开**，或在终端运行 `zsh install.command`。
- **Windows 提示“Windows 已保护你的电脑”：** 点击**更多信息 → 仍要运行**。
- **提示“本机未连接”：** 重新运行安装程序，再重新打开面板。
- **页面上没有图标：** 确认是论文页面，然后重新加载扩展。
- **API 报错 401 / 404：** 检查 API Key、Base URL 和模型名称。

---

## Privacy · 隐私

Everything is stored on your computer. 数据都保存在你的电脑上：

| | macOS | Windows |
| --- | --- | --- |
| Settings, API keys · 设置与 API Key | `~/Library/Application Support/paper-sidecar/` | `%LOCALAPPDATA%\paper-sidecar\` |
| PDF cache · PDF 缓存 | `~/Library/Caches/paper-sidecar/` | `%LOCALAPPDATA%\paper-sidecar\cache\` |

The PDF cache is capped at 512 MB and old conversations are pruned automatically; to clear the cache by hand, use the button at the bottom of the panel or double-click `clear-cache.command` / `clear-cache.bat`. Your questions are sent to the model provider you choose. PDF 缓存上限 512 MB，旧对话会自动清理；也可以点面板底部的“清理缓存”，或双击 `clear-cache.command` / `clear-cache.bat`。你的提问会发送给你所选的模型服务商。

## Disclaimer · 免责声明

Paper Sidecar is an independent, non-commercial open-source project, not affiliated with or endorsed by arXiv or alphaXiv. It adds a button and its own panel in your browser and does not change their content or call alphaXiv's AI. PDFs are downloaded only from arXiv, one at a time and at least 3 seconds apart, for personal reading. Please follow each site's terms, each paper's license and your model provider's terms.

Paper Sidecar 是独立的非商业开源项目，与 arXiv、alphaXiv 无关，也未获其认可。它只在你的浏览器里加一个按钮和自己的面板，不修改它们的内容，也不调用 alphaXiv 的 AI。PDF 只从 arXiv 下载，每次一个、间隔至少 3 秒，仅供个人阅读。请遵守各网站条款、论文许可和模型服务商的条款。

## Development · 开发

```bash
npm run check                                                   # JS tests
uv run python -m unittest discover -s tests -p 'test_*.py'      # Python tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout. 代码结构见 CONTRIBUTING.md。

## License · 许可证

[AGPL-3.0](LICENSE). The default system prompt (`host/default_prompt.md`) comes from [PaperForge](https://github.com/FeijiangHan/PaperForge) by FeijiangHan. 默认系统提示词来自 FeijiangHan 的 PaperForge。
