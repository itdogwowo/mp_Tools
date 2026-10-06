"""序列埠傳輸層。

**命名注意：** 這個套件叫 ``transport`` 而不是 ``serial``，因為 pyserial 的頂層
套件就叫 ``serial``，命名成 ``mptools/serial/`` 會讓 ``import serial`` 抓到
自己（Python 3 的絕對匯入會先找到同名子套件），造成極難 debug 的循環匯入。
"""

from __future__ import annotations

from .busy import PortHolder, describe_holders, suspect_processes
from .ports import (
    KNOWN_USB_IDS,
    BoardGuess,
    PortBusyError,
    PortInfo,
    find_port,
    guess_board,
    list_ports,
    probe_port,
)
from .serial_io import (
    SerialReadTimeout,
    SerialSettings,
    SerialTransport,
    SerialTransportError,
    list_serial_ports_with_error,
)

__all__ = [
    "KNOWN_USB_IDS",
    "BoardGuess",
    "PortBusyError",
    "PortHolder",
    "PortInfo",
    "SerialReadTimeout",
    "SerialSettings",
    "SerialTransport",
    "SerialTransportError",
    "describe_holders",
    "find_port",
    "guess_board",
    "list_ports",
    "list_serial_ports_with_error",
    "probe_port",
    "suspect_processes",
]
