"""raw REPL 協定的**位元組層級**測試。

為什麼一定要測位元組：
開發這一段時，所有 bug 都是「解析結果看起來對、位元組卻錯」——
1. ``read_until`` 把分隔字元之後的資料丟掉 → stdout 永遠是空的
2. 誤以為裝置在每個換行後回 ``>`` → 實際上是 ``\\x04`` 才回
3. 誤以為 ``OK`` 是獨立的欄位 → 實際上它黏在 stdout 前面

這三個都無法用「回傳值看起來合理」的測試抓到。所以這裡斷言的是**送出的位元組序列**。
"""

from __future__ import annotations

import asyncio

import pytest

from mptools.device.mpy import (
    CTRL_A,
    CTRL_B,
    CTRL_C,
    CTRL_D,
    MpyExecError,
    MpyExecutor,
    MpyTimeoutError,
    parse_traceback,
)
from mptools.transport.serial_io import SerialTransport
from tests.fake_device import RAW_BANNER, FakeMpyDevice


# ── 測試替身：記錄送出的位元組，回放預先排好的回應 ──────────────────────


class ScriptedTransport:
    """最小可用的 transport 替身。

    語意上區分兩件事，這一點很重要：
      * ``_pending``：裝置準備好、等著被讀走的回應
      * ``_inbox``：已經在同一條「線」上、等著被讀的位元組

    回應是在 ``read`` / ``read_until`` 時才從 ``_pending`` 拉進 ``_inbox``，
    **不是**在 ``write`` 的時候。這忠實反映了真機：``write()`` 只把位元組送出去，
    裝置的回應什麼時候回來是另一回事 —— 所以 ``flush_input()`` 清得掉已經在線上的
    東西，清不掉裝置還沒吐出來的東西。

    ``MpyExecutor.enter()`` 依賴這個區別：它在送 Ctrl-A **之前** flush，
    所以 banner 不會被自己的 flush 清掉。
    """

    def __init__(self, responses: list[bytes]) -> None:
        self.written = bytearray()
        self._pending = list(responses)
        self._inbox = bytearray()

    def _pull(self) -> None:
        if self._pending:
            self._inbox.extend(self._pending.pop(0))

    async def write(self, data: bytes) -> None:
        self.written.extend(data)

    async def read(self, timeout: float = 0.2, max_bytes: int = 4096) -> bytes:
        if not self._inbox:
            self._pull()
        if not self._inbox:
            return b""
        out = bytes(self._inbox[:max_bytes])
        del self._inbox[:max_bytes]
        return out

    async def read_until(self, delimiter: bytes, timeout: float = 2.0, **_) -> bytes:
        from mptools.transport.serial_io import SerialReadTimeout

        for _ in range(len(self._pending) + 1):
            found = self._inbox.find(delimiter)
            if found != -1:
                end = found + len(delimiter)
                out = bytes(self._inbox[:end])
                del self._inbox[:end]
                return out
            self._pull()
        raise SerialReadTimeout(delimiter, bytes(self._inbox), timeout)

    async def flush_input(self) -> None:
        self._inbox.clear()


def test_enter_sends_ctrl_c_twice_then_ctrl_a() -> None:
    """進 raw REPL 的位元組序列：Ctrl-C Ctrl-C Ctrl-A（flush 不寫入任何位元組）。"""

    async def scenario() -> None:
        transport = ScriptedTransport([RAW_BANNER])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        await executor.enter()
        assert bytes(transport.written) == CTRL_C + CTRL_C + CTRL_A

    asyncio.run(scenario())


def test_exec_wire_format_and_ok_prefix_attached_to_stdout() -> None:
    """``OK`` 黏在 stdout 前面，不是獨立欄位。

    裝置實際送出的位元組是 ``b"OKone\\r\\n\\x04\\x04>"``：
      head   = ``b"OKone\\r\\n\\x04"``  →  ``OK`` + stdout
      stderr = ``b"\\x04"``
      tail   = ``b">"``
    """

    async def scenario() -> None:
        transport = ScriptedTransport([b"OKone\r\n\x04\x04>"])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        executor.in_raw_repl = True

        result = await executor.exec("print('one')")
        assert result.stdout == "one\r\n"
        assert result.stderr == ""
        assert result.error is None
        # 送出的位元組必須是「程式 + Ctrl-D」，中間不得插入換行或應答等待
        assert bytes(transport.written) == b"print('one')" + CTRL_D

    asyncio.run(scenario())


