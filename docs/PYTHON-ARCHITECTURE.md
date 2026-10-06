# Python 啟動器與後端架構

> 這份文件記錄的是**已經跑起來、已經在真機與假裝置上驗證過**的實作。
> `docs/PLAN.md` 是原本的規劃（TypeScript / Tauri 路線），保留作為日後 Web 化的參考。
> **目前的事實來源是這份文件與程式碼。**

---

## 1. 為什麼是 Python

原因是硬需求，不是偏好：

| 需求 | 純瀏覽器版 | Python 啟動器 |
|---|---|---|
| 列出所有序列埠與 VID:PID | ✗ 只能跳對話框讓使用者自己選 | ✓ `pyserial` 直接列 |
| 自動判斷插上了什麼晶片 | ✗ | ✓ |
| 告訴使用者「這個埠被誰佔用」 | ✗ | ✓（啟發式，見第 5 節） |
| Firefox / Safari 可用 | ✗ 沒有 Web Serial | ✓ |
| 燒錄 ESP32 全系列 | 只有 esptool-js 的子集 | ✓ 官方 `esptool`（**本來就是 Python**） |
| 讀取 ELF、espefuse、espsecure | ✗ esptool-js 明確不做 | ✓ 免費得到 |

而且本機已經有 `esptool 5.3.1` / `pyserial 3.5` / `aiohttp 3.14.3`，
**不需要新增任何依賴**。

## 2. 分層

```
瀏覽器（UI，零依賴、無 build step）
    │  HTTP + WebSocket
    ▼
mptools/web/server.py        aiohttp 服務、靜態檔、WebSocket 廣播
    │
    ├── mptools/web/bridge.js   注入到 UI 的橋接層（把假資料換成真的）
    │
    ▼
mptools/device/mpy.py        raw REPL 協定（進出、exec、paste、中斷）
mptools/flash/…              esptool 包裝（下一步）
    │
    ▼
mptools/transport/serial_io.py   非同步序列埠：pyserial + 專屬讀取執行緒
mptools/transport/ports.py       列舉、VID:PID 對應、佔用偵測
```

**規則：** `device/` 只相依 `transport/` 的介面，不知道 web 層存在。
所以 `device/mpy.py` 可以完全脫離 web server 被測試（`tests/` 就是這樣測的）。

## 3. 執行方式

```bash
python -m mptools              # 啟動 web 服務（預設動作），自動開瀏覽器
python -m mptools serve --port 8765 --no-browser
python -m mptools ports        # 列出序列埠，並指出被誰佔用
python -m mptools doctor       # 環境檢查
python -m mptools repl         # 終端機 REPL（不需要瀏覽器）
python -m mptools exec "print('hi')"
python -m mptools exec - < script.py
```

裝成命令列工具之後就是 `mpt ports`、`mpt repl`。

## 4. raw REPL 協定：實際驗證出來的樣子

**這一節是整份文件最重要的部分。** 開發時踩到的每一個 bug 都是「對協定的誤解」，
而且症狀全都指向錯誤的方向（看起來像裝置壞掉，其實是主機端讀錯）。

### 4.1 位元組序列

```
主機                                    裝置
────────────────────────────────────────────────────────────────
Ctrl-C Ctrl-C                    →      中斷正在跑的程式
                                        清掉輸入緩衝
Ctrl-A                           →      raw REPL; CTRL-B to exit\r\n>
<整支程式一次送出>               →      （沒有應答！）
Ctrl-D                           →      OK<stdout>\x04<stderr>\x04>
Ctrl-B                           →      回到 friendly REPL
```

### 4.2 三個一定要記住的細節

**① `OK` 不是獨立欄位，它黏在 stdout 前面。**

```
head   = b"OK" + stdout + b"\x04"
stderr = stderr + b"\x04"
tail   = b">"
```

成功時 `head` 以 `OK` 開頭；失敗時**整個 head 就是 traceback，而且不帶 `OK`**：

```
失敗：b"Traceback (most recent call last):\r\n...\r\nValueError: bad\r\n\x04\x04>"
```

**② 讀取順序必須照框架走，不能先讀 `>`。**

