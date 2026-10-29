import asyncio
import json
from pathlib import Path
import select
import struct
import subprocess
import sys
import unittest

from host.main import Bridge


class BridgeTest(unittest.TestCase):
    def test_native_messaging_handshake_and_process_shutdown(self):
        root = Path(__file__).resolve().parents[1]
        process = subprocess.Popen([sys.executable, "-m", "host.main"], cwd=root,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            body = json.dumps({"type": "hello", "requestId": "protocol-test"}).encode()
            process.stdin.write(struct.pack("=I", len(body)) + body)
            process.stdin.flush()
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "Host did not respond")
            size = struct.unpack("=I", process.stdout.read(4))[0]
            response = json.loads(process.stdout.read(size))
            self.assertEqual(response["event"], "ready")
            self.assertEqual(response["requestId"], "protocol-test")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()


class CancelTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_before_model_start_does_not_launch_a_turn(self):
        events, gate = [], asyncio.Event()
        bridge = Bridge(events.append)
        async def load(_):
            await gate.wait()
            return None
        bridge.load = load
        task = asyncio.create_task(bridge.handle({"type": "chat", "requestId": "cancel-test",
            "context": {"paperId": "1706.03762"}, "question": "Explain the method"}))
        await asyncio.sleep(0)
        await bridge.interrupt()
        gate.set()
        await task
        self.assertEqual(events[-1]["event"], "done")
        self.assertTrue(events[-1]["interrupted"])
        self.assertIsNone(bridge.client.process)
        await bridge.close()


if __name__ == "__main__":
    unittest.main()
