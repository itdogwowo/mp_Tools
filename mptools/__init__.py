"""mp_Tools — 跨平臺 MicroPython / CircuitPython 開發者工作臺。

公開介面刻意保持很小。上層（CLI 與 web server）只透過這裡的符號溝通，
方便日後替換內部實作。
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
