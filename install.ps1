# Paper Sidecar installer for Windows. Double-click install.bat to run it.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location -Path $PSScriptRoot
$Root = $PSScriptRoot
$Extension = Join-Path $Root "extension"

function Ok($Text) { Write-Host "      OK  $Text" -ForegroundColor Green }
function Fail($Text) {
    Write-Host ""
    Write-Host "安装未完成：$Text" -ForegroundColor Red
    Read-Host "按回车键关闭"
    exit 1
}

Write-Host "Paper Sidecar 安装程序  $Root" -ForegroundColor White
Write-Host ""
Write-Host "[1/3] 检查运行环境"
$missing = @()
$tools = @(
    @("uv", "在 PowerShell 运行：powershell -ExecutionPolicy ByPass -c ""irm https://astral.sh/uv/install.ps1 | iex"""),
    @("node", "从 https://nodejs.org 安装 LTS 版本"),
    @("npm", "随 Node.js 一起安装")
)
foreach ($tool in $tools) {
    $found = Get-Command $tool[0] -ErrorAction SilentlyContinue
    if ($found) { Ok "$($tool[0])  $($found.Source)" }
    else { Write-Host "      缺少 $($tool[0])：$($tool[1])" -ForegroundColor Red; $missing += $tool[0] }
}
if ($missing.Count -gt 0) { Fail "请先安装 $($missing -join '、')，然后重新打开终端并再次运行 install.bat。" }

Write-Host "[2/3] 安装依赖并注册本机连接（首次可能需要几分钟）"
# uv provides Python itself, so no separate Python installation is needed.
& uv run --no-project --python 3.12 python setup.py --register
if ($LASTEXITCODE -ne 0) { Fail "安装步骤出错，详见上方输出。" }
Ok "依赖与本机连接已就绪"

Write-Host "[3/3] 在浏览器中加载扩展"
Set-Clipboard -Value $Extension
Ok "扩展文件夹路径已复制到剪贴板"
Start-Process explorer.exe $Extension
try { Start-Process "msedge" "edge://extensions" } catch { }

Write-Host ""
Write-Host "安装完成。剩下的步骤在浏览器中完成：" -ForegroundColor Green
Write-Host "  1. 打开扩展管理页（Edge：edge://extensions，Chrome：chrome://extensions），开启“开发人员模式”。"
Write-Host "  2. 点击“加载解压缩的扩展”，选择 $Extension"
Write-Host "  3. 打开 alphaXiv 或 arXiv 论文页面，点击右下角的机器人图标。"
Write-Host "  4. 点击输入框旁的 ⚙，登录 ChatGPT 账号或添加 DeepSeek、Claude 等 API。"
Read-Host "按回车键关闭"
