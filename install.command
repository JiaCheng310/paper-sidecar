#!/bin/zsh
# 双击即可安装：检查依赖 → 安装 Python / 前端依赖 → 注册浏览器本机连接 → 打开扩展页面。
set -euo pipefail
cd -- "${0:A:h}"
ROOT=$PWD

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
  BOLD= DIM= RED= GREEN= YELLOW= RESET=
fi
STEP=0
TOTAL=4
step() { STEP=$((STEP + 1)); print -r -- "${BOLD}[$STEP/$TOTAL] $1${RESET}"; }
ok() { print -r -- "      ${GREEN}✓${RESET} $1"; }
warn() { print -r -- "      ${YELLOW}!${RESET} $1"; }
fail() { print -r -- "      ${RED}✗ $1${RESET}"; exit 1; }

# 双击运行时，Terminal 窗口会在脚本结束后保留；失败时停住，方便阅读错误信息。
pause_on_exit() {
  local code=$?
  if (( code != 0 )); then
    print -r -- ""
    print -r -- "${RED}${BOLD}安装未完成（退出码 $code）。${RESET}请根据上方提示处理后重新运行 install.command。"
  fi
  if [[ -t 0 && -z ${PAPER_SIDECAR_NO_PAUSE:-} ]]; then
    print -rn -- "${DIM}按回车键关闭…${RESET}"
    read -r _ || true
  fi
}
trap pause_on_exit EXIT

# 双击启动的脚本不会读取 ~/.zshrc，nvm / fnm / Volta 等安装的 Node 需要在这里补上。
path=(/opt/homebrew/bin /usr/local/bin $path)
[[ -d $HOME/.local/bin ]] && path=($HOME/.local/bin $path)
[[ -d $HOME/.cargo/bin ]] && path=($HOME/.cargo/bin $path)
[[ -d $HOME/.volta/bin ]] && path=($HOME/.volta/bin $path)
if ! command -v node >/dev/null 2>&1; then
  if [[ -s $HOME/.nvm/nvm.sh ]]; then
    source "$HOME/.nvm/nvm.sh" --no-use >/dev/null 2>&1 && nvm use --silent default >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  latest_nvm=(${HOME}/.nvm/versions/node/*/bin(N/nOn[1]))
  latest_fnm=(${HOME}/Library/Application\ Support/fnm/node-versions/*/installation/bin(N/nOn[1]))
  for dir in $latest_nvm $latest_fnm; do path=($dir $path); done
fi
export PATH

print -r -- "${BOLD}Paper Sidecar 安装程序${RESET}  ${DIM}$ROOT${RESET}"
print -r -- ""

step "检查运行环境"
[[ $(uname -s) == Darwin ]] || fail "目前只支持 macOS。"
missing=()
check() {
  local cmd=$1 hint=$2
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd ${DIM}$(command -v "$cmd")${RESET}"
  else
    print -r -- "      ${RED}✗${RESET} 未找到 $cmd：$hint"
    missing+=$cmd
  fi
}
check python3 "运行 xcode-select --install，或 brew install python"
check uv "brew install uv，或参考 https://docs.astral.sh/uv/"
check node "brew install node，或用 nvm 安装 Node.js 18 以上版本"
check npm "随 Node.js 一起安装"
check openssl "macOS 自带；如缺失可 brew install openssl"
(( ${#missing} == 0 )) || fail "缺少 ${(j:、:)missing}，安装后重新运行。"
node_major=${$(node -p 'process.versions.node.split(".")[0]'):-0}
(( node_major >= 18 )) || fail "Node.js 版本过低（当前 $(node -v)），需要 18 或更高版本。"
browser=
for app in "Microsoft Edge" "Google Chrome"; do
  if [[ -d "/Applications/$app.app" || -d "$HOME/Applications/$app.app" ]]; then
    browser=$app
    ok "$app"
    break
  fi
done
[[ -n $browser ]] || warn "没有找到 Microsoft Edge 或 Google Chrome；本扩展需要其中之一。"

step "安装依赖并准备扩展文件（首次可能需要几分钟）"
python3 setup.py --register || fail "setup.py 执行失败，详见上方输出。"
ok "依赖与前端库已就绪"

step "检查本机连接"
manifest="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/org.local.paper_sidecar.json"
[[ -f $manifest ]] || fail "没有写入 Native Messaging 清单：$manifest"
[[ -x $ROOT/host-launcher ]] || fail "启动器不可执行：$ROOT/host-launcher"
ok "清单 ${DIM}$manifest${RESET}"
extension_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["extension_id"])' installation.json)

step "在浏览器中加载扩展"
print -r -- "$ROOT/extension" | pbcopy 2>/dev/null && ok "扩展文件夹路径已复制到剪贴板"
if [[ -z ${PAPER_SIDECAR_NO_OPEN:-} ]]; then
  open -R "$ROOT/extension/manifest.json" 2>/dev/null || true
  if [[ $browser == "Microsoft Edge" ]]; then
    open -a "$browser" "edge://extensions" 2>/dev/null || true
  elif [[ -n $browser ]]; then
    open -a "$browser" "chrome://extensions" 2>/dev/null || true
  fi
fi

print -r -- ""
print -r -- "${GREEN}${BOLD}安装完成。${RESET}剩下的步骤在浏览器中完成："
print -r -- "  1. 打开扩展管理页（Edge：edge://extensions，Chrome：chrome://extensions），开启“开发人员模式”。"
print -r -- "  2. 首次安装：点击“加载解压缩的扩展”，选择 ${BOLD}$ROOT/extension${RESET}"
print -r -- "     已安装过：在 Paper Sidecar 卡片上点击“重新加载”。"
print -r -- "  3. 打开 alphaXiv 或 arXiv 论文页面，点击右下角的机器人图标；PDF 页面请点工具栏图标。"
print -r -- "  4. 点击输入框旁的 ⚙，登录 ChatGPT 账号或添加 DeepSeek、Claude 等 API。"
print -r -- "  ${DIM}扩展 ID：$extension_id${RESET}"
