"""非同步序列埠傳輸層。

設計要點：**pyserial 是阻塞式的，不能直接在 event loop 裡呼叫。** 常見的錯誤做法是用
``asyncio.to_thread(ser.read, ...)`` —— 那個執行緒會卡在 ``read()`` 裡，之後要中斷、
要改 DTR/RTS、要關埠都會失效（Windows 上尤其明顯）。

所以這裡用**一條專屬的讀取執行緒**：它用短 timeout 迴圈讀，讀到就透過
``run_coroutine_threadsafe`` 塞進 event loop 的 asyncio.Queue。寫入與訊號控制則直接
在 event loop 執行緒做（pyserial 的 write 很快，且 write_timeout 會擋住卡死）。
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass

import serial

# pyserial 的 URL handler 要顯式匯入才會註冊。
# socket:// 讓我們能用 TCP 假裝置端到端驗證整條協定鏈路（沒有硬體也能測）。
import serial.urlhandler.protocol_socket  # noqa: F401
import serial.urlhandler.protocol_loop  # noqa: F401
import serial.urlhandler.protocol_spy  # noqa: F401

from .ports import PortBusyError, probe_port

__all__ = [
    "SerialTransport",
    "SerialSettings",
    "SerialTransportError",
    "SerialReadTimeout",
    "PortBusyError",
    "open_serial",
]


def _serial_class_for(device: str):
    """URL 形式的裝置（``socket://``）要用 ``serial.serial_for_url``。"""
    if "://" in device:
        return serial.serial_for_url
    return serial.Serial

#: 讀取執行緒的輪詢間隔。太小會吃 CPU，太大會讓 Ctrl-C 之類的中斷變鈍。
_READ_POLL_S = 0.02


class SerialTransportError(RuntimeError):
    """序列埠層級的錯誤（開啟失敗、已關閉、寫入失敗）。"""


@dataclass
class SerialSettings:
    baudrate: int = 115200
    #: 使用者要求的值。USB CDC 的裝置常把 baudrate 回報成 0 或 9600，
    #: 但實際速率由 USB 決定 —— 所以兩者要分開記，不要覆蓋掉使用者的選擇。
    requested_baudrate: int = 115200
    bytesize: int = serial.EIGHTBITS
    parity: str = serial.PARITY_NONE
    stopbits: int = serial.STOPBITS_ONE
    rtscts: bool = False
    dsrdtr: bool = False

    def to_dict(self) -> dict:
        return {
            "baudrate": self.baudrate,
            "requestedBaudrate": self.requested_baudrate,
            "bytesize": self.bytesize,
            "parity": self.parity,
            "stopbits": self.stopbits,
            "rtscts": self.rtscts,
            "dsrdtr": self.dsrdtr,
        }


