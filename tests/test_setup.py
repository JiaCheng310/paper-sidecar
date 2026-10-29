import json
from pathlib import Path
import tempfile
import unittest

import setup


class FakeRegistry:
    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1

    def __init__(self):
        self.values = {}

    def CreateKey(self, root, path):
        registry = self

        class Key:
            def __enter__(self):
                return path

            def __exit__(self, *args):
                return False

        self.current = path
        return Key()

    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[key] = value


class SetupTest(unittest.TestCase):
    def test_windows_gets_a_bat_launcher_and_registry_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = setup.write_launcher(root, r"C:\Program Files\nodejs\node.exe", platform="win32")
            self.assertEqual(launcher.name, "host-launcher.bat")
            text = launcher.read_text()
            self.assertTrue(text.startswith("@echo off"))
            self.assertIn(".venv", text)
            self.assertIn("python.exe\" -m host.main", text)
            registry = FakeRegistry()
            host = {"name": setup.HOST_NAME, "path": str(launcher)}
            browsers = setup.register_host(host, root, platform="win32", winreg=registry)
            self.assertEqual(browsers, ["Microsoft Edge", "Google Chrome"])
            manifest = root / "native-host.json"
            self.assertEqual(json.loads(manifest.read_text())["path"], str(launcher))
            self.assertEqual(registry.values, {
                r"Software\Microsoft\Edge\NativeMessagingHosts\org.local.paper_sidecar": str(manifest),
                r"Software\Google\Chrome\NativeMessagingHosts\org.local.paper_sidecar": str(manifest),
            })

    def test_macos_and_linux_write_manifests_into_browser_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            launcher = setup.write_launcher(home, "/usr/local/bin/node", platform="darwin")
            self.assertTrue(launcher.read_text().startswith("#!/bin/sh"))
            host = {"name": setup.HOST_NAME, "path": str(launcher)}
            self.assertEqual(setup.register_host(host, home, platform="darwin", home=home), ["Microsoft Edge"])
            self.assertTrue((home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts"
                             / "org.local.paper_sidecar.json").is_file())
            (home / ".config/google-chrome").mkdir(parents=True)
            self.assertEqual(setup.register_host(host, home, platform="linux", home=home),
                             ["Microsoft Edge", "Google Chrome"])


if __name__ == "__main__":
    unittest.main()
