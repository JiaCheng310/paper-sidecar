<p align="center"><img src="extension/icons/icon-128.png" width="96" alt="" /></p>

# Paper Sidecar · 论文伴读

在 alphaXiv / arXiv 论文页面旁边和 AI 一起读论文。助手直接读取 PDF 原文（按页读取、全文搜索、查看页图），回答时标注页码，支持 Markdown、LaTeX 公式和流式输出。

- **嵌入 alphaXiv**：在 alphaXiv 原有 Assistant 标题栏切换到“伴读”，或点击工具栏图标打开浏览器侧栏（alphaXiv 和 arXiv 均可）。
- **多种模型**：ChatGPT 账号（通过内置的 Codex 运行时，支持联网检索），以及 DeepSeek、Kimi、通义千问、智谱、OpenRouter、OpenAI、Anthropic Claude、本机 Ollama 等 API。
- **可编辑的系统提示词**：内置一份论文阅读流程，可以在设置里改成你自己的。
- **本机运行**：PDF 在本机下载和解析，API Key 只保存在本机。

这是独立的开源工具，不是 alphaXiv 官方扩展，不调用 alphaXiv 的 AI 服务。

## 安装

需要：macOS、Microsoft Edge 或 Google Chrome、[uv](https://docs.astral.sh/uv/)、Node.js 18 以上。

```bash
git clone https://github.com/JiaCheng310/paper-sidecar.git
cd paper-sidecar
./install.command
```

也可以在访达中双击 `install.command`。脚本会检查依赖、安装 Python 与前端库、注册浏览器本机连接，然后打开扩展管理页和 `extension` 文件夹（路径已复制到剪贴板）。

然后在浏览器中：

1. 打开 `edge://extensions` 或 `chrome://extensions`，开启“开发人员模式”。
2. 点击“加载解压缩的扩展”，选择项目中的 `extension` 文件夹。
3. 打开一篇 alphaXiv 论文，展开 Assistant，在标题栏选择 **伴读**；或点击工具栏的扩展图标。
4. 点击输入框旁的 **⚙** 完成设置（见下文）。

移动项目目录或更新代码后，重新运行 `./install.command`，并在扩展管理页点击“重新加载”，再刷新论文页面。

## 设置

点击输入框旁的 ⚙：

- **ChatGPT 账号**：用 ChatGPT 登录（在新标签页完成授权）、设备码登录，或使用 OpenAI API Key。登录信息保存在扩展自己的目录中，不影响电脑上其他工具的登录。模型请求使用该账号的额度。
- **系统提示词**：直接在框中编辑并保存，下一条消息生效；“恢复默认”回到内置提示词。
- **其他模型 API**：选择预设或自定义，填写 Base URL、API Key 和模型名称（可点“获取模型列表”自动读取）。支持 OpenAI 兼容接口（Chat Completions）和 Anthropic Messages。如果模型支持图片输入，勾选后可以查看 PDF 页图。这些模型不支持联网搜索。

添加后，模型按来源分组出现在输入框下方的模型选择中；ChatGPT 账号的模型还可以选择推理强度和速度档位。

## 使用

- Enter 发送，Shift+Enter 换行，Esc 停止生成。
- 选中网页上的一段文字后点“引用选中内容”，可以针对原文提问；也可以直接说明 PDF 页码。
- `＋` 开始当前论文的新对话，旧对话保留在扩展存储中。
- 每篇论文的对话独立保存在浏览器本地（上限 4 MB），刷新后自动恢复。

## 数据与隐私

| 内容 | 位置 |
| --- | --- |
| API Key、自定义提示词 | `~/Library/Application Support/paper-sidecar/settings.json`（权限 600，不会发回网页） |
| ChatGPT 账号登录 | `~/Library/Application Support/paper-sidecar/codex/` |
| PDF 缓存（上限 512 MB，自动清理最久未用） | `~/Library/Caches/paper-sidecar/` |
| 对话记录 | 浏览器的扩展存储（卸载扩展即删除） |

- PDF 优先使用页面中匹配该论文版本的链接，否则使用 arXiv 地址。每份 PDF 最多 24 MB、600 页。
- 侧栏底部可查看和清理缓存；也可以双击 `clear-cache.command`，或运行 `uv run python -m host.cache --clear`。清理不会删除对话记录和设置。
- 对话内容会发送给你所选的模型服务商；请遵守其数据政策。

## 排查

- **没有“伴读”切换按钮**：确认是带 arXiv 编号的 alphaXiv 论文页面，并已展开 Assistant；重新加载扩展并刷新页面。也可以用工具栏图标打开侧栏。
- **提示“本机未连接”**：重新运行 `./install.command`，然后重新打开侧栏。
- **提示账号尚未登录**：在 ⚙ 设置中登录，或切换到已添加的 API 模型。
- **API 报错 401 / 404**：检查 API Key、Base URL（OpenAI 兼容接口通常以 `/v1` 结尾）和模型名称。

## 已知限制

- 目前只支持 macOS，以及带 arXiv 编号的论文；独立上传或私有论文尚不支持。
- 浏览器内置 PDF 查看器或跨域文档中的选区可能无法读取，可以粘贴原文或按页码提问。
- 没有单独的 OCR；扫描件和复杂公式依赖模型查看页图的能力（需要支持图片输入的模型）。

## 开发

```bash
python3 setup.py                 # 准备依赖和前端库（不注册本机连接）
npm run check                    # 前端格式检查与测试
uv run python -m unittest discover -s tests -p 'test_*.py' -v
uv run python -m tests.smoke     # 可选：使用真实账号的端到端测试，会消耗少量额度
```

代码结构与维护约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[AGPL-3.0](LICENSE)。PDF 解析依赖 [PyMuPDF](https://pymupdf.readthedocs.io/)（AGPL／商业双重许可）；前端库 marked、DOMPurify、KaTeX 的许可证随 `extension/vendor` 分发。

参考：[Codex app-server](https://developers.openai.com/codex)、[arxiv-mcp-server (cyanheads)](https://github.com/cyanheads/arxiv-mcp-server)、[arxiv-mcp-server (blazickjp)](https://github.com/blazickjp/arxiv-mcp-server)、[Edge 侧栏](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar)、[Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)。
