"""Python 啟動器：一個 aiohttp 服務，負責三件事。

1. **把 UI 送給瀏覽器** —— 服務 ``web/`` 底下的靜態檔，不需要 npm、不需要 build step。
2. **提供真實的序列埠能力** —— 這是純 Web 版做不到的部分：列出所有 COM port
   （含 VID:PID、晶片型號、以及「被誰佔用」），完全不用跳瀏覽器的裝置選擇對話框。
3. **雙向 WebSocket 橋接** —— 瀏覽器與裝置之間即時互傳位元組，並回報結構化事件。

設計取捨：**前端刻意保持零依賴、零 build step。**
``web/index.html`` 就是可以直接用瀏覽器開的那一個檔案（沿用已定案的 UI 設計），
這個 server 只是額外注入一段 bridge script，把它的假資料換成真的。

API（破壞性變更請一併改 web/bridge.js 與 docs/PLAN.md）：

    GET  /                  UI
    GET  /api/health        版本與能力
    GET  /api/ports         序列埠清單（含佔用偵測）
    POST /api/connect       { device, baudrate } → 裝置資訊
    POST /api/disconnect
    POST /api/exec          { code, timeout } → ExecResult
    GET  /api/device        目前連線狀態
    WS   /ws                即時事件（serial data / log / progress）
"""

from __future__ import annotations

import asyncio
import json
import logging
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from .. import __version__
from ..device.mpy import MpyExecutor, MpyTimeoutError
from ..transport.ports import PortBusyError, describe_holders, list_ports
from ..transport.serial_io import SerialTransport, SerialTransportError

__all__ = ["create_app", "serve"]

log = logging.getLogger("mptools.web")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


# ── 連線狀態 ────────────────────────────────────────────────────────────


@dataclass
class DeviceSession:
    """目前作用中的裝置連線。整個服務同時只允許一個（序列埠是獨佔資源）。"""

    transport: SerialTransport | None = None
    executor: MpyExecutor | None = None
    device: str = ""
    baudrate: int = 115200
    info: dict[str, Any] = field(default_factory=dict)
    busy: str | None = None
    """正在進行的長時間操作（例如燒錄）。有值時拒絕其他操作。"""
    clients: set[web.WebSocketResponse] = field(default_factory=set)

    @property
    def connected(self) -> bool:
        return self.transport is not None and self.transport.is_open

    def status(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "device": self.device,
            "baudrate": self.baudrate,
            "info": self.info,
            "busy": self.busy,
        }

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        payload = json.dumps(message, ensure_ascii=False)
        dead: list[web.WebSocketResponse] = []
        for client in self.clients:
            try:
                await client.send_str(payload)
            except (ConnectionResetError, RuntimeError):
                dead.append(client)
        for client in dead:
            self.clients.discard(client)


# ── 裝置資訊收集 ────────────────────────────────────────────────────────


async def _collect_device_info(session: DeviceSession) -> dict[str, Any]:
    """連上之後抓一次裝置身分。每一項都獨立失敗 —— 單一查詢失敗不該讓整個連線失敗。

    **刻意不呼叫 ``machine.reset()`` 或任何有副作用的東西**：這裡只做唯讀查詢。
    """
    executor = session.executor
    assert executor is not None
    info: dict[str, Any] = {}

    async def try_exec(key: str, code: str, timeout: float = 3.0) -> None:
        try:
            result = await executor.exec(code, timeout=timeout)
            if result.ok and result.stdout.strip():
                info[key] = result.stdout.strip()
        except (MpyTimeoutError, SerialTransportError) as exc:
            info[f"{key}Error"] = str(exc)

    await try_exec("version", "import sys\nprint(sys.version)\n")
    await try_exec("implementation", "import sys\nprint(sys.implementation)\n")
    await try_exec("uname", "import os\nprint(os.uname())\n")
    await try_exec("memFree", "import gc\nprint(gc.mem_free())\n")
    await try_exec("files", "import os\nprint(os.listdir())\n")
    info["platform"] = executor.guess_platform()
    info["banner"] = executor.banner.strip()
    return info


