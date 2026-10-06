"""``mpt`` 命令列入口。

    mpt           啟動 web 服務（預設動作）
    mpt ports     列出序列埠，並指出被誰佔用
    mpt repl      在終端機裡直接開一個 REPL（不需要瀏覽器）
    mpt exec      在裝置上執行一段程式
    mpt doctor    檢查環境：Python 版本、套件、序列埠、佔用者
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from . import __version__


def _force_utf8() -> None:
    """Windows 主控台預設不是 UTF-8，中文會變亂碼。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


# ── mpt ports ───────────────────────────────────────────────────────────


def cmd_ports(args: argparse.Namespace) -> int:
    from .transport.ports import describe_holders, list_ports

    ports = list_ports(include_virtual=args.all, probe=not args.no_probe)
    if not ports:
        print("沒有找到序列埠。")
        print("  · 確認 USB 線有插好（有些線只能充電，沒有資料線）")
        print("  · Windows 需要對應的驅動：CP210x / CH34x / FTDI")
        return 1

    print(f"找到 {len(ports)} 個序列埠：\n")
    for port in ports:
        marks = []
        if port.busy:
            marks.append("忙碌")
        if port.board.kind == "native-usb":
            marks.append("原生 USB")
        suffix = f"  [{' · '.join(marks)}]" if marks else ""
        print(f"  {port.device:<8} {port.usb_id or '—':<10} {port.board.label}{suffix}")
        if port.serial_number:
            print(f"           serial={port.serial_number}")
        if port.busy:
            print(f"           ↳ {port.busy_reason}")
            if port.busy_hint and not args.quiet:
                for line in port.busy_hint.splitlines():
                    print(f"             {line}")

    busy = [p for p in ports if p.busy]
    if busy and not args.quiet:
        print(f"\n有 {len(busy)} 個埠被佔用。Windows 的序列埠是獨佔的，")
        print("同一個埠不能同時被兩個程式開著 —— 請關掉佔用的程式再試。")
        print(f"\n{describe_holders()}")
    return 0


# ── mpt doctor ──────────────────────────────────────────────────────────


def cmd_doctor(args: argparse.Namespace) -> int:
    import importlib
    import platform

    print(f"mp_Tools v{__version__} · 環境檢查\n")
    print(f"  Python      {platform.python_version()} ({sys.executable})")
    if sys.version_info < (3, 10):
        print("              ✗ 需要 3.10 以上")
        return 1
    print("              ✓")

    ok = True
    for module, why in (
        ("serial", "pyserial：序列埠存取"),
        ("esptool", "esptool：ESP 晶片燒錄"),
        ("aiohttp", "aiohttp：web 服務"),
    ):
        try:
            imported = importlib.import_module(module)
            version = getattr(imported, "__version__", "?")
            print(f"  {module:<11} {version:<10} ✓  {why}")
        except ImportError:
            print(f"  {module:<11} {'—':<10} ✗  {why}（pip install {module}）")
            ok = False

    from .transport.ports import describe_holders, list_ports

    ports = list_ports(probe=True)
    print(f"\n  序列埠      找到 {len(ports)} 個")
    for port in ports:
        state = "忙碌" if port.busy else "可用"
        print(f"    {port.device:<8} {port.usb_id or '—':<10} {port.board.label}  [{state}]")

    if any(p.busy for p in ports):
        print("\n  佔用者推測：")
        for line in describe_holders().splitlines():
            print(f"    {line}")

    print()
    print("環境就緒。" if ok else "有缺少的套件，請先安裝。")
    return 0 if ok else 1


# ── mpt repl ────────────────────────────────────────────────────────────


def cmd_repl(args: argparse.Namespace) -> int:
    """終端機 REPL：直接接管使用者的鍵盤，走 friendly REPL。"""
    import threading

    import serial

    from .transport.ports import find_port, list_ports

    ports = list_ports(probe=True)
    target = find_port(ports, device=args.device)
    if target is None:
        if args.device:
            print(f"找不到序列埠 {args.device}")
        else:
            usable = [p for p in ports if not p.busy and p.vid is not None]
            if not usable:
                print("沒有可用的序列埠。用 `mpt ports` 看詳細狀況。")
                return 1
            target = usable[0]
            print(f"自動選擇 {target.device}（{target.board.label}）")
    if target.busy:
        print(f"{target.device} 被其他程式佔用：{target.busy_reason}")
        if target.busy_hint:
            print(target.busy_hint)
        return 1

    port = serial.Serial(target.device, args.baudrate, timeout=0.05)
    print(f"已連上 {target.device} @ {args.baudrate}。按 Ctrl-] 離開。")

    stop = threading.Event()

    def pump() -> None:
        while not stop.is_set():
            try:
                data = port.read(4096)
            except (OSError, serial.SerialException):
                break
            if data:
                sys.stdout.write(data.decode("utf-8", "replace"))
                sys.stdout.flush()

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        while True:
            import msvcrt

            char = msvcrt.getch()
            if char == b"\x1d":  # Ctrl-]
                break
            port.write(char)
    except (KeyboardInterrupt, EOFError):
        pass
    except ImportError:
        # 非 Windows：直接進 raw 模式轉送
        import tty

        tty.setraw(sys.stdin.fileno())
        try:
            while True:
                data = sys.stdin.buffer.read(1)
                if not data or data == b"\x1d":
                    break
                port.write(data)
        finally:
            tty.setcbreak(sys.stdin.fileno())
    finally:
        stop.set()
        reader.join(1.0)
        port.close()
        print("\n已中斷連線。")
    return 0