class SerialTransport:
    """一個已開啟的序列埠連線。

    生命週期：``open()`` → 讀寫 → ``close()``。同一個實例可以重複 open/close
    （例如換 baud rate），但同一個埠不能同時開兩次。
    """

    def __init__(self, device: str) -> None:
        self.device = device
        self._port: serial.Serial | None = None
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_reading = threading.Event()
        self._settings = SerialSettings()
        self._lock = asyncio.Lock()
        #: ``read_until`` 吃掉分隔字元之後剩下的位元組。
        #: 沒有這個緩衝，raw REPL 的 stdout/stderr 會被永久丟棄（見 read_until 的說明）。
        self._residual: bytes = b""
        self.bytes_read = 0
        self.bytes_written = 0

    # ── 狀態 ────────────────────────────────────────────────────────────

    @property
    def is_open(self) -> bool:
        return self._port is not None and self._port.is_open

    @property
    def settings(self) -> SerialSettings:
        return self._settings

    # ── 開啟 / 關閉 ─────────────────────────────────────────────────────

    async def open(
        self,
        baudrate: int = 115200,
        *,
        timeout: float = 0.05,
        dtr: bool | None = None,
        rts: bool | None = None,
    ) -> SerialSettings:
        if self.is_open:
            raise SerialTransportError(f"{self.device} 已經開啟")
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue()

        try:
            factory = _serial_class_for(self.device)
            if factory is serial.serial_for_url:
                # URL 裝置（socket:// / loop://）不接受 pyserial 的額外關鍵字
                port = factory(self.device, baudrate, timeout=timeout)
            else:
                port = factory(
                    self.device,
                    baudrate,
                    timeout=timeout,
                    write_timeout=2.0,
                )
        except serial.SerialException as exc:
            busy, reason = probe_port(self.device, baudrate)
            if busy:
                raise PortBusyError(f"無法開啟 {self.device}：{reason}") from exc
            raise SerialTransportError(f"無法開啟 {self.device}：{exc}") from exc

        self._port = port
        # 開埠時 pyserial 會拉 DTR/RTS，對 ESP32 這可能觸發重置。
        # 想避免就明講 dtr=False, rts=False（例如要接手一個正在跑的程式時）。
        if dtr is not None or rts is not None:
            try:
                port.dtr = bool(dtr) if dtr is not None else port.dtr
                port.rts = bool(rts) if rts is not None else port.rts
            except (OSError, serial.SerialException):
                pass

        self._settings = SerialSettings(
            baudrate=getattr(port, "baudrate", baudrate) or baudrate,
            requested_baudrate=baudrate,
            bytesize=port.bytesize,
            parity=port.parity,
            stopbits=port.stopbits,
            rtscts=bool(getattr(port, "rtscts", False)),
            dsrdtr=bool(getattr(port, "dsrdtr", False)),
        )
        self.bytes_read = 0
        self.bytes_written = 0

        self._stop_reading.clear()
        self._residual = b""
        self._reader_thread = threading.Thread(
            target=self._read_loop,
            name=f"mpt-read-{self.device}",
            daemon=True,
        )
        self._reader_thread.start()
        return self._settings

    async def close(self) -> None:
        self._stop_reading.set()
        thread = self._reader_thread
        if thread is not None and thread.is_alive():
            await asyncio.to_thread(thread.join, 1.5)
        self._reader_thread = None

        port, self._port = self._port, None
        if port is not None:
            try:
                port.close()
            except (OSError, serial.SerialException):
                pass
        self._drain_queue()

    async def __aenter__(self) -> "SerialTransport":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    # ── 讀取執行緒 ──────────────────────────────────────────────────────

    def _read_loop(self) -> None:
        loop = self._loop
        port = self._port
        if loop is None or port is None:
            return
        while not self._stop_reading.is_set():
            try:
                chunk = port.read(4096)
            except (OSError, serial.SerialException):
                # 埠被拔掉或關閉。安靜結束，讓 event loop 那邊自己發現 is_open 變 False。
                break
            if not chunk:
                continue
            self.bytes_read += len(chunk)
            try:
                loop.call_soon_threadsafe(self._queue.put_nowait, bytes(chunk))
            except RuntimeError:
                break  # event loop 已經關了

    def _drain_queue(self) -> None:
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    # ── 讀寫 ────────────────────────────────────────────────────────────

    async def write(self, data: bytes) -> None:
        port = self._require_port()
        try:
            written = await asyncio.to_thread(port.write, data)
        except serial.SerialTimeoutException as exc:
            raise SerialTransportError(f"寫入 {self.device} 逾時") from exc
        except (OSError, serial.SerialException) as exc:
            raise SerialTransportError(f"寫入 {self.device} 失敗：{exc}") from exc
        self.bytes_written += written or len(data)

    async def read(self, timeout: float = 0.2, max_bytes: int = 4096) -> bytes:
        """讀取「目前為止收到的」資料。逾時回傳 ``b""``，不丟錯。

        逾時不丟錯是刻意的：上層的協定需要「等到某個字串或逾時」，
        而不是「固定讀 N bytes」—— 序列埠一定會遇到半行。

        會先吐出上一次 ``read_until`` 留下的殘餘資料再等新資料。
        """
        self._require_port()
        if self._residual:
            out = self._residual[:max_bytes]
            self._residual = self._residual[max_bytes:]
            if out:
                return out
        try:
            first = await asyncio.wait_for(self._queue.get(), timeout)
        except asyncio.TimeoutError:
            return b""
        out = bytearray(first)
        while len(out) < max_bytes:
            try:
                out.extend(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return bytes(out)

    async def read_until(
        self,
        delimiter: bytes,
        timeout: float = 2.0,
        *,
        max_bytes: int = 1 << 20,
    ) -> bytes:
        """累積讀到 ``delimiter`` 出現為止（回傳內容含 delimiter）。

        **分隔字元之後的資料會被保留**，下一次 ``read`` / ``read_until`` 會先拿到它。

        這一點是這個檔案裡最重要的一行註解：MicroPython 的 raw REPL 會把
        ``OK<stdout>\\x04<stderr>\\x04>`` **一次全部送出**。如果 ``read_until(b">")``
        把整包吃掉就丟掉，stdout 與 stderr 就永遠讀不到了 —— 而且症狀會是
        「連得上、進得了 raw REPL，但 exec 永遠拿到空字串」，
        非常像裝置壞掉，其實是主機端把資料吃掉。

        逾時丟 :class:`SerialReadTimeout`，例外裡帶著已經收到的內容。
        """
        deadline = time.monotonic() + timeout
        buffer = bytearray()
        while True:
            found = buffer.find(delimiter)
            if found != -1:
                end = found + len(delimiter)
                self._residual = bytes(buffer[end:]) + self._residual
                return bytes(buffer[:end])
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(buffer) >= max_bytes:
                # 逾時時把已讀到的部分也留著，不要讓它消失
                self._residual = bytes(buffer) + self._residual
                raise SerialReadTimeout(delimiter, bytes(buffer), timeout)
            buffer.extend(await self.read(min(remaining, 0.2)))

    def peek_residual(self) -> bytes:
        """目前還沒被取用的殘餘資料（測試與診斷用）。"""
        return self._residual

    async def flush_input(self) -> None:
        port = self._require_port()
        await asyncio.to_thread(port.reset_input_buffer)
        self._drain_queue()
        self._residual = b""

    async def flush_output(self) -> None:
        port = self._require_port()
        await asyncio.to_thread(port.flush)

    async def set_signals(self, *, dtr: bool | None = None, rts: bool | None = None) -> None:
        port = self._require_port()

        def apply() -> None:
            if dtr is not None:
                port.dtr = dtr
            if rts is not None:
                port.rts = rts

        try:
            await asyncio.to_thread(apply)
        except (OSError, serial.SerialException) as exc:
            raise SerialTransportError(f"設定 DTR/RTS 失敗：{exc}") from exc

    async def pulse_reset(self, *, active_low: bool = True, hold_s: float = 0.12) -> None:
        """用 DTR/RTS 做一次經典的 ESP 重置序列。

        只有在 USB-UART 橋接晶片（CP210x / CH34x / FTDI）接上 auto-reset 電路時才有效。
        原生 USB Serial-JTAG 的 ESP32-S3 不吃這一套 —— 對它要用 ``esptool`` 的
        ``--before usb-reset``，或請使用者手按 BOOT + RESET。
        """
        port = self._require_port()

        def apply() -> None:
            if active_low:
                port.dtr = False
                port.rts = True
                time.sleep(hold_s)
                port.dtr = True
                port.rts = False
                time.sleep(hold_s)
                port.dtr = False
                port.rts = False
            else:
                port.dtr = True
                time.sleep(hold_s)
                port.dtr = False

        await asyncio.to_thread(apply)

    def _require_port(self) -> serial.Serial:
        port = self._port
        if port is None or not port.is_open:
            raise SerialTransportError(f"{self.device} 尚未開啟")
        return port

    def info(self) -> dict:
        return {
            "device": self.device,
            "open": self.is_open,
            "settings": self._settings.to_dict(),
            "bytesRead": self.bytes_read,
            "bytesWritten": self.bytes_written,
        }


class SerialReadTimeout(TimeoutError):
    """等不到分隔字串。保留已收到的內容，讓上層能顯示出來。"""

    def __init__(self, delimiter: bytes, received: bytes, timeout: float) -> None:
        preview = received[-200:]
        super().__init__(
            f"等候 {delimiter!r} 逾時（{timeout}s）；已收到 {len(received)} bytes：{preview!r}"
        )
        self.delimiter = delimiter
        self.received = received
        self.timeout = timeout


def list_serial_ports_with_error() -> tuple[list, str | None]:
    """``list_ports`` 的安全版本：把例外變成回傳值，方便直接餵給 web API。"""
    from .ports import list_ports

    try:
        return list_ports(), None
    except Exception as exc:  # pragma: no cover - 只有驅動層壞掉才會到這
        return [], f"{type(exc).__name__}: {exc}"