# ── 路由 ────────────────────────────────────────────────────────────────


def _session(request: web.Request) -> DeviceSession:
    return request.app["session"]


async def handle_health(request: web.Request) -> web.Response:
    session = _session(request)
    return web.json_response(
        {
            "ok": True,
            "name": "mp_Tools",
            "version": __version__,
            "webDir": str(WEB_DIR),
            "webDirExists": WEB_DIR.is_dir(),
            "device": session.status(),
        }
    )


async def handle_ports(request: web.Request) -> web.Response:
    """列出序列埠。**這段就是 Python 啟動器存在的理由。**

    在純 Web 版裡，使用者只能按按鈕、然後在瀏覽器跳出的對話框裡選一個看不懂的
    「USB Serial Device (COM27)」。這裡我們直接給出：VID:PID、晶片型號、
    是不是原生 USB、以及**現在被誰佔用**。
    """
    include_virtual = request.query.get("all") == "1"
    ports = await asyncio.to_thread(list_ports, include_virtual=include_virtual, probe=True)
    return web.json_response(
        {
            "ports": [port.to_dict() for port in ports],
            "holders": describe_holders() if any(p.busy for p in ports) else None,
        }
    )


async def handle_connect(request: web.Request) -> web.Response:
    session = _session(request)
    body = await request.json()
    device = str(body.get("device") or "").strip()
    baudrate = int(body.get("baudrate") or 115200)

    if not device:
        raise web.HTTPBadRequest(text=json.dumps({"error": "缺少 device"}), content_type="application/json")
    if session.connected:
        raise web.HTTPConflict(
            text=json.dumps({"error": f"已經連著 {session.device}，請先中斷"}),
            content_type="application/json",
        )
    if session.busy:
        raise web.HTTPConflict(
            text=json.dumps({"error": f"裝置忙碌中：{session.busy}"}),
            content_type="application/json",
        )

    transport = SerialTransport(device)
    try:
        settings = await transport.open(baudrate)
    except PortBusyError as exc:
        holders = await asyncio.to_thread(describe_holders)
        return web.json_response(
            {"error": str(exc), "hint": holders, "kind": "busy"}, status=409
        )
    except SerialTransportError as exc:
        return web.json_response({"error": str(exc), "kind": "open-failed"}, status=502)

    executor = MpyExecutor(transport)
    try:
        await executor.enter()
    except Exception as exc:  # noqa: BLE001 - 任何失敗都要把埠還回去
        await transport.close()
        return web.json_response(
            {
                "error": f"{exc}",
                "kind": "not-micropython",
                "hint": (
                    "裝置有回應但不是 MicroPython/CircuitPython。"
                    "若剛插上 USB，請等 1～2 秒再試；若是 ESP 晶片，可能需要先燒錄固件。"
                ),
            },
            status=502,
        )

    session.transport = transport
    session.executor = executor
    session.device = device
    session.baudrate = baudrate
    session.info = await _collect_device_info(session)
    session.info["settings"] = settings.to_dict()

    await session.broadcast({"type": "connected", "device": device, "info": session.info})
    return web.json_response({"ok": True, "device": device, "info": session.info})


async def handle_disconnect(request: web.Request) -> web.Response:
    session = _session(request)
    if session.executor is not None:
        try:
            await session.executor.exit()
        except Exception:  # noqa: BLE001 - 中斷連線不該因為收尾失敗而失敗
            log.debug("離開 raw REPL 時發生錯誤", exc_info=True)
    if session.transport is not None:
        await session.transport.close()
    session.transport = None
    session.executor = None
    session.info = {}
    session.device = ""
    await session.broadcast({"type": "disconnected"})
    return web.json_response({"ok": True})