def test_exec_reads_frames_in_order_never_prompt_first() -> None:
    """必須**先**依 ``\\x04`` 分段讀，不能先讀 ``>``。

    這個測試用「整包一次送出」的回應來抓：如果實作先 ``read_until(b">")``，
    就會把 stdout / stderr 一起吃掉，stdout 變成空字串。
    """

    async def scenario() -> None:
        transport = ScriptedTransport([b"OKhello\x04Traceback!\x04>"])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        executor.in_raw_repl = True

        result = await executor.exec("x")
        assert result.stdout == "hello", "stdout 被吃掉了 —— 讀取順序錯了"
        assert result.stderr == "Traceback!"
        assert result.error is None  # 沒有 traceback 標頭就不算結構化錯誤

    asyncio.run(scenario())


def test_exec_surfaces_device_error_from_head_frame() -> None:
    """裝置拒絕執行程式時，**整個 head 欄位就是錯誤訊息，而且不帶 ``OK`` 前綴**。

    raw REPL 的成功／失敗是靠「head 有沒有以 OK 開頭」判斷的：

        成功：``b"OK" + stdout + b"\\x04" + stderr + b"\\x04>"``
        失敗：``traceback + b"\\x04" + b"\\x04>"``（沒有 OK，也沒有 stderr 欄位）
    """
    traceback = (
        "Traceback (most recent call last):\r\n"
        '  File "<stdin>", line 1, in <module>\r\n'
        "NameError: name 'foo' isn't defined\r\n"
    )

    async def scenario() -> None:
        transport = ScriptedTransport([traceback.encode() + b"\x04\x04>"])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        executor.in_raw_repl = True

        result = await executor.exec("foo()")
        assert result.stdout == ""
        assert result.stderr.startswith("Traceback (most recent call last)")
        assert result.error is not None
        assert result.error.type == "NameError"
        assert result.error.line == 1

    asyncio.run(scenario())


def test_interrupt_reenters_raw_repl() -> None:
    """``Ctrl-C`` 會把裝置踢回 friendly REPL，所以中斷後一定要重送 ``Ctrl-A``。

    沒有這一步，整個 session 就廢了：之後每次 exec 都會在 friendly REPL 的
    echo 上撞牆，而且症狀是「逾時 + 收到像 echo 的內容」，非常難懂。
    """

    async def scenario() -> None:
        transport = ScriptedTransport([RAW_BANNER])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        executor.in_raw_repl = True

        await executor.interrupt()
        assert bytes(transport.written) == CTRL_C + CTRL_A
        assert executor.in_raw_repl is True

    asyncio.run(scenario())


def test_exec_without_enter_raises() -> None:
    async def scenario() -> None:
        transport = ScriptedTransport([])
        executor = MpyExecutor(transport)  # type: ignore[arg-type]
        with pytest.raises(Exception, match="raw REPL"):
            await executor.exec("print(1)")

    asyncio.run(scenario())


# ── traceback 解析 ──────────────────────────────────────────────────────


def test_parse_traceback_extracts_line_and_type() -> None:
    error = parse_traceback(
        "Traceback (most recent call last):\r\n"
        '  File "main.py", line 42, in <module>\r\n'
        "ValueError: bad value\r\n"
    )
    assert error is not None
    assert error.file == "main.py"
    assert error.line == 42
    assert error.type == "ValueError"
    assert error.message == "bad value"


def test_parse_traceback_returns_none_for_plain_output() -> None:
    assert parse_traceback("just some output\r\n") is None


# ── 真 transport 的殘餘緩衝行為 ─────────────────────────────────────────


def test_read_until_keeps_bytes_after_delimiter() -> None:
    """``read_until`` 之後剩下的位元組必須留給下一次讀取。

    這是第一個 bug 的迴歸測試：把殘餘丟掉會讓 raw REPL 的 stdout 永遠讀不到。
    """

    async def scenario() -> None:
        device = FakeMpyDevice()
        port = device.start()
        transport = SerialTransport(f"socket://127.0.0.1:{port}")
        try:
            await transport.open(115200)
            # 直接寫一包，再用 read_until 切出前半
            await transport.write(b"x")  # 觸發假裝置不做事
            transport._residual = b"AAA>BBB"
            got = await transport.read_until(b">", 0.5)
            assert got == b"AAA>"
            assert transport.peek_residual() == b"BBB"
            assert await transport.read(0.5) == b"BBB"
        finally:
            await transport.close()
            device.stop()

    asyncio.run(scenario())
