"""MicroPython / CircuitPython 的 raw REPL 協定。

協議本身（已對照 MicroPython 官方文件與 mpremote 的實作）：

===========================  ==========================================
``Ctrl-C`` ×2                中斷正在執行的程式（第一次中斷，
                             第二次清掉緩衝）
``Ctrl-A``                   進入 raw REPL，裝置回應尾端是
                             ``raw REPL; CTRL-B to exit\\r\\n>``
每一行（≤256 bytes）         裝置回一個 ``>`` 應答
``Ctrl-D``                   執行；回應格式
                             ``OK<stdout>\\x04<stderr>\\x04>``
``Ctrl-B``                   回正常 REPL
``Ctrl-E`` … ``Ctrl-D``      paste mode（貼大段程式碼用）
===========================  ==========================================

**為什麼要自己寫而不用 mpremote：** mpremote 是 CLI 工具，它的內部函式沒有穩定的
公開介面，而且它會直接抓著序列埠不放。我們需要的是能被 async web server 驅動、
能中途取消、能回報結構化進度的實作。
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass, field

from ..transport.serial_io import SerialReadTimeout, SerialTransport, SerialTransportError

__all__ = [
    "CTRL_A",
    "CTRL_B",
    "CTRL_C",
    "CTRL_D",
    "CTRL_E",
    "MpyError",
    "ExecResult",
    "MpyExecutor",
    "MpyExecError",
    "MpyTimeoutError",
    "parse_traceback",
]

CTRL_A = b"\x01"
CTRL_B = b"\x02"
CTRL_C = b"\x03"
CTRL_D = b"\x04"
CTRL_E = b"\x05"

#: 每個 Ctrl-D 終止的區塊最大送出位元組數。
#:
#: **不要把「256」當成每塊上限** —— 那是 MicroPython 編譯器每行／每敍述的限制，
#: 不是 raw REPL 的協定限制。raw REPL 的同步點是 ``\\x04``：裝置收到 ``\\x04``
#: 才會編譯並執行整塊緩衝，然後回一個 ``>``。所以我們可以把整支程式一次送出去，
#: 只在切塊時為了避免灌爆裝置的輸入緩衝而分段。
DEFAULT_CHUNK = 4096

#: raw REPL 回應框架裡的分欄位（Frame Separator）。
_FS = bytes([0x04])


@dataclass
class MpyError:
    """從 traceback 解析出來的結構化錯誤。編輯器靠這個把紅線畫在對的行上。"""

    file: str
    line: int
    type: str
    message: str
    raw: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "type": self.type,
            "message": self.message,
            "raw": self.raw,
        }


_TRACEBACK_HEAD = "Traceback (most recent call last)"
_TRACEBACK_RE = re.compile(
    r'File "(?P<file>[^"]+)",\s*line\s*(?P<line>\d+)'
    r"[\s\S]*?\r?\n(?P<type>[A-Za-z_][A-Za-z0-9_.]*):\s*(?P<message>[\s\S]*?)\s*$"
)


def parse_traceback(stderr: str) -> MpyError | None:
    """把 MicroPython 的 stderr 變成結構化錯誤；不是 traceback 就回 ``None``。"""
    if _TRACEBACK_HEAD not in stderr:
        return None
    text = stderr.replace("\r\n", "\n").strip()
    match = _TRACEBACK_RE.search(text)
    if not match:
        return MpyError(
            file="<unknown>",
            line=0,
            type="Error",
            message=text,
            raw=stderr,
        )
    return MpyError(
        file=match.group("file"),
        line=int(match.group("line")),
        type=match.group("type"),
        message=match.group("message").strip(),
        raw=stderr,
    )


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    error: MpyError | None = None
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "error": self.error.to_dict() if self.error else None,
            "durationMs": self.duration_ms,
        }


class MpyExecError(RuntimeError):
    def __init__(self, detail: MpyError) -> None:
        super().__init__(f"{detail.type}: {detail.message}（第 {detail.line} 行）")
        self.detail = detail


class MpyTimeoutError(RuntimeError):
    """裝置在時限內沒有回應。

    **這個狀態下 raw REPL 已經失去同步** —— 裝置可能還在跑那支程式，
    它的輸出會混進下一次的回應裡。呼叫端必須先 :meth:`MpyExecutor.interrupt`
    或重新 :meth:`MpyExecutor.enter`，不能直接接著送下一支程式。
    """

    def __init__(self, timeout: float, received: bytes) -> None:
        preview = received[-200:].decode("utf-8", "replace")
        super().__init__(
            f"裝置在 {timeout}s 內沒有回應（raw REPL 已失去同步，請先中斷或重新連線）。"
            f"已收到 {len(received)} bytes：{preview!r}"
        )
        self.timeout = timeout
        self.received = received


class MpyExecutor:
    """驅動一個已開啟的 :class:`SerialTransport` 講 raw REPL。

    有狀態：``enter()`` 之後才能 ``exec()``；交給別人（例如 esptool）之前要 ``exit()``。
    """

    def __init__(
        self,
        transport: SerialTransport,
        *,
        chunk_size: int = DEFAULT_CHUNK,
        exec_timeout: float = 10.0,
        quiet: bool = True,
    ) -> None:
        self.transport = transport
        self.chunk_size = chunk_size
        self.exec_timeout = exec_timeout
        self.quiet = quiet
        self.in_raw_repl = False
        self._banner = ""

    # ── 進出 raw REPL ───────────────────────────────────────────────────

    async def enter(self, *, timeout: float = 3.0) -> str:
        """進 raw REPL。回傳裝置的 banner（拿來判斷是 MicroPython 還是 CircuitPython）。"""
        await self.transport.write(CTRL_C + CTRL_C)
        await self._sleep(0.06)
        # 只清掉中斷殘留的輸出。**不要在送出 Ctrl-A 之後才 flush** ——
        # banner 可能比 flush 早到，那樣子會被清掉，然後就永遠等不到它。
        await self.transport.flush_input()
        await self.transport.write(CTRL_A)
        try:
            banner = await self.transport.read_until(b">", timeout)
        except SerialReadTimeout as exc:
            raise MpyExecError(
                MpyError(
                    file="<device>",
                    line=0,
                    type="NotMicroPython",
                    message=(
                        "裝置沒有進入 raw REPL。可能不是 MicroPython/CircuitPython，"
                        "或韌體還沒啟動完成（剛插上 USB 時要等 1～2 秒）。"
                    ),
                    raw=exc.received.decode("utf-8", "replace"),
                )
            ) from exc

        text = banner.decode("utf-8", "replace")
        if "raw REPL" not in text:
            raise MpyExecError(
                MpyError(
                    file="<device>",
                    line=0,
                    type="NotMicroPython",
                    message=f"裝置回應不是 raw REPL banner：{text[-160:]!r}",
                    raw=text,
                )
            )
        self.in_raw_repl = True
        self._banner = text
        return text

    async def exit(self) -> None:
        if not self.in_raw_repl:
            return
        await self.transport.write(CTRL_B)
        self.in_raw_repl = False
        await self._sleep(0.05)

    async def interrupt(self) -> None:
        """中斷正在跑的程式，**並重新進入 raw REPL**。

        ``Ctrl-C`` 會把裝置踢回 *正常* REPL（不是留在 raw REPL）。如果不重新送
        ``Ctrl-A``，整個 session 就廢了 —— 之後每次 ``exec`` 都會在 friendly REPL
        的 echo 上撞牆，而且症狀是「逾時、收到像是 echo 的內容」，非常難懂。
        """
        await self.transport.write(CTRL_C)
        await self._sleep(0.08)
        # 中斷後裝置會回到 friendly REPL 並吐出提示字元，先清乾淨
        await self.transport.flush_input()
        await self.transport.write(CTRL_A)
        try:
            await self.transport.read_until(b">", 2.0)
        except SerialReadTimeout as exc:
            self.in_raw_repl = False
            raise SerialTransportError(
                f"中斷後無法重新進入 raw REPL（收到 {exc.received[:120]!r}）；"
                "請重新連線裝置。"
            ) from exc
        self.in_raw_repl = True

    # ── 執行 ────────────────────────────────────────────────────────────

    async def exec(self, program: str, *, timeout: float | None = None) -> ExecResult:
        """在 raw REPL 裡執行一段程式。

        Raises:
            SerialTransportError: 尚未進入 raw REPL。
            MpyTimeoutError: 裝置在時限內沒有回應。**這種情況下 raw REPL 已經失去同步**
                （裝置還在跑那支程式），呼叫端必須 ``interrupt()`` 或重新 ``enter()``，
                不能直接接著送下一支程式。
        """
        if not self.in_raw_repl:
            raise SerialTransportError("尚未進入 raw REPL，請先呼叫 enter()")
        limit = timeout if timeout is not None else self.exec_timeout
        started = _now_ms()

        data = program.encode("utf-8")
        # 一次把整支程式送出去，只在必要時分段（避免灌爆裝置的輸入緩衝）。
        # 同步點是後面的 Ctrl-D，不是換行 —— 見 DEFAULT_CHUNK 的說明。
        for offset in range(0, len(data), self.chunk_size):
            await self.transport.write(data[offset : offset + self.chunk_size])

        await self.transport.write(CTRL_D)

        # raw REPL 的整個回應是「一次送出」的，框架長這樣：
        #
        #     OK <stdout> \x04 <stderr> \x04 >
        #
        # 注意：**"OK" 不是獨立的一個欄位，它直接黏在 stdout 前面。**
        # 所以 head 會是 b"OK" + stdout（例如 b"OKone\r\n\x04"）。
        # 把它當成「head 只等於 OK」是最容易犯的錯，症狀是 stdout 永遠是空的。
        #
        # 讀取順序也必須照著框架走。**不要先 read_until(b">")** —— USB CDC 幾乎
        # 一定會把整包擠在同一次傳輸裡，那個呼叫會把 stdout 與 stderr 一起吃掉。
        try:
            head = await self.transport.read_until(_FS, limit)
        except SerialReadTimeout as exc:
            raise MpyTimeoutError(limit, exc.received) from exc

        head_bytes = head[:-1]  # 去掉 \x04
        if not head_bytes.startswith(b"OK"):
            # 裝置不接受這支程式：整個 head 就是錯誤訊息，後面沒有 stderr 欄位。
            head_text = head_bytes.decode("utf-8", "replace")
            return ExecResult("", head_text, parse_traceback(head_text), _now_ms() - started)

        try:
            stderr_frame = await self.transport.read_until(_FS, limit)
            await self.transport.read_until(b">", 2.0)
        except SerialReadTimeout as exc:
            raise MpyTimeoutError(limit, exc.received) from exc

        stdout = head_bytes[2:].decode("utf-8", "replace")
        stderr = stderr_frame[:-1].decode("utf-8", "replace")
        return ExecResult(stdout, stderr, parse_traceback(stderr), _now_ms() - started)

    async def exec_or_raise(self, program: str, *, timeout: float | None = None) -> str:
        result = await self.exec(program, timeout=timeout)
        if result.error is not None:
            raise MpyExecError(result.error)
        return result.stdout

    async def exec_json(self, program: str, *, timeout: float | None = None):
        """執行會印出一行 JSON 的程式，解析後回傳。"""
        raw = await self.exec_or_raise(program, timeout=timeout)
        text = raw.strip().splitlines()
        if not text:
            return None
        return json.loads(text[-1])

    # ── paste mode（貼大段程式碼，比 raw REPL 快很多）────────────────────

    async def run_paste(self, program: str, *, timeout: float = 10.0) -> str:
        """用 paste mode 執行。空行會被吃掉，所以縮排要靠 ``\\x04`` 之前的補償。

        代價是裝置端會回顯整份程式碼 —— 那些回顯我們直接丟掉。
        """
        await self.transport.write(CTRL_E)
        await self.transport.read_until(b"=== ", 2.0)
        if not program.endswith("\n"):
            program += "\n"
        await self.transport.write(program.encode("utf-8"))
        await self._sleep(0.12)
        await self.transport.write(CTRL_D)

        # 先吃掉裝置回顯的 "=== \r\n"，再收輸出
        try:
            await self.transport.read_until(b"=== \r\n", timeout)
        except SerialReadTimeout:
            pass
        try:
            output = await self.transport.read_until(b">>> ", timeout)
        except SerialReadTimeout:
            output = b""
        text = output.decode("utf-8", "replace")
        return text.replace("=== \r\n", "").removesuffix(">>> ")

    # ── 輔助 ────────────────────────────────────────────────────────────

    @staticmethod
    async def _sleep(seconds: float) -> None:
        import asyncio

        await asyncio.sleep(seconds)

    @property
    def banner(self) -> str:
        return self._banner

    def guess_platform(self) -> str:
        """從 banner 猜是 MicroPython 還是 CircuitPython。"""
        lowered = self._banner.lower()
        if "circuitpython" in lowered:
            return "circuitpython"
        if "micropython" in lowered:
            return "micropython"
        return "unknown"


def _now_ms() -> int:
    import time

    return int(time.monotonic() * 1000)