# ── mpt exec ────────────────────────────────────────────────────────────


def cmd_exec(args: argparse.Namespace) -> int:
    return asyncio.run(_exec_async(args))


async def _exec_async(args: argparse.Namespace) -> int:
    import serial

    from .device.mpy import MpyExecutor, MpyTimeoutError
    from .transport.ports import find_port, list_ports
    from .transport.serial_io import SerialTransport

    code = args.code
    if code == "-":
        code = sys.stdin.read()

    ports = list_ports(probe=True)
    target = find_port(ports, device=args.device) if args.device else None
    if target is None:
        usable = [p for p in ports if not p.busy and p.vid is not None]
        if not usable:
            print("沒有可用的序列埠。")
            return 1
        target = usable[0]
    if target.busy:
        print(f"{target.device} 被其他程式佔用：{target.busy_reason}")
        return 1

    transport = SerialTransport(target.device)
    await transport.open(args.baudrate)
    executor = MpyExecutor(transport)
    try:
        await executor.enter()
        result = await executor.exec(code, timeout=args.timeout)
        if result.stdout:
            sys.stdout.write(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
        if result.error is not None:
            print(
                f"\n{result.error.type}: {result.error.message}（{result.error.file} 第 {result.error.line} 行）",
                file=sys.stderr,
            )
            return 2
        return 0
    except MpyTimeoutError as exc:
        print(f"逾時：{exc}", file=sys.stderr)
        return 3
    finally:
        await executor.exit()
        await transport.close()


# ── mpt（啟動 web 服務）─────────────────────────────────────────────────


def cmd_serve(args: argparse.Namespace) -> int:
    from .web.server import serve

    try:
        asyncio.run(serve(host=args.host, port=args.port, open_browser=not args.no_browser))
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


# ── 參數解析 ────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mpt",
        description="mp_Tools — MicroPython / CircuitPython 開發者工作臺",
    )
    parser.add_argument("--version", action="version", version=f"mp_Tools {__version__}")
    sub = parser.add_subparsers(dest="command")

    serve_parser = sub.add_parser("serve", help="啟動 web 服務（預設）")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)
    serve_parser.add_argument("--no-browser", action="store_true", help="不要自動開瀏覽器")
    serve_parser.set_defaults(func=cmd_serve)

    ports_parser = sub.add_parser("ports", help="列出序列埠")
    ports_parser.add_argument("--all", action="store_true", help="連藍牙等虛擬埠一起列出")
    ports_parser.add_argument("--no-probe", action="store_true", help="不要嘗試開啟（不偵測佔用）")
    ports_parser.add_argument("-q", "--quiet", action="store_true", help="只列出埠，不要建議")
    ports_parser.set_defaults(func=cmd_ports)

    repl_parser = sub.add_parser("repl", help="終端機 REPL")
    repl_parser.add_argument("-d", "--device", help="序列埠名稱，例如 COM27")
    repl_parser.add_argument("-b", "--baudrate", type=int, default=115200)
    repl_parser.set_defaults(func=cmd_repl)

    exec_parser = sub.add_parser("exec", help="在裝置上執行一段程式")
    exec_parser.add_argument("code", help="要執行的程式；用 - 從 stdin 讀取")
    exec_parser.add_argument("-d", "--device")
    exec_parser.add_argument("-b", "--baudrate", type=int, default=115200)
    exec_parser.add_argument("-t", "--timeout", type=float, default=10.0)
    exec_parser.set_defaults(func=cmd_exec)

    doctor_parser = sub.add_parser("doctor", help="環境檢查")
    doctor_parser.set_defaults(func=cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    _force_utf8()
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "func", None) is None:
        # 沒有子命令時，預設就是啟動服務
        args = parser.parse_args(["serve", *(argv or [])])
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
