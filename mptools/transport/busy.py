"""猜測「是誰佔用了序列埠」。

**這只是啟發式，不是保證。** Windows 沒有提供「哪個 process 開著 COM27」的公開 API
（要拿到得用 ``NtQuerySystemInformation`` 列舉核心 handle，或 Sysinternals ``handle.exe``，
兩者都需要額外權限）。所以我們做成本很低、命中率卻不錯的事：**看哪些已知會獨佔序列埠的
程式正在跑**。

**文案紀律：** 回傳的是「可能」，不是「就是」。只有一個候選時可以說得肯定一點，
但永遠要讓使用者能自己判斷 —— 照著錯誤提示去關掉錯的程序比沒有提示更糟。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

__all__ = ["PortHolder", "suspect_processes", "describe_holders", "running_processes"]


@dataclass(frozen=True)
class PortHolder:
    pid: int
    name: str
    why: str


#: process 執行檔名（小寫、可含 .exe）→ 為什麼它會佔用序列埠
#: 只收「幾乎必然會開序列埠」的程式。
_SUSPECTS: dict[str, str] = {
    "thonny.exe": "Thonny IDE 的序列埠連線",
    "arduino.exe": "Arduino IDE 的 Serial Monitor",
    "arduino-cli.exe": "Arduino CLI 的 monitor",
    "mpremote.exe": "mpremote 的 REPL 連線",
    "esptool.exe": "esptool 仍在執行",
    "esp-idf-monitor.exe": "ESP-IDF 的 idf.py monitor",
    "putty.exe": "PuTTY 終端機連線",
    "kitty.exe": "KiTTY 終端機連線",
    "ttermpro.exe": "Tera Term 終端機連線",
    "mobaxterm.exe": "MobaXterm 的序列埠工作階段",
    "realterm.exe": "RealTerm",
    "cutecom": "CuteCom",
    "minicom": "minicom",
    "picocom": "picocom",
    "screen": "screen 工作階段",
    "platformio.exe": "PlatformIO 的 monitor",
    "pio.exe": "PlatformIO 的 monitor",
    "sscom.exe": "SSCOM 序列埠助理",
    "comassistant.exe": "序列埠助理",
    "xshell.exe": "Xshell 的序列埠工作階段",
    "openocd.exe": "OpenOCD 除錯連線",
    "pyocd.exe": "pyOCD 除錯連線",
    "jlink.exe": "J-Link 工具佔用中",
}

#: 這些程式只有在「剛好開著序列埠」時才會佔用，所以措辭要留餘地。
_CONDITIONAL: dict[str, str] = {
    "code.exe": "VS Code（Serial Monitor 擴充、ESP-IDF 的 monitor，或終端機裡的 mpremote）",
    "code - insiders.exe": "VS Code Insiders（同上）",
    "cursor.exe": "Cursor（序列埠擴充或終端機）",
    "pycharm64.exe": "PyCharm（序列埠外掛或終端機）",
    "idea64.exe": "IntelliJ IDEA（序列埠外掛或終端機）",
    "windowsterminal.exe": "Windows 終端機（裡面可能開著 mpremote / esptool）",
    "powershell.exe": "PowerShell 視窗（裡面可能開著 mpremote / esptool）",
    "pwsh.exe": "PowerShell 視窗（裡面可能開著 mpremote / esptool）",
    "cmd.exe": "命令提示字元（裡面可能開著 mpremote / esptool）",
    "python.exe": "Python 程序（可能正在跑 mpremote、esptool 或你自己的腳本）",
    "pythonw.exe": "Python 程序（同上）",
    "python3": "Python 程序（同上）",
}


def running_processes() -> list[tuple[int, str]]:
    """回傳執行中的 ``(pid, exe_name)``。

    Windows 走 Toolhelp API（``ctypes`` 直接呼叫，**不開子程序** ——
    子程序加管線在受限環境下會被擋掉，而且慢一個數量級）。
    POSIX 走 ``/proc``。
    """
    if sys.platform == "win32":
        return _processes_windows()
    return _processes_posix()


def _processes_windows() -> list[tuple[int, str]]:
    import ctypes
    from ctypes import wintypes

    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    MAX_PATH = 260

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * MAX_PATH),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        return []

    found: list[tuple[int, str]] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        while True:
            found.append((int(entry.th32ProcessID), str(entry.szExeFile)))
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def _processes_posix() -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return found
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", encoding="utf-8", errors="replace") as fh:
                found.append((int(entry), fh.read().strip()))
        except OSError:
            continue
    return found


def suspect_processes(processes: list[tuple[int, str]] | None = None) -> list[PortHolder]:
    """回傳目前正在執行、可能佔用序列埠的程序。

    確定性的佔用者（Thonny、PuTTY…）排在前面；不確定的（VS Code、Python…）排在後面。
    """
    items = processes if processes is not None else running_processes()
    certain: list[PortHolder] = []
    conditional: list[PortHolder] = []
    for pid, name in items:
        stem = name.lower()
        why = _SUSPECTS.get(stem)
        if why:
            certain.append(PortHolder(pid=pid, name=name, why=why))
            continue
        why = _CONDITIONAL.get(stem)
        if why:
            conditional.append(PortHolder(pid=pid, name=name, why=why))
    certain.sort(key=lambda h: h.name.lower())
    conditional.sort(key=lambda h: h.name.lower())
    return certain + conditional


def describe_holders(holders: list[PortHolder] | None = None) -> str:
    """把候選程序變成人看得懂的一句話。"""
    items = holders if holders is not None else suspect_processes()
    if not items:
        return "找不出明顯的佔用者。請確認沒有其他終端機或 IDE 開著這個埠。"
    if len(items) == 1:
        only = items[0]
        return f"可能是 {only.name}（PID {only.pid}）：{only.why}"
    lines = [f"有 {len(items)} 個程序可能佔用，請逐一確認："]
    for holder in items[:6]:
        lines.append(f"‧ {holder.name}（PID {holder.pid}）：{holder.why}")
    if len(items) > 6:
        lines.append(f"‧ …還有 {len(items) - 6} 個")
    return "\n".join(lines)
