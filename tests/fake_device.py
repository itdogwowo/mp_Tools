"""一個假的 MicroPython 裝置，跑在 TCP socket 上。

用途：**在沒有硬體、或序列埠被別的程序佔用時，仍然能端到端驗證整條協定鏈路。**
pyserial 支援 ``socket://host:port``，所以同一份 transport / mpy 程式碼可以完全不改地
接到這個假裝置上。

它實作的是真的 MicroPython raw REPL 行為：
  ``Ctrl-C Ctrl-C`` → 中斷
  ``Ctrl-A``        → 進 raw REPL，回 ``raw REPL; CTRL-B to exit\\r\\n>``
  每一行           → 回 ``>`` 應答
  ``Ctrl-D``        → 執行，回 ``OK<stdout>\\x04<stderr>\\x04>``
  ``Ctrl-B``        → 回正常 REPL
  ``Ctrl-E``        → paste mode，回 ``paste mode; ...\\r\\n=== ``，``Ctrl-D`` 後執行
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from dataclasses import dataclass, field

__all__ = ["FakeMpyDevice", "start_fake_device"]

RAW_BANNER = b"raw REPL; CTRL-B to exit\r\n>"
PASTE_BANNER = b"paste mode; Ctrl-C to cancel, Ctrl-D to finish\r\n=== "


@dataclass
class FakeDeviceState:
    files: dict[str, bytes] = field(
        default_factory=lambda: {
            "/boot.py": b"# fake boot.py\n",
            "/main.py": b"print('hello from fake device')\n",
            "/lib/sensor.py": b"def read():\n    return 42\n",
        }
    )
    version: str = "v1.25.0 (fake device)"
    chip: str = "FAKE-ESP32-S3"
    free_heap: int = 184320
    executed: list[str] = field(default_factory=list)
    #: 執行時要假裝卡住的秒數。用來測主機端的逾時處理 ——
    #: 這是唯一能可靠重現「裝置當掉」的方法。
    hang_seconds: float = 0.0


class FakeMpyDevice:
    """開一個 TCP listener，把每個連線當成一個序列埠。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 0, trace: bool = False) -> None:
        self.host = host
        self._server: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._running = False
        self.port = port
        self.state = FakeDeviceState()
        self.trace = trace
        self.log: list[str] = []

    def _trace(self, message: str) -> None:
        if self.trace:
            self.log.append(message)
            print(f"[fake] {message}", flush=True)

    # ── 生命週期 ────────────────────────────────────────────────────────

    def start(self) -> int:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.host, self.port))
        server.listen(4)
        server.settimeout(0.3)
        self._server = server
        self.port = server.getsockname()[1]
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, name="fake-mpy", daemon=True)
        self._thread.start()
        return self.port

    def stop(self) -> None:
        self._running = False
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
            self._server = None
        if self._thread is not None:
            self._thread.join(2.0)
            self._thread = None

    @property
    def url(self) -> str:
        return f"socket://{self.host}:{self.port}"

    # ── 連線處理 ────────────────────────────────────────────────────────

    def _accept_loop(self) -> None:
        assert self._server is not None
        while self._running:
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        conn.settimeout(0.1)
        mode = "normal"
        pending = bytearray()
        try:
            while self._running:
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                self._trace(f"RECV {chunk!r}")
                # 逐位元組處理：控制字元必須立刻動作，不能等到換行。
                for byte in chunk:
                    if byte == 0x03:  # Ctrl-C
                        pending.clear()
                        mode = "normal"
                        self._trace("  <Ctrl-C>")
                    elif byte == 0x01:  # Ctrl-A
                        pending.clear()
                        mode = "raw"
                        conn.sendall(RAW_BANNER)
                        self._trace("  <Ctrl-A> -> raw REPL banner")
                    elif byte == 0x02:  # Ctrl-B
                        pending.clear()
                        mode = "normal"
                        conn.sendall(b"\r\n>>> ")
                        self._trace("  <Ctrl-B> -> friendly REPL")
                    elif byte == 0x05:  # Ctrl-E
                        pending.clear()
                        mode = "paste"
                        conn.sendall(PASTE_BANNER)
                        self._trace("  <Ctrl-E> -> paste mode")
                    elif byte == 0x04:  # Ctrl-D：執行
                        source = pending.decode("utf-8", "replace")
                        pending.clear()
                        self._trace(f"  <Ctrl-D> EXEC mode={mode} source={source!r}")
                        self._run(conn, source, mode=mode)
                        # 執行完仍在同一個模式下（raw 留在 raw）
                    else:
                        pending.append(byte)
        finally:
            self._trace("connection closed")
            try:
                conn.close()
            except OSError:
                pass

    # ── 假的 Python 執行 ────────────────────────────────────────────────

    def _run(self, conn: socket.socket, source: str, *, mode: str) -> None:
        """只認得幾種樣板，不是真的 Python 解譯器。

        刻意保持「笨」：這個假裝置是拿來驗證**協定框架**的，不是驗證裝置端語意。
        要驗證語意請接真板子。
        """
        self.state.executed.append(source)
        stdout = ""
        stderr = ""

        # 模擬「裝置卡住」：在回應之前先睡一段。主機端應該在 timeout 後放棄並
        # 明確回報逾時，而不是拿到一個空結果。
        if self.state.hang_seconds > 0 and "hang" in source:
            time.sleep(self.state.hang_seconds)

        stripped = source.strip()
        try:
            if "sys.version" in source or "sys.implementation" in source:
                stdout += f"{self.state.version}\r\n"
            if "os.uname" in source or ("machine" in source and "uname" in source):
                stdout += (
                    f"sysname='esp32', nodename='esp32', release='1.25.0', "
                    f"version='{self.state.version}', machine='{self.state.chip}'\r\n"
                )
            if "gc.mem_free" in source or "mem_free" in source:
                stdout += f"{self.state.free_heap}\r\n"
            if "ilistdir" in source:
                seen: list[list] = []
                for path in sorted(self.state.files):
                    rel = path.lstrip("/")
                    top = rel.split("/")[0]
                    if any(item[0] == top for item in seen):
                        continue
                    seen.append([top, 1 if "/" in rel else 0, 0, 0])
                stdout += json.dumps(seen) + "\r\n"
            elif "os.listdir" in source:
                names = sorted({"/" + p.lstrip("/").split("/")[0] for p in self.state.files})
                stdout += repr(names) + "\r\n"
            if "no module named" in source or "raise " in source:
                stderr += (
                    "Traceback (most recent call last):\r\n"
                    '  File "<stdin>", line 1, in <module>\r\n'
                    "ImportError: no module named 'nope'\r\n"
                )
            elif "print(" in source:
                for line in stripped.splitlines():
                    line = line.strip()
                    if line.startswith("print(") and line.endswith(")"):
                        literal = line[6:-1].strip()
                        if literal.startswith(("'", '"')) and literal.endswith(("'", '"')):
                            stdout += literal[1:-1] + "\r\n"
        except Exception as exc:  # pragma: no cover - 假裝置不該炸
            stderr += f"{type(exc).__name__}: {exc}\r\n"

        if mode == "raw":
            # raw REPL 的回應框架。注意 "OK" **直接黏在 stdout 前面**，
            # 它不是獨立的一個欄位：
            #     OK <stdout> \x04 <stderr> \x04 >
            conn.sendall(b"OK")
            conn.sendall(stdout.encode())
            conn.sendall(b"\x04")
            conn.sendall(stderr.encode())
            conn.sendall(b"\x04>")
        elif mode == "paste":
            # paste mode：先回顯 "=== \r\n"，執行完再回 ">>> "
            conn.sendall(b"=== \r\n")
            conn.sendall(stdout.encode())
            if stderr:
                conn.sendall(stderr.encode())
            conn.sendall(b">>> ")
        else:
            conn.sendall(stdout.encode())
            if stderr:
                conn.sendall(stderr.encode())
            conn.sendall(b"\r\n>>> ")


def start_fake_device(host: str = "127.0.0.1") -> FakeMpyDevice:
    device = FakeMpyDevice(host=host)
    device.start()
    return device


if __name__ == "__main__":  # 手動開一個來玩：python -m tests.fake_device
    dev = start_fake_device()
    print(f"假裝置在 {dev.url}（Ctrl-C 結束）")
    try:
        asyncio.run(asyncio.sleep(3600))
    except KeyboardInterrupt:
        dev.stop()
