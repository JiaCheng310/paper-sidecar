"""Prepare the unpacked extension and register its local helper (macOS, Windows, Linux)."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
HOST_NAME = "org.local.paper_sidecar"
CODEX_SCRIPT = Path("node_modules/@openai/codex/bin/codex.js")


def run(command, label):
    # shutil.which also finds Windows shims such as npm.cmd.
    executable = shutil.which(command[0])
    if not executable:
        raise SystemExit(f"未找到 {command[0]}，无法{label}。")
    try:
        subprocess.run([executable, *command[1:]], cwd=ROOT, check=True)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"{label}失败（{' '.join(command)} 退出码 {error.returncode}）。")


def install_node_modules():
    # npm ci always deletes node_modules; skip it when the lock file is unchanged.
    lock = hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest()
    marker = ROOT / "node_modules/.paper-sidecar-lock"
    if marker.is_file() and marker.read_text().strip() == lock and (ROOT / CODEX_SCRIPT).is_file():
        print("前端依赖未变化，跳过 npm ci。")
        return
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "安装前端依赖")
    marker.write_text(lock + "\n")


def write_launcher(root, node, platform=sys.platform):
    """The executable the browser starts: a .bat on Windows, a shell script elsewhere."""
    node_dir = str(Path(node).parent)
    if platform == "win32":
        launcher = root / "host-launcher.bat"
        python = root / ".venv" / "Scripts" / "python.exe"
        launcher.write_text("@echo off\r\n"
                            f'set "PATH={node_dir};%PATH%"\r\n'
                            f'cd /d "{root}"\r\n'
                            f'"{python}" -m host.main\r\n')
        return launcher
    launcher = root / "host-launcher"
    runtime_path = ":".join(dict.fromkeys([node_dir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]))
    launcher.write_text("#!/bin/sh\n" + f"export PATH={shlex.quote(runtime_path)}\n" +
                        f"cd {shlex.quote(str(root))}\n" +
                        f"exec {shlex.quote(str(root / '.venv/bin/python'))} -m host.main\n")
    launcher.chmod(0o700)
    return launcher


def register_host(host, root, platform=sys.platform, home=None, winreg=None):
    """Tell Edge (and Chrome) where the helper is; returns the browsers registered."""
    manifest = json.dumps(host, indent=2) + "\n"
    if platform == "win32":
        # Windows: one manifest file, found through a per-user registry key per browser.
        if winreg is None:
            import winreg
        location = root / "native-host.json"
        location.write_text(manifest)
        keys = {"Microsoft Edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
                "Google Chrome": r"Software\Google\Chrome\NativeMessagingHosts"}
        for parent in keys.values():
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{parent}\\{HOST_NAME}") as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(location))
        return list(keys)
    home = Path(home or Path.home())
    if platform == "darwin":
        support = home / "Library/Application Support"
        browsers = {"Microsoft Edge": support / "Microsoft Edge", "Google Chrome": support / "Google/Chrome"}
    else:
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
        browsers = {"Microsoft Edge": config / "microsoft-edge", "Google Chrome": config / "google-chrome"}
    registered = []
    for name, profile in browsers.items():
        # Always register Edge; register Chrome only when it is installed.
        if name != "Microsoft Edge" and not profile.is_dir():
            continue
        location = profile / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        location.parent.mkdir(parents=True, exist_ok=True)
        location.write_text(manifest)
        location.chmod(0o600)
        registered.append(name)
    return registered


def main():
    run(["uv", "sync", "--frozen"], "安装 Python 依赖")
    install_node_modules()
    extension = ROOT / "extension"
    vendor = extension / "vendor"
    vendor.mkdir(exist_ok=True)
    for source, target in [
        ("marked/lib/marked.umd.js", "marked.umd.js"),
        ("dompurify/dist/purify.min.js", "purify.min.js"),
        ("katex/dist/katex.min.js", "katex.min.js"),
        ("katex/dist/katex.min.css", "katex.min.css"),
        ("katex/dist/contrib/auto-render.min.js", "auto-render.min.js"),
        ("marked/LICENSE.md", "MARKED-LICENSE.md"),
        ("dompurify/LICENSE", "DOMPURIFY-LICENSE"),
        ("katex/LICENSE", "KATEX-LICENSE"),
    ]:
        shutil.copyfile(ROOT / "node_modules" / source, vendor / target)
    shutil.copytree(ROOT / "node_modules/katex/dist/fonts", vendor / "fonts", dirs_exist_ok=True)
    manifest_path = extension / "manifest.json"
    # The checked-in manifest is authoritative. Installation must not recreate it
    # and silently discard new content scripts, permissions or resource rules.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    key = manifest.get("key")
    if not key:
        private = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
                                 capture_output=True, check=True).stdout
        public = subprocess.run(["openssl", "pkey", "-pubout", "-outform", "DER"], input=private,
                                capture_output=True, check=True).stdout
        key = base64.b64encode(public).decode()
        manifest["key"] = key
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    extension_id = "".join(chr(ord("a") + int(char, 16)) for char in digest)
    node = shutil.which("node")
    if not (ROOT / CODEX_SCRIPT).is_file() or not node:
        raise SystemExit("模型运行程序或 Node.js 安装不完整，请检查 npm 安装结果。")
    launcher = write_launcher(ROOT, node)
    host = {"name": HOST_NAME, "description": "Paper Sidecar local bridge",
            "path": str(launcher), "type": "stdio", "allowed_origins": [f"chrome-extension://{extension_id}/"]}
    (ROOT / "installation.json").write_text(json.dumps({"extension_id": extension_id, "host": host}, indent=2) + "\n")
    if "--register" in sys.argv:
        print("本机连接已注册：", "、".join(register_host(host, ROOT)))
    print("扩展目录：", extension)
    print("扩展 ID：", extension_id)


if __name__ == "__main__":
    main()
