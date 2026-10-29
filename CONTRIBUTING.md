# 维护说明

项目保留原生 JavaScript 和 Python，不需要前端打包服务器。界面、浏览器通信、PDF 处理和模型连接分别维护。

## 代码分工

| 文件 | 责任 |
| --- | --- |
| `extension/manifest.json` | 扩展入口、权限和资源暴露规则的唯一来源 |
| `extension/paper-context.js` | 论文编号、版本匹配和 PDF 地址选择 |
| `extension/content.js` | 当前网页信息、选区、站内导航跟踪 |
| `extension/alphaxiv-workspace.js` | 识别 alphaXiv 原有 Assistant，放置提供方切换按钮，保留并恢复原助手状态 |
| `extension/reader-view.js` | Sidecar iframe 的布局、生命周期与来源校验，不管理 PDF 查看器 |
| `extension/reader-options.js` | 根据模型目录（Codex 与其他 API）生成分组选项、保存选择 |
| `extension/settings-view.js` | 设置页：ChatGPT 账号登录、系统提示词编辑、其他模型 API 管理 |
| `extension/sidepanel.html`、`style.css` | 聊天界面的结构与样式 |
| `extension/sidepanel.js` | 当前论文绑定、对话交互、渲染、原生连接事件 |
| `extension/background.js` | 校验扩展消息来源、为页面提供论文状态、协调保存 |
| `extension/conversation-store.js` | 按论文串行合并保存、版本冲突和容量限制 |
| `host/main.py` | Native Messaging 协议及请求调度 |
| `host/codex_client.py` | Codex app-server、临时线程及工具调用 |
| `host/reader_settings.py` | 内置系统提示词、校验模型和服务档位、合并 API 模型 |
| `host/user_settings.py` | 自定义提示词和其他 API 配置的本机存储（权限 600，Key 不回传网页） |
| `host/direct_client.py` | OpenAI 兼容与 Anthropic 接口的流式调用和 PDF 工具循环 |
| `host/papers.py` | 获取、校验、解析 PDF 和内存缓存 |
| `host/cache.py` | 固定目录下的磁盘缓存及清理 |
| `setup.py` | 安装锁定依赖、准备第三方前端文件、生成本机启动器 |

内容脚本按 manifest 中的顺序加载。网页 DOM 适配集中在 `alphaxiv-workspace.js`；它向 `reader-view.js` 提供原助手内容区的位置，后者只管理一个扩展 iframe。`content.js` 负责页面状态。切换按钮由 Shadow DOM 隔离站点样式，聊天样式封装在扩展 iframe 内。页面标题、来源路径和提示词通过 DOM 属性或 textContent 设置，不拼进 HTML。

## 维护约定

- 修改权限和入口直接编辑 `manifest.json`。安装脚本读取该文件，不重建或覆盖配置；其中的公开 key 用于保持扩展 ID 稳定。
- 不移除或重新挂载 alphaXiv 的 PDF、Assistant 或输入框。切换到 Sidecar 时只隐藏原助手内容并保留几何尺寸，切回时恢复原样式、可访问属性和草稿。
- 收起助手或切回 alphaXiv 只隐藏 Sidecar iframe，不重新赋值地址。离开支持的论文页面才卸载 iframe、关闭原生连接。
- 模型选项从 app-server 目录读取；不要将 Fast 倍率硬编码到某个模型。每轮明确传入模型、推理强度和服务档位。
- 默认系统提示词内置在 `host/reader_settings.py`；用户在设置中保存的提示词优先。每轮重新确定提示词；变更时重建临时线程并恢复近期问答。
- Codex 使用独立的 `CODEX_HOME`，登录、退出只影响本扩展。不要改回 `~/.codex`。
- API Key 只在保存时由网页发送一次，主机返回的配置只含掩码提示，任何事件都不得包含完整 Key。
- 页面内的对话绑定来源标签页 ID，不能因为用户切到另一标签页而改变上下文。异步结果要检查请求序号和论文归属。
- 论文 URL 规则统一放在 `paper-context.js`，后端仍独立校验真实获取的 PDF 地址。不要放宽到任意网络地址。
- PDF 只从 arXiv 下载，不访问 alphaXiv 的服务器或接口；arXiv 请求保持单连接、间隔至少 3 秒，并带上能识别本项目的 User-Agent。不要使用 alphaXiv 的 logo，也不要声称与 arXiv、alphaXiv 有关联。
- 对话保存通过后台的 `save-conversation` 请求进行；不要在各个窗口直接覆盖整份 `library`。版本冲突时报告失败，保留已保存的数据。
- 模型输出先过滤再显示；公式渲染关闭信任模式。网页消息只能触发已定义的界面操作，不得转成任意本机命令。
- 不修改用户的全局 Codex 登录、配置或 MCP 设置。本项目的运行选项仅作用于它启动的子进程。
- Codex CLI 版本锁定在 npm 依赖中，调用 `node_modules/.bin/codex`，不依赖全局 CLI 的版本。升级时需验证模型目录、线程协议和真实 PDF 工具调用。
- PDF 文件只放到约定的缓存目录。不要把论文、提取全文、页图、账号文件或本机路径写进仓库。
- `.venv`、`node_modules`、`extension/vendor`、启动器和安装信息属于生成文件，已从 Git 排除。两个依赖锁文件和 manifest 应随源码保存。

## 开发流程

首次准备依赖与前端库：

```bash
python3 setup.py
```

修改相关模块后，先运行对应检查；交付前执行：

```bash
npm run format
npm run check
uv run python -m unittest discover -s tests -p 'test_*.py' -v
```

常规检查使用隔离的临时缓存和模拟浏览器 API，不连接模型、不改变登录，也不注册本机连接。真实账号检查是单独的 `uv run python -m tests.smoke`，会消耗少量已有账号额度。

随后在浏览器重新加载扩展并刷新论文页面，手动检查：切换按钮、提问与流式回答、收起再展开、切换论文不串页、设置页登录与 API、深色模式。DOM 测试不能证明 alphaXiv 实际 DOM、页面 CSP、iframe 布局和 Native Messaging 在实际安装下全部可用。