async def handle_exec(request: web.Request) -> web.Response:
    session = _session(request)
    if session.executor is None:
        return web.json_response({"error": "尚未連線裝置", "kind": "no-device"}, status=409)
    if session.busy:
        return web.json_response({"error": f"裝置忙碌中：{session.busy}"}, status=409)

    body = await request.json()
    code = str(body.get("code") or "")
    timeout = float(body.get("timeout") or 10.0)
    try:
        result = await session.executor.exec(code, timeout=timeout)
    except MpyTimeoutError as exc:
        return web.json_response(
            {"error": str(exc), "kind": "timeout", "resync": True}, status=504
        )
    except SerialTransportError as exc:
        return web.json_response({"error": str(exc), "kind": "transport"}, status=502)
    return web.json_response(result.to_dict())


async def handle_device(request: web.Request) -> web.Response:
    return web.json_response(_session(request).status())


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    session = _session(request)
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    session.clients.add(ws)
    await ws.send_str(json.dumps({"type": "hello", "device": session.status()}, ensure_ascii=False))
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(message.data)
            except json.JSONDecodeError:
                continue
            await _handle_ws_message(session, payload)
    finally:
        session.clients.discard(ws)
    return ws


async def _handle_ws_message(session: DeviceSession, payload: dict[str, Any]) -> None:
    """WebSocket 指令。目前只做即時控制（中斷 / 送原始位元組）。"""
    kind = payload.get("type")
    if kind == "interrupt" and session.executor is not None:
        try:
            await session.executor.interrupt()
            await session.broadcast({"type": "interrupted"})
        except Exception as exc:  # noqa: BLE001
            await session.broadcast({"type": "error", "message": str(exc)})
    elif kind == "write" and session.transport is not None:
        data = payload.get("data") or ""
        if isinstance(data, str):
            await session.transport.write(data.encode("utf-8"))


# ── 靜態檔 ──────────────────────────────────────────────────────────────


async def handle_index(request: web.Request) -> web.Response:
    """送出 UI，並注入 bridge script。

    注入而不是改動 ``index.html`` 是刻意的：那份 HTML 是**已定案的設計稿**，
    我們不想讓它和後端實作糾纏在一起。bridge 只負責把假資料換成真的，
    拿掉 bridge 之後 UI 仍然是一個可以獨立開啟的設計原型。
    """
    index = WEB_DIR / "index.html"
    if not index.is_file():
        return web.Response(
            status=500,
            text=(
                f"找不到 UI：{index}\n"
                "請確認 mptools/web/index.html 存在。"
            ),
            content_type="text/plain",
        )
    html = index.read_text(encoding="utf-8")
    tag = '<script src="/static/bridge.js" defer></script>'
    if tag not in html:
        if "</body>" in html:
            html = html.replace("</body>", f"  {tag}\n</body>", 1)
        else:
            html += tag
    return web.Response(text=html, content_type="text/html", charset="utf-8")


def create_app() -> web.Application:
    app = web.Application()
    app["session"] = DeviceSession()

    app.router.add_get("/", handle_index)
    app.router.add_get("/api/health", handle_health)
    app.router.add_get("/api/ports", handle_ports)
    app.router.add_post("/api/connect", handle_connect)
    app.router.add_post("/api/disconnect", handle_disconnect)
    app.router.add_post("/api/exec", handle_exec)
    app.router.add_get("/api/device", handle_device)
    app.router.add_get("/ws", handle_ws)
    if WEB_DIR.is_dir():
        app.router.add_static("/static/", WEB_DIR, show_index=False)
    return app


async def serve(
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    open_browser: bool = True,
) -> None:
    """啟動服務。預設只綁 127.0.0.1 —— 這是本機工具，不要曝露到區網。"""
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()

    url = f"http://{host}:{port}/"
    print(f"mp_Tools 啟動器 · v{__version__}")
    print(f"  UI      {url}")
    print(f"  序列埠   {url}api/ports")
    if not WEB_DIR.is_dir():
        print(f"  ⚠ 找不到 web/ 目錄（預期在 {WEB_DIR}）")
    print("  按 Ctrl-C 結束")

    if open_browser:
        await asyncio.to_thread(webbrowser.open, url)

    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    finally:
        session: DeviceSession = app["session"]
        if session.transport is not None:
            await session.transport.close()
        await runner.cleanup()
