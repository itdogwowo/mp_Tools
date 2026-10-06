"""序列埠列舉與佔用偵測。

這個模組解決的是純 Web 版做不到的第一件事：**在瀏覽器裡看不到 COM port 清單，
`navigator.serial.requestPort()` 一定要使用者手動點、一定會跳對話框。**
用 pyserial 的 ``list_ports`` 可以直接列出全部並且拿到 VID:PID。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import serial
from serial.tools import list_ports as _list_ports

from .busy import PortHolder, describe_holders, suspect_processes

__all__ = [
    "BoardGuess",
    "PortHolder",
    "PortInfo",
    "KNOWN_USB_IDS",
    "PortBusyError",
    "describe_holders",
    "guess_board",
    "list_ports",
    "probe_port",
    "suspect_processes",
]


class PortBusyError(RuntimeError):
    """序列埠被其他程序佔用（Windows 是獨佔的）。"""


@dataclass(frozen=True)
class BoardGuess:
    """依 VID:PID 猜出來的硬體身分。"""

    label: str
    kind: str
    """``usb-serial`` | ``native-usb`` | ``uf2`` | ``debug-probe`` | ``unknown``"""
    supports_auto_reset: bool
    """能不能靠 DTR/RTS 自動進 bootloader（CP210x/CH34x/FTDI 可以，原生 USB 不一定）。"""


# VID:PID → 硬體。來源：各家 datasheet 與 esptool / Adafruit 的裝置表。
KNOWN_USB_IDS: dict[tuple[int, int], BoardGuess] = {
    # ── USB-UART 橋接晶片（開發板最常見）────────────────────────────
    (0x10C4, 0xEA60): BoardGuess("Silicon Labs CP2102/CP2104", "usb-serial", True),
    (0x10C4, 0xEA70): BoardGuess("Silicon Labs CP2105", "usb-serial", True),
    (0x1A86, 0x7523): BoardGuess("WCH CH340", "usb-serial", True),
    (0x1A86, 0x5523): BoardGuess("WCH CH341", "usb-serial", True),
    (0x1A86, 0x55D4): BoardGuess("WCH CH9102", "usb-serial", True),
    (0x0403, 0x6001): BoardGuess("FTDI FT232R", "usb-serial", True),
    (0x0403, 0x6010): BoardGuess("FTDI FT2232", "usb-serial", True),
    (0x0403, 0x6015): BoardGuess("FTDI FT231X", "usb-serial", True),
    # ── Espressif 原生 USB（ESP32-S2/S3/C3/C6/H2 內建）──────────────
    (0x303A, 0x1001): BoardGuess("Espressif USB-Serial-JTAG", "native-usb", False),
    (0x303A, 0x4001): BoardGuess("Espressif USB-Serial-JTAG (ESP32-S3)", "native-usb", False),
    (0x303A, 0x0002): BoardGuess("Espressif ESP32-S2 (USB-OTG)", "native-usb", False),
    # ── Raspberry Pi RP2040 / RP2350 ────────────────────────────────
    (0x2E8A, 0x0005): BoardGuess("Raspberry Pi Pico (CDC)", "usb-serial", False),
    (0x2E8A, 0x000A): BoardGuess("Raspberry Pi Pico (MicroPython CDC)", "usb-serial", False),
    (0x2E8A, 0x0003): BoardGuess("Raspberry Pi RP2040 BOOTSEL (UF2)", "uf2", False),
    (0x2E8A, 0x000F): BoardGuess("Raspberry Pi RP2350 BOOTSEL (UF2)", "uf2", False),
    # ── 其他 MCU 原生 USB ──────────────────────────────────────────
    (0x2341, 0x0043): BoardGuess("Arduino Uno", "usb-serial", True),
    (0x2341, 0x0070): BoardGuess("Arduino (SAMD21 native USB)", "native-usb", False),
    (0x239A, 0x8015): BoardGuess("Adafruit (SAMD21 native USB)", "native-usb", False),
    (0x239A, 0x80C9): BoardGuess("Adafruit Feather ESP32-S3", "native-usb", False),
    (0x239A, 0x811B): BoardGuess("Adafruit Feather RP2040", "usb-serial", False),
    (0x0483, 0x5740): BoardGuess("STMicroelectronics STM32 (CDC)", "native-usb", False),
    (0x1915, 0x520F): BoardGuess("Nordic nRF52840 (CDC)", "native-usb", False),
    # ── 除錯探針 ───────────────────────────────────────────────────
    (0x1366, 0x1015): BoardGuess("SEGGER J-Link", "debug-probe", False),
    (0x2E8A, 0x000C): BoardGuess("Raspberry Pi Debug Probe", "debug-probe", False),
}


def guess_board(vid: int | None, pid: int | None) -> BoardGuess:
    """把 VID:PID 轉成可讀的硬體描述。未知的裝置回傳 ``unknown`` 而不是丟錯。"""
    if vid is None or pid is None:
        return BoardGuess("未知序列埠", "unknown", False)
    known = KNOWN_USB_IDS.get((vid, pid))
    if known is not None:
        return known
    return BoardGuess(f"未知 USB 裝置 {vid:04X}:{pid:04X}", "unknown", False)


@dataclass
class PortInfo:
    device: str
    """例如 ``COM27`` 或 ``/dev/ttyACM0``。"""
    description: str = ""
    hwid: str = ""
    vid: int | None = None
    pid: int | None = None
    serial_number: str | None = None
    manufacturer: str | None = None
    product: str | None = None
    location: str | None = None
    board: BoardGuess = field(default_factory=lambda: BoardGuess("未知序列埠", "unknown", False))
    busy: bool = False
    """True 表示這個埠被別的程序佔用，開不起來。"""
    busy_reason: str = ""
    """佔用的原因（Windows 上目前只能說是權限被拒，拿不到佔用者的名字）。"""
    busy_hint: str = ""
    """根據「哪些程序正在跑」推測的佔用者。是啟發式，不是保證。"""

    @property
    def usb_id(self) -> str:
        if self.vid is None or self.pid is None:
            return ""
        return f"{self.vid:04X}:{self.pid:04X}"

    def to_dict(self) -> dict:
        return {
            "device": self.device,
            "description": self.description,
            "hwid": self.hwid,
            "vid": self.vid,
            "pid": self.pid,
            "usbId": self.usb_id,
            "serialNumber": self.serial_number,
            "manufacturer": self.manufacturer,
            "product": self.product,
            "location": self.location,
            "boardLabel": self.board.label,
            "boardKind": self.board.kind,
            "supportsAutoReset": self.board.supports_auto_reset,
            "busy": self.busy,
            "busyReason": self.busy_reason,
            "busyHint": self.busy_hint,
        }


def _to_port_info(port: "_list_ports.ListPortInfo") -> PortInfo:
    vid = getattr(port, "vid", None)
    pid = getattr(port, "pid", None)
    return PortInfo(
        device=port.device,
        description=port.description or "",
        hwid=port.hwid or "",
        vid=vid,
        pid=pid,
        serial_number=getattr(port, "serial_number", None),
        manufacturer=getattr(port, "manufacturer", None),
        product=getattr(port, "product", None),
        location=getattr(port, "location", None),
        board=guess_board(vid, pid),
    )


def _is_probably_real_port(info: PortInfo) -> bool:
    """過濾掉藍牙序列埠與雜項裝置 —— 它們會讓下拉選單變得很吵。"""
    if info.vid is not None:
        return True
    hwid = info.hwid.upper()
    # 藍牙的 hwid 長這樣：BTHENUM\{...}
    if "BTHENUM" in hwid:
        return False
    return True


def probe_port(device: str, baudrate: int = 115200, open_timeout: float = 1.0) -> tuple[bool, str]:
    """嘗試開啟序列埠，判斷它是不是被佔用了。

    回傳 ``(busy, reason)``。

    **Windows 的序列埠是獨佔的**：被別的程序開著時，``serial.Serial()`` 會丟
    ``PermissionError``。這是我們唯一能取得的訊號 —— Windows 沒有提供
    「誰佔用了這個埠」的公開 API。

    URL 形式的裝置（``socket://`` / ``loop://`` / ``spy://``）跳過探測：探測它們
    會產生假的「忙碌」訊號（真的開啟就會建連線，關掉又斷線）。
    """
    if "://" in device:
        return False, ""
    try:
        with serial.Serial(device, baudrate, timeout=0, write_timeout=open_timeout):
            return False, ""
    except serial.SerialException as exc:
        text = str(exc)
        if isinstance(exc.__cause__, PermissionError) or "PermissionError" in repr(exc):
            return True, "被其他程序佔用（Windows 序列埠是獨佔的）"
        if "access is denied" in text.lower() or "拒絕存取" in text:
            return True, "被其他程序佔用（存取被拒）"
        return True, f"無法開啟：{text}"
    except OSError as exc:
        if getattr(exc, "errno", None) in (13, 16):  # EACCES, EBUSY
            return True, "被其他程序佔用"
        return True, f"無法開啟：{exc}"


def list_ports(
    *,
    include_virtual: bool = False,
    probe: bool = True,
    baudrate: int = 115200,
) -> list[PortInfo]:
    """列出序列埠。

    Args:
        include_virtual: 連藍牙之類的虛擬序列埠一起列出（預設過濾掉）。
        probe: 是否逐一嘗試開啟以偵測佔用。偵測會短暫佔用每個埠，
            在別的程式正在用那些埠時仍能正確回報 busy。
        baudrate: 探測時使用的 baud rate。**不要**亂改成 921600 去探測，
            那會在部分板子上觸發重置。
    """
    result: list[PortInfo] = []
    for raw in _list_ports.comports():
        info = _to_port_info(raw)
        if not include_virtual and not _is_probably_real_port(info):
            continue
        if probe:
            info.busy, info.busy_reason = probe_port(info.device, baudrate)
        result.append(info)

    # 只有在真的有埠被佔用時才去列程序（那一步要跑 PowerShell，不便宜）
    if any(item.busy for item in result):
        hint = describe_holders()
        for item in result:
            if item.busy:
                item.busy_hint = hint

    # 有 VID:PID 的排前面（那些才是真正的開發板），再依裝置名稱排序
    result.sort(key=lambda p: (p.vid is None, p.device))
    return result


def find_port(
    ports: Iterable[PortInfo],
    *,
    device: str | None = None,
    vid_pid: tuple[int, int] | None = None,
) -> PortInfo | None:
    """從清單中挑出一個埠。``device`` 優先於 ``vid_pid``。"""
    items = list(ports)
    if device:
        wanted = device.upper()
        for item in items:
            if item.device.upper() == wanted:
                return item
        return None
    if vid_pid:
        for item in items:
            if item.vid == vid_pid[0] and item.pid == vid_pid[1]:
                return item
        return None
    return None