USB CDC 幾乎一定會把整包擠在同一次傳輸裡。如果先 `read_until(b">")`，
它會把 stdout 與 stderr 一起吃掉 —— 症狀是「連得上、進得了 raw REPL，
但 `exec` 永遠回傳空字串」。必須先依 `\x04` 分兩段讀，最後才讀 `>`。

**③ 同步點是 `\x04`（Ctrl-D），不是換行。**

不要在每個換行後等應答。整支程式可以一次送出去（`DEFAULT_CHUNK = 4096` 只是為了
避免灌爆裝置的輸入緩衝）。「256 bytes」是 MicroPython **編譯器**每行的限制，
不是 raw REPL 的協定限制。

### 4.3 `Ctrl-C` 會把你踢出 raw REPL

這是 OOM 等級的坑。`Ctrl-C` 之後裝置回到 **friendly REPL**，不是留在 raw REPL。
所以「中斷」的實作必須是：

```
Ctrl-C  →  等裝置回 friendly REPL 提示字元  →  flush  →  Ctrl-A  →  重新讀 banner
```

少了重新送 `Ctrl-A` 這一步，整個 session 就廢了。

### 4.4 逾時要當成錯誤，不是空結果

`exec` 逾時代表**裝置還在跑那支程式**，raw REPL 已經失去同步。後續的回應會混進
下一次讀取。所以逾時丟 `MpyTimeoutError`，呼叫端必須 `interrupt()` 或重新 `enter()`，
不能若無其事地送下一支程式。

### 4.5 分隔字元之後的資料必須保留

`read_until()` 內部維護跨次呼叫的殘餘緩衝（`SerialTransport._residual`）。
沒有它，上面第 ② 點的框架就無從實作。

## 5. 「被誰佔用」的偵測：是啟發式，不是保證

Windows 沒有公開 API 可以查「哪個 process 開著 COM27」（要 `NtQuerySystemInformation`
列舉核心 handle，或 Sysinternals `handle.exe`）。所以：

1. `probe_port()` 嘗試開啟該埠 → `PermissionError` 代表被佔用（這是**事實**）。
2. `suspect_processes()` 用 Toolhelp API（`ctypes`，**不開子程序**）列出執行中的程序，
   比對已知會獨佔序列埠的名單（**這是推測**）。

確定性的佔用者（Thonny、PuTTY、mpremote…）與不確定的（VS Code、Python、終端機）
分開排序。**文案上必須寫「可能」** —— 照著錯誤提示去關掉錯的程序比沒有提示更糟。

## 6. 測試策略

沒有硬體也要能端到端驗證。三個層次：

| 層次 | 工具 | 測什麼 |
|---|---|---|
| 協定位元組 | `ScriptedTransport`（`tests/test_mpy_protocol.py`） | 送出的位元組序列、框架解析、`OK` 前綴、錯誤路徑 |
| 端到端 | `tests/fake_device.py` + `socket://` | 真的 `SerialTransport` ←→ 假 MicroPython 裝置，含逾時與中斷復原 |
| 真機 | `mpt ports` / `mpt repl` | 驅動、baud rate、原生 USB vs 橋接晶片 |

跑法：

```bash
python -m pytest tests -q      # 9 個測試
python _probe_e2e.py           # 端到端（假裝置，不需要硬體）
```

**為什麼要測位元組：** 這次開發抓到的三個 bug，全都是「解析結果看起來對、
位元組卻錯」。只斷言回傳值的測試一個都抓不到。

## 7. 已知限制

- **同一個埠不能同時被兩個程式開著**（Windows 是獨佔的）。所以 `DeviceSession`
  是單例：整個服務同時只服務一個裝置。要支援多板子需要改成多 session + 埠擁有權表。
- `flash/`（esptool 包裝）還沒實作。UI 的燒錄精靈目前仍是原型的模擬。
- `web/index.html` 目前是 `prototype/index.html` 的複本，由 `bridge.js` 注入真實資料。
  兩邊共用同一份設計；改 UI 時要同步複製（或日後改成 build 時產生）。
- 裝置面板的即時讀數（記憶體／檔案系統）還沒接上輪詢。
