# mp_Tools 綜合工具 — 實作計畫

> ⚠️ **這份是原本的規劃（TypeScript + Tauri 路線），目前尚未照著執行。**
>
> **現在的事實來源是 [`docs/PYTHON-ARCHITECTURE.md`](PYTHON-ARCHITECTURE.md)** ——
> 啟動器改用 Python（`pyserial` / `esptool` / `aiohttp`），UI 沿用已定案的設計，
> 序列埠與 raw REPL 協定已經在真機與假裝置上驗證過。
>
> 這份計畫保留的原因：裡面的**設計決策**（D1–D5）、**風險登記簿**、
> 以及 **UI/燒錄相關的 Task** 仍然有效，日後若要做成純 Web 版（Tauri 外殼、
> 或 esptool-js）可以直接拿來用。但要動工前請先讀 PYTHON-ARCHITECTURE.md。
>
> 特別注意：本文件 Task 5 對 raw REPL 的描述有**三處是錯的**（`OK` 的框架位置、
> 每行的應答時機、逾時的語意），已在 PYTHON-ARCHITECTURE.md 第 4 節更正。

> **給實作的人：** 這份計畫按 Task 逐一執行，每個 Task 都是「先寫測試 → 看它失敗 → 寫最小實作 → 看它通過 → commit」。
> 步驟用 `- [ ]` 追蹤。**不要跳過「看它失敗」那一步**，那是唯一能證明測試真的在測东西的時刻。

**Goal:** 做一個跨平臺（Web + Windows/macOS/Linux 桌面）的 MicroPython / CircuitPython 開發者工作臺：一個入口搞定「燒錄固件 → 開 IDE 寫程式 → REPL 互動 → 檔案同步 → 裝套件 → 看序列埠」。

**Architecture:** 純前端 + 可插拔序列埠抽象層。核心邏輯（燒錄、REPL、檔案傳輸、板子目錄）全部寫成和平臺無關的 TypeScript 套件，只依賴一個 5 方法的 `SerialTransport` 介面；Web 版用 Web Serial API，桌面版（Tauri 2）換成 Rust 原生序列埠實作，其餘程式碼一行不改。所有裝置通訊都可用 `FakeSerialTransport` 在單元測試中重播真機對話。

**Tech Stack:** React 19 · TypeScript · Vite · Tailwind CSS v4 · Zustand · CodeMirror 6 · xterm.js 6 · esptool-js 0.7 · Tauri 2 · Vitest · Playwright

**Reference 專案與取用策略**

| 專案 | 授權 | 我們拿什麼 | 不拿什麼 |
|---|---|---|---|
| [esptool-js](https://github.com/espressif/esptool-js) | Apache-2.0 | 直接當 npm 依賴，做 ESP32 全系列燒錄 | — |
| [Adafruit_WebSerial_ESPTool](https://github.com/adafruit/Adafruit_WebSerial_ESPTool) | MIT | 它的 UX 決策：4 個 offset 槽、`flashSize: "keep"`、`no_reset` 穿透模式、921600 預設速率、`transport.waitForUnlock()` 收尾 | 它的程式碼（2024 起它自己也是包 esptool-js） |
| [ViperIDE](https://github.com/vshymanskyy/ViperIDE) | MIT | 功能範圍的參考線、MCP server 這個加分項、`mpy-cross-wasm`（P4 再評估） | — |

**關鍵事實（已查證，別再重新發明）**

- esptool-js 0.7 的 API：`new Transport(port, true)` → `new ESPLoader({transport, baudrate, terminal, debugLogging})` → `await esploader.main("default_reset")` 取得 chip 名稱 → `await esploader.writeFlash({fileArray:[{data, address}], flashSize:"keep", eraseAll, compress:true, reportProgress})` → `await esploader.after("hard_reset")`。收尾要 `await transport.disconnect(); await transport.waitForUnlock(1500);` 否則拔插後 port 會卡住。
- esptool-js **不做 ELF → bin**，也不含 espefuse/espsecure。我們只吃 `.bin`（MicroPython / CircuitPython 官方發佈的就是 bin + manifest）。
- Web Serial 只在 Chromium 系瀏覽器有（Chrome/Edge 89+）。**Tauri 2 在 Linux（WebKitGTK）與 macOS（WKWebView）沒有 Web Serial** —— 這是 P4 一定要做原生 transport 的原因，不是「之後有空再說」。
- MicroPython raw REPL 協議：`Ctrl-C` ×2（中斷正在跑的程式）→ `Ctrl-A` 進 raw REPL，回應以 `raw REPL; CTRL-B to exit\r\n>` 結尾；每次 `exec` 以 `Ctrl-D` 結束，回應格式是 `OK<stdout>\x04<stderr>\x04>`；資料要以 ≤160 bytes 為一塊送，每塊前綴 `\x01`、等裝置回 `>`。
- MicroPython paste mode：`Ctrl-E` 進（回應尾端 `=== `）→ 送程式碼 → 回應尾端 `=== \r\n` → `Ctrl-D` 執行。**Ctrl-D 送出去就會執行，沒有「等提示字元再確認」這回事。**
- 檔案傳輸的兩條路：(a) raw REPL 分塊 base64 寫入（萬用、二進位安全）；(b) CircuitPython 的 storage USB MSC（不用協議，但只涵蓋 CircuitPython）。P1 先做 (a)。
- USB VID:PID 過濾器：CP210x `0x10c4:0xea60`、CH34x `0x1a86:0x7523`、FTDI `0x0403:0x6001`、ESP32-S3 原生 USB `0x303a:0x1001`、RP2040 `0x2e8a:0x0005`。
- 本機環境：Node v24.14.1、npm 11.11.0、pnpm 11.27.0、Python 3.14.6、git 2.55。**Rust 工具鏈未安裝** —— P4 之前必須先裝（`rustup`），這件事排在 Task 12 第一步。

**已查證的套件版本（請在 P0 當天再 `npm view` 確認一次）**

`react@19.3.0` · `vite@8.3.2` · `tailwindcss@4.3.3` · `@codemirror/view@6.43.13` · `@codemirror/lang-python@6.2.1` · `@lezer/python@1.1.19` · `@xterm/xterm@6.0.0` · `@tauri-apps/cli@2.12.1` · `@tauri-apps/api@2.12.1` · `esptool-js@0.7.0` · `zustand@5.0.15` · `vitest@5.0.3` · `@playwright/test@1.63.0`

TypeScript：`latest` 現在是 7.0.2（原生編譯器世代）。**P0 先用 5.x/6.x 的穩定線**，等 P2 做完再評估升級 —— 別讓工具鏈風險擋住協議層。

---

## 檔案結構

先鎖定分解方式，後面每個 Task 都照這個走。

```
mp_Tools/
├─ apps/
│  ├─ web/                          # 主要 UI（瀏覽器 & Tauri 共用）
│  │  ├─ index.html
│  │  ├─ vite.config.ts
│  │  └─ src/
│  │     ├─ main.tsx
│  │     ├─ App.tsx
│  │     ├─ shell/                  # 版面骨架
│  │     │  ├─ Workbench.tsx        # 三欄 + 底欄的 grid 容器
│  │     │  ├─ ActivityRail.tsx     # 左側 64px 圖示列
│  │     │  ├─ BoardStrip.tsx       # 頂部「裝置台」：已連線板子一覽
│  │     │  ├─ Panel.tsx            # 可拖曳高度的底欄（REPL / Log）
│  │     │  └─ StatusBar.tsx
│  │     ├─ features/
│  │     │  ├─ device/              # 裝置面板、連線流程
│  │     │  ├─ explorer/            # 裝置檔案樹 / 本機專案樹
│  │     │  ├─ editor/              # CodeMirror 封裝 + 分頁
│  │     │  ├─ flasher/             # 燒錄精靈（wizard）
│  │     │  ├─ packages/            # mip 套件瀏覽器
│  │     │  └─ console/             # xterm REPL
│  │     ├─ store/                  # zustand slices
│  │     └─ styles/tokens.css       # 設計 token（見 UI-DESIGN.md）
│  └─ desktop/                      # Tauri 2 外殼
│     ├─ src-tauri/
│     │  ├─ Cargo.toml
│     │  ├─ tauri.conf.json
│     │  └─ src/
│     │     ├─ main.rs
│     │     └─ serial.rs            # 原生序列埠 transport（P4）
│     └─ package.json
├─ packages/
│  ├─ serial/                       # ★ 唯一的平臺差異點
│  │  └─ src/
│  │     ├─ transport.ts            # SerialTransport 介面 + 錯誤型別
│  │     ├─ web-serial.ts           # Web Serial 實作
│  │     ├─ tauri-serial.ts         # 原生實作（P4）
│  │     ├─ fake.ts                 # 測試用：可腳本化的假裝置
│  │     ├─ line-buffer.ts          # 讀取緩衝：readUntil / readLine
│  │     └─ esptool-bridge.ts       # 把 SerialTransport 接給 esptool-js
│  ├─ mpy/                          # ★ MicroPython / CircuitPython 協議
│  │  └─ src/
│  │     ├─ executor.ts             # raw REPL 狀態機 + exec
│  │     ├─ paste.ts                # paste mode 執行（給大段程式碼）
│  │     ├─ fs.ts                   # 檔案樹、讀、寫、刪、改名
│  │     ├─ device-info.ts          # 抓 chip / 版本 / 記憶體 / 檔案系統
│  │     ├─ webrepl.ts              # WebREPL over WebSocket（P3）
│  │     └─ repl-session.ts         # 互動式 REPL 串接（給 xterm 用）
│  ├─ flash/                        # esptool-js 包裝 + 燒錄狀態機
│  │  └─ src/
│  │     ├─ flasher.ts
│  │     └─ detect.ts               # 自動判斷是不是 ESP 晶片、進 bootloader
│  ├─ catalog/                      # 板子 / 固件 / 套件目錄
│  │  └─ src/
│  │     ├─ schema.ts               # Board / FirmwareRelease 型別
│  │     ├─ fetch-micropython.ts
│  │     ├─ fetch-circuitpython.ts
│  │     └─ boards.seed.json
│  └─ ui/                           # 共用無狀態元件
│     └─ src/{button,led,gauge,tabs,panel,dialog,toast,progress-map}/
├─ docs/PLAN.md  docs/UI-DESIGN.md
├─ prototype/index.html             # 可點擊的 UI 原型（本計畫的視覺基準）
├─ pnpm-workspace.yaml
└─ package.json
```

**邊界規則（違反就是設計錯了）**

1. `packages/mpy` 不准 import `packages/serial` 的具體實作，只准 import 它的型別。這樣才能在測試裡換掉 transport。
2. `packages/*` 不准 import React。UI 只在 `apps/web` 與 `packages/ui`。
3. 所有燒錄與檔案傳輸都經過 worker（Task 11 之前可先在主執行緒，但介面要先留成 async 佇列，避免 UI 卡住後才重構）。

---

## 分期與里程碑

| 階段 | 產出 | 里程碑驗收（能拿給別人看的東西） |
|---|---|---|
| **P0** 骨架與協議層 | Task 1–6 | `pnpm test` 綠燈；能在 Node 裡用假裝置跑完「進 raw REPL → 讀出檔案清單」 |
| **P1** 最小可用工作臺 | Task 7–11 | **插上 ESP32 開發板，從開網頁到看到 REPL 跑起來 ≤ 3 次點擊** |
| **P2** 燒錄與裝置管理 | Task 12–15 | 選板子 → 自動抓官方固件 → 燒錄 → 自動重置 → 自動進 REPL，全程不離開這個工具 |
| **P3** 套件、監控、WebREPL | Task 16–19 | 用 `mip` 裝套件；序列埠繪圖器；Wi-Fi 無線連線 |
| **P4** 桌面外殼與發佈 | Task 20–23 | 四平臺安裝檔；macOS/Linux 用原生序列埠 |

**P0 與 P1 是唯一的「必須連續做完」區段**，因為 P1 的驗收條件是整個專案的目的。P2 之後每個 Task 都可獨立交付。

---

## 關鍵設計決策（先講清楚，免得實作時反覆）

### D1. 為什麼要有 `SerialTransport` 抽象層

`navigator.serial` 只存在於 Chromium。Tauri 在 Windows 是 WebView2（有 Web Serial），在 macOS/Linux 是 WKWebView/WebKitGTK（**沒有**）。所以：

```ts
export interface SerialTransport {
  open(opts: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void>;
  flush?(): Promise<void>;   // 可選：Tauri 實作才有真的 flush
}
```

五個方法就夠。esptool-js 需要 `setSignals` 做 DTR/RTS 重置序列，所以它不能省。`read` 逾時回傳空陣列而不是丟錯 —— 這樣上層的解析器可以自己決定逾時語意（協議層需要「等到某個字串或逾時」而不是「固定讀 N bytes」）。

### D2. 誰擁有序列埠

**同一時間只能有一個 reader。** Web Serial 的 `port.readable` 被鎖住第二次會直接爆。所以規則：

- `DeviceManager`（zustand store）擁有 `SerialTransport` 實例。
- 燒錄時把 transport 借給 esptool-js（透過 `esptool-bridge.ts` 適配）；燒完 `release()` 拿回來，換 MicroPython 協議層用。
- 拔線事件（`navigator.serial` 的 `disconnect`）一律由 `DeviceManager` 處理，統一關閉並把狀態設為 `disconnected`，其他層不准自己監聽。

### D3. 讀取解析用緩衝器，不用「讀剛好 N bytes」

序列埠是位元組流，一定會遇到「一次 read 只回來半行」。所以 `line-buffer.ts` 提供：

- `readUntil(transport, delimiter: string, timeoutMs)` — 累積到出現分隔字串為止
- `readSome(transport, timeoutMs)` — 有什麼拿什麼（REPL 互動模式用）
- 內部保留 `residual`，跨次呼叫不丟資料

### D4. 錯誤訊息要能直接給使用者看

MicroPython 的錯誤格式是 `Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nNameError: name 'foo' isn't defined`。解析出 `file`、`line`、`type`、`message` 四個欄位，讓編輯器可以把錯誤標在對應行號。這是這個工具相對 `screen`/`picocom` 的關鍵差異，不要只把原始字串倒進終端。

### D5. 狀態管理切法（zustand slices）

`deviceSlice`（連線、晶片資訊、busy）· `explorerSlice`（裝置樹、本機專案樹、選取）· `editorSlice`（開啟的分頁、dirty 標記）· `flasherSlice`（精靈步驟、每個檔案的進度、log）· `consoleSlice`（REPL 歷史、連線狀態）· `packagesSlice`。

**busy 是全域互斥鎖**：燒錄、檔案寫入、REPL 執行三者不能並行。用一個 `busy: {owner: string, label: string} | null`，UI 據此禁用按鈕並顯示原因。這比每個地方各自 `isLoading` 誠實得多。

---

## P0 — 骨架與協議層

### Task 1: Monorepo 骨架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`（追加）
- Create: `packages/serial/package.json`, `packages/serial/tsconfig.json`
- Create: `packages/mpy/package.json`, `packages/mpy/tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: 建立 workspace 設定**

`pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

根目錄 `package.json`：

```json
{
  "name": "mp-tools",
  "private": true,
  "packageManager": "pnpm@11.27.0",
  "scripts": {
    "dev": "pnpm --filter @mp/web dev",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint ."
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vite": "^8.3.2",
    "vitest": "^5.0.3",
    "@types/node": "^24.0.0"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["apps/web/**", "jsdom"]],
  },
});
```

- [ ] **Step 2: 建立 `packages/serial`**

`packages/serial/package.json`：

```json
{
  "name": "@mp/serial",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/serial/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: 裝依賴並確認工具鏈活著**

Run: `pnpm install`
Expected: 成功，產生 `pnpm-lock.yaml`。

- [ ] **Step 4: 加上 web-serial 的型別**

Run: `pnpm add -D @types/w3c-web-serial -w`
Expected: `SerialPort` / `SerialOptions` 型別可用（Chromium 尚未把 Web Serial 放進標準 `lib.dom.d.ts`）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: monorepo skeleton with serial + mpy packages"
```

---

### Task 2: `SerialTransport` 介面與假裝置

**Files:**
- Create: `packages/serial/src/transport.ts`
- Create: `packages/serial/src/fake.ts`
- Create: `packages/serial/src/index.ts`
- Test: `packages/serial/src/fake.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`packages/serial/src/fake.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { FakeSerialTransport } from "./fake.js";

describe("FakeSerialTransport", () => {
  it("replays a canned response in chunks", async () => {
    const t = new FakeSerialTransport({
      respondTo: [{ when: "ping", reply: "pong", chunkSize: 2 }],
    });
    await t.open({ baudRate: 115200 });
    await t.write(new TextEncoder().encode("ping"));

    const first = await t.read(2, 100);
    expect(new TextDecoder().decode(first)).toBe("po");
    const second = await t.read(2, 100);
    expect(new TextDecoder().decode(second)).toBe("ng");
  });

  it("returns an empty array on read timeout instead of throwing", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    await t.open({ baudRate: 115200 });
    const got = await t.read(16, 20);
    expect(got.length).toBe(0);
  });

  it("records whatever was written so tests can assert the protocol", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    await t.open({ baudRate: 115200 });
    await t.write(new Uint8Array([0x03]));
    await t.write(new Uint8Array([0x01]));
    expect(t.writtenBytes()).toEqual([0x03, 0x01]);
    expect(t.writtenText()).toBe("\x03\x01");
  });

  it("rejects write before open", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow(/not open/i);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run packages/serial/src/fake.test.ts`
Expected: FAIL — `Failed to resolve import "./fake.js"`。

- [ ] **Step 3: 寫實作**

`packages/serial/src/transport.ts`：

```ts
export interface SerialTransport {
  open(opts: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** Resolves with up to maxBytes; resolves with an empty array on timeout. */
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void>;
  flush?(): Promise<void>;
}

export class TransportNotOpenError extends Error {
  constructor(op: string) {
    super(`Serial transport is not open (attempted ${op})`);
    this.name = "TransportNotOpenError";
  }
}

export class TransportBusyError extends Error {
  constructor() {
    super("Serial port is already locked by another reader");
    this.name = "TransportBusyError";
  }
}

export interface PortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}
```

`packages/serial/src/fake.ts`：

```ts
import { TransportNotOpenError, type SerialTransport } from "./transport.js";

export interface CannedResponse {
  /** Reply is queued once the written text contains this substring. */
  when: string;
  reply: string;
  /** Split the reply into reads of at most this many bytes (default: all at once). */
  chunkSize?: number;
  /** Delay before the reply becomes readable, in ms. */
  delayMs?: number;
}

export interface FakeOptions {
  respondTo: CannedResponse[];
}

/**
 * Deterministic stand-in for a real board. Replays canned replies when the
 * written stream matches a trigger, so protocol code can be tested byte-exactly
 * without hardware.
 */
export class FakeSerialTransport implements SerialTransport {
  private readonly opts: FakeOptions;
  private isOpen = false;
  private inbox: Uint8Array[] = [];
  private writeLog: number[] = [];
  private pendingText = "";
  private signals = { dtr: false, rts: false };

  constructor(opts: FakeOptions) {
    this.opts = opts;
  }

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    this.isOpen = false;
    this.inbox = [];
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new TransportNotOpenError("write");
    this.writeLog.push(...data);
    this.pendingText += new TextDecoder().decode(data);
    this.matchTriggers();
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (!this.isOpen) throw new TransportNotOpenError("read");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const head = this.inbox[0];
      if (head && head.length > 0) {
        const take = head.subarray(0, maxBytes);
        this.inbox[0] = head.subarray(take.length);
        if (this.inbox[0]!.length === 0) this.inbox.shift();
        return new Uint8Array(take);
      }
      if (Date.now() >= deadline) return new Uint8Array(0);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (!this.isOpen) throw new TransportNotOpenError("setSignals");
    if (signals.dtr !== undefined) this.signals.dtr = signals.dtr;
    if (signals.rts !== undefined) this.signals.rts = signals.rts;
  }

  async flush(): Promise<void> {}

  // ---- test helpers -------------------------------------------------------

  writtenBytes(): number[] {
    return [...this.writeLog];
  }

  writtenText(): string {
    return new TextDecoder().decode(new Uint8Array(this.writeLog));
  }

  signalState(): { dtr: boolean; rts: boolean } {
    return { ...this.signals };
  }

  /** Push bytes as if the device sent them spontaneously (e.g. a traceback). */
  emit(text: string): void {
    this.inbox.push(new TextEncoder().encode(text));
  }

  /** Make a trigger fire again (triggers fire once by default). */
  private usedTriggers = new Set<number>();

  private matchTriggers(): void {
    this.opts.respondTo.forEach((trigger, index) => {
      if (this.usedTriggers.has(index)) return;
      if (!this.pendingText.includes(trigger.when)) return;
      this.usedTriggers.add(index);
      const bytes = new TextEncoder().encode(trigger.reply);
      const size = trigger.chunkSize ?? bytes.length;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) {
        chunks.push(bytes.subarray(i, i + size));
      }
      const push = () => this.inbox.push(...chunks);
      if (trigger.delayMs) setTimeout(push, trigger.delayMs);
      else push();
    });
  }
}
```

`packages/serial/src/index.ts`：

```ts
export * from "./transport.js";
export * from "./fake.js";
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run packages/serial/src/fake.test.ts`
Expected: PASS，4 個測試。

- [ ] **Step 5: Commit**

```bash
git add packages/serial
git commit -m "feat(serial): transport interface and scriptable fake device"
```

---

### Task 3: `WebSerialTransport`

**Files:**
- Create: `packages/serial/src/web-serial.ts`
- Test: `packages/serial/src/web-serial.test.ts`

- [ ] **Step 1: 寫失敗的測試**

用一個假的 `SerialPort` 物件（不需要真瀏覽器），驗證三件事：開埠時送對的 baudRate、`read` 逾時回空陣列、`close` 會釋放 reader（否則下次 `open` 會爆 `port is locked`）。

```ts
import { describe, it, expect, vi } from "vitest";
import { WebSerialTransport } from "./web-serial.js";

function makeFakePort() {
  const released: string[] = [];
  const reader = {
    read: vi.fn(async () => ({ value: new Uint8Array([0x41]), done: false })),
    releaseLock: () => released.push("reader"),
    cancel: vi.fn(async () => {}),
  };
  const writer = {
    write: vi.fn(async () => {}),
    releaseLock: () => released.push("writer"),
    close: vi.fn(async () => {}),
  };
  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
    setSignals: vi.fn(async () => {}),
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
  };
  return { port, reader, writer, released };
}

describe("WebSerialTransport", () => {
  it("opens with the requested baud rate", async () => {
    const { port } = makeFakePort();
    const t = new WebSerialTransport(port as unknown as SerialPort);
    await t.open({ baudRate: 921600 });
    expect(port.open).toHaveBeenCalledWith({ baudRate: 921600, bufferSize: 4096 });
  });

  it("reads available bytes", async () => {
    const { port } = makeFakePort();
    const t = new WebSerialTransport(port as unknown as SerialPort);
    await t.open({ baudRate: 115200 });
    const got = await t.read(8, 50);
    expect([...got]).toEqual([0x41]);
  });

  it("releases reader and writer locks on close", async () => {
    const { port, released } = makeFakePort();
    const t = new WebSerialTransport(port as unknown as SerialPort);
    await t.open({ baudRate: 115200 });
    await t.write(new Uint8Array([1]));
    await t.close();
    expect(released).toContain("reader");
    expect(released).toContain("writer");
    expect(port.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run packages/serial/src/web-serial.test.ts`
Expected: FAIL — 找不到 `./web-serial.js`。

- [ ] **Step 3: 寫實作**

```ts
import { TransportNotOpenError, type SerialTransport } from "./transport.js";

const DEFAULT_BUFFER_SIZE = 4096;

/**
 * Web Serial implementation. Only one reader may hold the port, so this class
 * keeps a single long-lived reader and lazily creates the writer.
 */
export class WebSerialTransport implements SerialTransport {
  private port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private isOpen = false;

  constructor(port: SerialPort) {
    this.port = port;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  static async requestPort(filters?: SerialPortFilter[]): Promise<SerialPort> {
    if (!WebSerialTransport.isSupported()) {
      throw new Error(
        "此瀏覽器不支援 Web Serial。請用 Chrome 或 Edge 89+，或改用桌面版。",
      );
    }
    return filters?.length
      ? navigator.serial.requestPort({ filters })
      : navigator.serial.requestPort();
  }

  async open(opts: { baudRate: number; bufferSize?: number }): Promise<void> {
    if (this.isOpen) return;
    await this.port.open({
      baudRate: opts.baudRate,
      bufferSize: opts.bufferSize ?? DEFAULT_BUFFER_SIZE,
    });
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      await this.reader?.cancel().catch(() => undefined);
      this.reader?.releaseLock();
    } finally {
      this.reader = null;
    }
    try {
      await this.writer?.close().catch(() => undefined);
      this.writer?.releaseLock();
    } finally {
      this.writer = null;
    }
    await this.port.close().catch(() => undefined);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new TransportNotOpenError("write");
    this.writer ??= this.port.writable!.getWriter();
    await this.writer.write(data);
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (!this.isOpen) throw new TransportNotOpenError("read");
    this.reader ??= this.port.readable!.getReader();

    // Race the pending read against a timer. The read is left pending on
    // timeout (cancelling it would kill the stream), so the next call
    // reuses the same in-flight promise.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const result = await Promise.race([this.reader.read(), timeout]);
      if (result === null || result.done || !result.value) return new Uint8Array(0);
      return result.value.length > maxBytes
        ? result.value.subarray(0, maxBytes)
        : result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (!this.isOpen) throw new TransportNotOpenError("setSignals");
    await this.port.setSignals(signals);
  }
}
```

> ⚠️ **已知取捨：** 上面 `Promise.race` 逾時後，被留下的那個 `reader.read()` 會在下次呼叫時被重用 —— 這是刻意的，因為取消它會讓整個 stream 失效。代價是「逾時後又收到資料」會被下一次 `read` 撿到。協議層的 `readUntil` 必須容忍這種遲到的資料（它本來就會，因為它比對的是累積緩衝）。在 `web-serial.ts` 留下這段註解。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run packages/serial/src/web-serial.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/serial
git commit -m "feat(serial): Web Serial transport"
```

---

### Task 4: 讀取緩衝器 `readUntil`

這是整個協議層最容易寫錯的地方（半行、遲到資料、prompt 被吃掉）。測試要覆蓋到位。

**Files:**
- Create: `packages/serial/src/line-buffer.ts`
- Test: `packages/serial/src/line-buffer.test.ts`

- [ ] **Step 1: 寫失敗的測試**

```ts
import { describe, it, expect } from "vitest";
import { readUntil, readSome } from "./line-buffer.js";
import { FakeSerialTransport } from "./fake.js";

describe("readUntil", () => {
  it("accumulates across reads until the delimiter appears", async () => {
    const t = new FakeSerialTransport({
      respondTo: [{ when: "go", reply: "hello\r\nworld\r\n>", chunkSize: 3 }],
    });
    await t.open({ baudRate: 115200 });
    await t.write(new TextEncoder().encode("go"));
    const out = await readUntil(t, ">", 500);
    expect(out).toBe("hello\r\nworld\r\n>");
  });

  it("does not lose data past the delimiter (residual is kept)", async () => {
    const t = new FakeSerialTransport({
      respondTo: [{ when: "go", reply: "abc>LEFT" }],
    });
    await t.open({ baudRate: 115200 });
    await t.write(new TextEncoder().encode("go"));
    expect(await readUntil(t, ">", 500)).toBe("abc>");
    expect(await readSome(t, 50)).toBe("LEFT");
  });

  it("throws a labelled timeout error", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    await t.open({ baudRate: 115200 });
    await expect(readUntil(t, ">", 30)).rejects.toThrow(/timed out waiting for ">"/i);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run packages/serial/src/line-buffer.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
import type { SerialTransport } from "./transport.js";

export class ReadTimeoutError extends Error {
  constructor(
    public readonly expected: string,
    public readonly received: string,
    timeoutMs: number,
  ) {
    super(`Timed out waiting for ${JSON.stringify(expected)} after ${timeoutMs}ms; got ${JSON.stringify(received.slice(-200))}`);
    this.name = "ReadTimeoutError";
  }
}

/** Per-transport leftover bytes, so a delimiter split across reads is not lost. */
const residual = new WeakMap<SerialTransport, string>();

function take(transport: SerialTransport): string {
  const pending = residual.get(transport) ?? "";
  residual.set(transport, "");
  return pending;
}

function put(transport: SerialTransport, text: string): void {
  residual.set(transport, text);
}

export function clearResidual(transport: SerialTransport): void {
  residual.delete(transport);
}

const decoder = new TextDecoder();

/** Everything currently buffered, or an empty string if nothing arrives in time. */
export async function readSome(
  transport: SerialTransport,
  timeoutMs: number,
): Promise<string> {
  const chunk = await transport.read(4096, timeoutMs);
  const text = take(transport) + decoder.decode(chunk);
  // Nothing more is readable right now: hand it all back, keep no residual.
  return text;
}

/**
 * Reads until `delimiter` shows up in the accumulated stream. Text after the
 * delimiter is stashed as residual for the next call.
 */
export async function readUntil(
  transport: SerialTransport,
  delimiter: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let acc = take(transport);
  for (;;) {
    const found = acc.indexOf(delimiter);
    if (found !== -1) {
      const end = found + delimiter.length;
      put(transport, acc.slice(end));
      return acc.slice(0, end);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ReadTimeoutError(delimiter, acc, timeoutMs);
    const chunk = await transport.read(4096, Math.min(remaining, 200));
    acc += decoder.decode(chunk);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run packages/serial/src/line-buffer.test.ts`
Expected: PASS，3 個測試。

- [ ] **Step 5: Commit**

```bash
git add packages/serial
git commit -m "feat(serial): buffered readUntil with residual carry-over"
```

---

### Task 5: MicroPython raw REPL 執行器

**Files:**
- Create: `packages/mpy/src/executor.ts`
- Create: `packages/mpy/src/errors.ts`
- Create: `packages/mpy/src/index.ts`
- Test: `packages/mpy/src/executor.test.ts`

- [ ] **Step 1: 寫失敗的測試**

這是整個 P0 的核心測試。它同時驗證「送出的位元組序列正確」與「回應解析正確」。

```ts
import { describe, it, expect } from "vitest";
import { FakeSerialTransport } from "@mp/serial";
import { MpyExecutor } from "./executor.js";

const BANNER = "raw REPL; CTRL-B to exit\r\n>";

describe("MpyExecutor", () => {
  it("sends Ctrl-C twice then Ctrl-A and waits for the raw REPL banner", async () => {
    const t = new FakeSerialTransport({
      respondTo: [{ when: "\x01", reply: BANNER }],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    expect(t.writtenText().startsWith("\x03\x03\x01")).toBe(true);
  });

  it("wraps the program in Ctrl-D framing and returns stdout", async () => {
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        { when: "print(1)\x04", reply: "OK1\r\n\x04\x04>" },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    const { stdout } = await ex.exec("print(1)");
    expect(stdout).toBe("1\r\n");
    expect(t.writtenText()).toContain("print(1)\x04");
  });

  it("parses a traceback into file / line / type / message", async () => {
    const traceback =
      "Traceback (most recent call last):\r\n" +
      '  File "<stdin>", line 1, in <module>\r\n' +
      "NameError: name 'foo' isn't defined\r\n";
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        { when: "foo()\x04", reply: `OK\x04${traceback}\x04>` },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    const result = await ex.exec("foo()");
    expect(result.error?.type).toBe("NameError");
    expect(result.error?.line).toBe(1);
    expect(result.error?.file).toBe("<stdin>");
    expect(result.error?.message).toContain("isn't defined");
  });

  it("chunks payloads so no single write exceeds 160 bytes", async () => {
    const big = `print("${"x".repeat(400)}")`;
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        { when: "\x04", reply: "OK\x04\x04>" },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t, { chunkSize: 160 });
    await ex.enter();
    await ex.exec(big);
    expect(t.maxWriteSize()).toBeLessThanOrEqual(160);
  });
});
```

> `maxWriteSize()` 是 `FakeSerialTransport` 需要補上的 helper：記錄每次 `write()` 的最大長度。加在 `fake.ts` 裡，回傳 `maxChunkLength`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run packages/mpy/src/executor.test.ts`
Expected: FAIL — 找不到 `./executor.js`。

- [ ] **Step 3: 補上 `FakeSerialTransport.maxWriteSize()`**

在 `packages/serial/src/fake.ts` 加入：

```ts
  private maxChunk = 0;
  // 在 write() 內： this.maxChunk = Math.max(this.maxChunk, data.length);
  maxWriteSize(): number {
    return this.maxChunk;
  }
```

- [ ] **Step 4: 寫 `errors.ts`**

```ts
export interface MpyError {
  file: string;
  line: number;
  type: string;
  message: string;
  raw: string;
}

const TRACEBACK_RE =
  /Traceback \(most recent call last\):[\s\S]*?File "([^"]+)", line (\d+)[\s\S]*?\r?\n([A-Za-z_][A-Za-z0-9_.]*): ([\s\S]*?)\r?\n?$/;

/** Turns MicroPython's stderr into structured fields the editor can use. */
export function parseTraceback(stderr: string): MpyError | null {
  if (!stderr.includes("Traceback (most recent call last)")) return null;
  const m = TRACEBACK_RE.exec(stderr.trimEnd() + "\n");
  if (!m) {
    return { file: "<unknown>", line: 0, type: "Error", message: stderr.trim(), raw: stderr };
  }
  return {
    file: m[1]!,
    line: Number(m[2]!),
    type: m[3]!,
    message: m[4]!.trim(),
    raw: stderr,
  };
}
```

- [ ] **Step 5: 寫 `executor.ts`**

```ts
import { readUntil, type SerialTransport } from "@mp/serial";
import { parseTraceback, type MpyError } from "./errors.js";

export const CTRL_A = "\x01";
export const CTRL_B = "\x02";
export const CTRL_C = "\x03";
export const CTRL_D = "\x04";
export const CTRL_E = "\x05";

/** MicroPython's raw REPL wants short lines; 160 leaves headroom under 256. */
const DEFAULT_CHUNK = 160;

export interface ExecResult {
  stdout: string;
  stderr: string;
  error: MpyError | null;
}

export interface ExecutorOptions {
  chunkSize?: number;
  /** How long a single exec may take (long-running loops need more). */
  execTimeoutMs?: number;
}

/**
 * Talks to MicroPython's raw REPL. Stateful: call enter() before exec(), and
 * exit() before handing the port to someone else (e.g. esptool).
 */
export class MpyExecutor {
  private transport: SerialTransport;
  private chunkSize: number;
  private execTimeoutMs: number;
  private inRawRepl = false;

  constructor(transport: SerialTransport, opts: ExecutorOptions = {}) {
    this.transport = transport;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    this.execTimeoutMs = opts.execTimeoutMs ?? 10_000;
  }

  async enter(): Promise<void> {
    // Ctrl-C twice interrupts a running program, Ctrl-A switches to raw REPL.
    await this.transport.write(new TextEncoder().encode(CTRL_C + CTRL_C));
    await new Promise((r) => setTimeout(r, 50));
    await this.transport.write(new TextEncoder().encode(CTRL_A));
    const banner = await readUntil(this.transport, ">", 2000);
    if (!banner.includes("raw REPL")) {
      throw new Error(`裝置沒有進入 raw REPL，收到：${JSON.stringify(banner.slice(-120))}`);
    }
    this.inRawRepl = true;
  }

  async exit(): Promise<void> {
    if (!this.inRawRepl) return;
    await this.transport.write(new TextEncoder().encode(CTRL_B));
    this.inRawRepl = false;
  }

  /** Interrupts whatever is currently running (Ctrl-C, without leaving raw REPL). */
  async interrupt(): Promise<void> {
    await this.transport.write(new TextEncoder().encode(CTRL_C));
  }

  async exec(program: string): Promise<ExecResult> {
    const bytes = new TextEncoder().encode(program);
    for (let i = 0; i < bytes.length; i += this.chunkSize) {
      await this.transport.write(bytes.subarray(i, i + this.chunkSize));
      // Every chunk is acknowledged with a bare ">" prompt.
      await readUntil(this.transport, ">", 5000);
    }
    await this.transport.write(new TextEncoder().encode(CTRL_D));

    const header = await readUntil(this.transport, ">", this.execTimeoutMs);
    // header looks like "OK" or "Traceback..."; the trailing ">" is the ack.
    if (!header.startsWith("OK")) {
      return {
        stdout: "",
        stderr: header,
        error: parseTraceback(header) ?? {
          file: "<unknown>",
          line: 0,
          type: "ProtocolError",
          message: header.trim(),
          raw: header,
        },
      };
    }
    const stdout = await readUntil(this.transport, CTRL_D, this.execTimeoutMs);
    const stderr = await readUntil(this.transport, CTRL_D, this.execTimeoutMs);
    // Consume the final ">" that closes the raw REPL response.
    await readUntil(this.transport, ">", 2000);
    const cleanStdout = stdout.slice(0, -1);
    const cleanStderr = stderr.slice(0, -1);
    return {
      stdout: cleanStdout,
      stderr: cleanStderr,
      error: parseTraceback(cleanStderr),
    };
  }

  /** Convenience: exec and throw when the device reported an error. */
  async execOrThrow(program: string): Promise<string> {
    const { stdout, error, stderr } = await this.exec(program);
    if (error) throw new MpyExecError(error, stderr);
    return stdout;
  }
}

export class MpyExecError extends Error {
  constructor(
    public readonly detail: MpyError,
    public readonly stderr: string,
  ) {
    super(`${detail.type}: ${detail.message} (line ${detail.line})`);
    this.name = "MpyExecError";
  }
}
```

`packages/mpy/src/index.ts`：

```ts
export * from "./executor.js";
export * from "./errors.js";
```

`packages/mpy/package.json` 要加依賴：

```json
"dependencies": { "@mp/serial": "workspace:*" }
```

- [ ] **Step 6: 跑測試確認通過**

Run: `pnpm --filter @mp/mpy add @mp/serial@workspace:* && pnpm vitest run packages/mpy/src/executor.test.ts`
Expected: PASS，4 個測試。

> **真機驗證（有板子時務必做一次）：** 有些 MicroPython 版本在 `Ctrl-D` 之後不會立刻送出 `OK`，而是先吐一個 `\r\n`。若測試在真機上卡住，把 `header.startsWith("OK")` 改成 `header.replace(/^\r?\n/, "").startsWith("OK")` 並在測試中補一個對應案例。**不要用 `sleep` 蓋過去。**

- [ ] **Step 7: Commit**

```bash
git add packages/serial/src/fake.ts packages/mpy
git commit -m "feat(mpy): raw REPL executor with structured traceback parsing"
```

---

### Task 6: 裝置檔案系統操作

**Files:**
- Create: `packages/mpy/src/fs.ts`
- Test: `packages/mpy/src/fs.test.ts`

- [ ] **Step 1: 寫失敗的測試**

```ts
import { describe, it, expect } from "vitest";
import { FakeSerialTransport } from "@mp/serial";
import { MpyExecutor } from "./executor.js";
import { listDir, readFileText, writeFile, removePath } from "./fs.js";

const BANNER = "raw REPL; CTRL-B to exit\r\n>";

function makeDevice(/* per-test canned replies */) { /* 見下方 helper */ }

describe("mpy fs", () => {
  it("parses os.ilistdir output into entries with size and dir flag", async () => {
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        {
          when: "\x04",
          reply: 'OK[["boot.py",0,1,142],["lib",1,2,0],["main.py",0,3,89]]\r\n\x04\x04>',
        },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    const entries = await listDir(ex, "/");
    expect(entries).toEqual([
      { name: "boot.py", isDir: false, size: 142 },
      { name: "lib", isDir: true, size: 0 },
      { name: "main.py", isDir: false, size: 89 },
    ]);
  });

  it("writes a file in one shot when it fits in a single chunk", async () => {
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        { when: "\x04", reply: "OK\x04\x04>" },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    await writeFile(ex, "/main.py", "print('hi')\n");
    const sent = t.writtenText();
    expect(sent).toContain("open('/main.py.tmp','wb')");
    expect(sent).toContain("os.rename");
    expect(sent).toContain("bWFpbi5weQ"); // base64 of "main.py" appears in the open() call
  });

  it("round-trips a small text file", async () => {
    const content = "print('hello')\n";
    const b64 = btoa(content);
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        { when: "\x04", reply: `OK${JSON.stringify(b64)}\x04\x04>` },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    await expect(readFileText(ex, "/main.py")).resolves.toBe(content);
  });

  it("reports the device error when a write fails", async () => {
    const t = new FakeSerialTransport({
      respondTo: [
        { when: "\x01", reply: BANNER },
        {
          when: "\x04",
          reply: 'OK\x04Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nOSError: [Errno 28] ENOSPC\r\n\x04>',
        },
      ],
    });
    await t.open({ baudRate: 115200 });
    const ex = new MpyExecutor(t);
    await ex.enter();
    await expect(writeFile(ex, "/big.bin", "x".repeat(10))).rejects.toThrow(/ENOSPC/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run packages/mpy/src/fs.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

```ts
import type { MpyExecutor } from "./executor.js";

export interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Base64 chunk written per exec() call. 1024 source bytes → ~1366 b64 chars. */
const WRITE_CHUNK_BYTES = 1024;

function b64Encode(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64Decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function listDir(ex: MpyExecutor, path = "/"): Promise<FsEntry[]> {
  const program =
    "import os,json\n" +
    `_e=[]\n` +
    `for _n,_t,_i in os.ilistdir(${JSON.stringify(path)}):\n` +
    `    _s=0\n` +
    `    if _t==0:\n` +
    `        try:\n` +
    `            _s=os.stat(${JSON.stringify(path.rstrip("/"))}/+_n)[6]\n` +
    `        except Exception:\n` +
    `            _s=0\n` +
    `    _e.append([_n,_t,_s])\n` +
    "print(json.dumps(_e))\n";
  const out = await ex.execOrThrow(program);
  const parsed = JSON.parse(out.trim()) as [string, number, number][];
  return parsed.map(([name, type, size]) => ({
    name,
    isDir: type === 1,
    size,
  }));
}

export async function readFileText(ex: MpyExecutor, path: string): Promise<string> {
  const program =
    "import binascii as _b\n" +
    `print(_b.b2a_base64(open(${JSON.stringify(path)},"rb").read()).decode().strip())\n`;
  const out = await ex.execOrThrow(program);
  return b64Decode(out.trim());
}

/**
 * Writes atomically: fill `<path>.tmp`, then rename over the target, so a
 * power loss mid-write cannot leave a half-written main.py behind.
 */
export async function writeFile(
  ex: MpyExecutor,
  path: string,
  content: string,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  const tmp = `${path}.tmp`;
  await ex.execOrThrow(
    `_f=open(${JSON.stringify(tmp)},"wb")\n`,
  );
  try {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES);
      let binary = "";
      for (const b of slice) binary += String.fromCharCode(b);
      const b64 = btoa(binary);
      await ex.execOrThrow(`_f.write(__import__("ubinascii").a2b_base64(${JSON.stringify(b64)}))\n`);
      onProgress?.(Math.min(offset + WRITE_CHUNK_BYTES, bytes.length), bytes.length);
    }
    await ex.execOrThrow(`_f.close()\nimport os\nos.rename(${JSON.stringify(tmp)},${JSON.stringify(path)})\n`);
  } catch (error) {
    await ex.exec(`try:\n    _f.close()\nexcept Exception:\n    pass\nimport os\nos.remove(${JSON.stringify(tmp)})\n`);
    throw error;
  }
}

export async function removePath(ex: MpyExecutor, path: string, isDir = false): Promise<void> {
  const program = isDir
    ? `import os\nfor _n,_t,_i in os.ilistdir(${JSON.stringify(path)}):\n    os.remove(${JSON.stringify(path.rstrip("/"))}/+_n)\nos.rmdir(${JSON.stringify(path)})\n`
    : `import os\nos.remove(${JSON.stringify(path)})\n`;
  await ex.execOrThrow(program);
}

export async function renamePath(ex: MpyExecutor, from: string, to: string): Promise<void> {
  await ex.execOrThrow(`import os\nos.rename(${JSON.stringify(from)},${JSON.stringify(to)})\n`);
}
```

> **注意 `listDir` 的 `os.stat` 呼叫：** 上面的字串內插 `+_n` 是為了避開在裝置端做 f-string（舊版 MicroPython 沒有）。實作時請直接寫 `os.stat(<dir> + "/" + _n)[6]`，並確認 `path` 結尾斜線不會變成 `//`。這個地方一定要有測試（就是上面第一個測試）。

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run packages/mpy/src/fs.test.ts`
Expected: PASS，4 個測試。

- [ ] **Step 5: Commit**

```bash
git add packages/mpy
git commit -m "feat(mpy): device filesystem ops with atomic writes"
```

**P0 完成檢查點：** `pnpm test` 全綠，`pnpm typecheck` 無錯。此時已經有一個「可以被測試驅動」的裝置通訊層，還沒有一行 UI。

---

## P1 — 最小可用工作臺

### Task 7: 應用骨架與版面

**Files:**
- Create: `apps/web/{package.json,index.html,vite.config.ts,tsconfig.json}`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `apps/web/src/shell/{Workbench,ActivityRail,BoardStrip,Panel,StatusBar}.tsx`
- Create: `apps/web/src/styles/tokens.css` ← **內容照 `docs/UI-DESIGN.md` 抄**

- [ ] **Step 1: 建立 Vite + React 專案**

Run:
```bash
pnpm create vite@latest apps/web --template react-ts
pnpm --filter @mp/web add zustand
pnpm --filter @mp/web add -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: 設定 Tailwind v4**

`apps/web/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // Tauri 需要固定埠並關掉自動開瀏覽器
  clearScreen: false,
});
```

`apps/web/src/styles/tokens.css` 開頭：

```css
@import "tailwindcss";
@import "./tokens.css";

@theme {
  --color-bench-950: #0b0c0e;
  --color-bench-900: #101216;
  --color-bench-850: #15181d;
  --color-bench-800: #1b1f26;
  --color-bench-700: #262b34;
  --color-bench-600: #39404d;
  --color-bench-400: #6b7486;
  --color-bench-200: #aeb6c4;
  --color-bench-100: #e4e8ef;

  --color-led: #2fe0a8;          /* 通電 / 活動中 */
  --color-led-dim: #14654c;
  --color-amber: #f0a53c;        /* 警告 / 燒錄中 */
  --color-danger: #ff5a5f;
  --color-solder: #58c4dc;       /* 連結 / 資訊 */

  --font-display: "Bricolage Grotesque", system-ui, sans-serif;
  --font-ui: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

- [ ] **Step 3: 手動驗證版面**

Run: `pnpm --filter @mp/web dev`，開 `http://localhost:5173`。
Expected: 看得到三欄骨架，左側 rail 有 5 個圖示，底部有狀態列，中央顯示「尚未連線裝置」。

- [ ] **Step 4: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): workbench shell and design tokens"
```

---

### Task 8: 裝置連線流程

**Files:**
- Create: `apps/web/src/store/deviceSlice.ts`
- Create: `apps/web/src/features/device/ConnectButton.tsx`, `DevicePanel.tsx`
- Test: `apps/web/src/store/deviceSlice.test.ts`

- [ ] **Step 1: 寫失敗的測試（用假的 transport 注入）**

```ts
import { describe, it, expect } from "vitest";
import { createDeviceSlice, type DeviceDeps } from "./deviceSlice";
import { FakeSerialTransport } from "@mp/serial";

function deps(transport: FakeSerialTransport): DeviceDeps {
  return {
    requestTransport: async () => transport,
    now: () => 0,
  };
}

describe("deviceSlice", () => {
  it("moves disconnected → connecting → connected", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    const s = createDeviceSlice(deps(t));
    expect(s.getState().status).toBe("disconnected");
    const p = s.getState().connect(115200);
    expect(s.getState().status).toBe("connecting");
    await p;
    expect(s.getState().status).toBe("connected");
  });

  it("captures the failure reason and returns to disconnected", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    const s = createDeviceSlice({
      requestTransport: async () => {
        throw new Error("使用者取消了選擇");
      },
    });
    await s.getState().connect(115200);
    expect(s.getState().status).toBe("disconnected");
    expect(s.getState().lastError).toMatch(/取消/);
  });

  it("refuses a second device while busy flashing", async () => {
    const t = new FakeSerialTransport({ respondTo: [] });
    const s = createDeviceSlice(deps(t));
    await s.getState().connect(115200);
    s.getState().setBusy({ owner: "flasher", label: "燒錄中" });
    await expect(s.getState().connect(115200)).rejects.toThrow(/忙線/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm vitest run apps/web/src/store/deviceSlice.test.ts`
Expected: FAIL。

- [ ] **Step 3: 寫實作**

`deviceSlice` 匯出 `createDeviceSlice(deps)`（回傳一個 vanilla zustand store，方便測試）以及給 React 用的 `useDeviceStore`。狀態機：

```
disconnected → connecting → connected → releasing → disconnected
                    ↓
                disconnected (lastError)
```

`deps.requestTransport` 在正式版是「`navigator.serial.requestPort({filters: KNOWN_VID_PID})` → `new WebSerialTransport(port)`」；在桌面版是「Tauri command」。**這是唯一需要分叉的地方。**

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm vitest run apps/web/src/store/deviceSlice.test.ts`
Expected: PASS。

- [ ] **Step 5: 手動驗證：插上一塊 ESP32-S3，按連線**

Expected: 瀏覽器彈出裝置選擇器（清單已過濾成常見序列埠晶片），選完後狀態列出現綠燈與晶片名稱。拔線時狀態自動回到「未連線」。

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): device connection state machine"
```

---

### Task 9: REPL 終端（xterm.js）

**Files:**
- Create: `apps/web/src/features/console/ReplTerminal.tsx`
- Create: `packages/mpy/src/repl-session.ts`
- Test: `packages/mpy/src/repl-session.test.ts`

- [ ] **Step 1: 寫失敗的測試**

驗證：進 paste mode 的位元組序列正確、鍵盤輸入原樣轉送、裝置輸出的位元組會被推給 callback。

```ts
it("sends Ctrl-E then the code then Ctrl-D when running a block", async () => {
  const t = new FakeSerialTransport({
    respondTo: [{ when: "\x05", reply: "paste mode; Ctrl-C to cancel, Ctrl-D to finish\r\n=== " }],
  });
  await t.open({ baudRate: 115200 });
  const s = new ReplSession(t);
  await s.runBlock("print('hi')\n");
  expect(t.writtenText()).toBe("\x05print('hi')\n\x04");
});
```

- [ ] **Step 2: 跑測試確認失敗 → 實作 → 通過**

`ReplSession` 的職責：把「使用者打字」與「裝置輸出」雙向接起來，並提供 `runBlock()`（Ctrl-E/Ctrl-D paste mode，供「執行選取範圍」用）與 `interrupt()`（Ctrl-C）。它**不解析**輸出，原樣丟給 xterm。

- [ ] **Step 3: 手動驗證**

Expected: 在終端機輸入 `print(1+1)` 會看到 `2`；按 `Ctrl-C` 會中斷無窮迴圈；`Ctrl-]` 保留給「離開 raw REPL」。

- [ ] **Step 4: Commit**

```bash
git add apps/web packages/mpy
git commit -m "feat: interactive REPL over xterm.js"
```

---

### Task 10: 裝置檔案總管

**Files:**
- Create: `apps/web/src/features/explorer/DeviceTree.tsx`, `LocalTree.tsx`, `TransferMenu.tsx`
- Create: `apps/web/src/store/explorerSlice.ts`
- Test: `apps/web/src/store/explorerSlice.test.ts`

- [ ] **Step 1: 寫失敗的測試**

驗證：重新整理會重讀樹；上傳一個檔案後樹會更新；busy 時禁止並行上傳。

- [ ] **Step 2–4: 實作並通過**

關鍵 UX 決策：
- 樹的節點右鍵選單：`執行`、`下載到本機`、`改名`、`刪除`、`設為開機執行`（寫 `main.py`）。
- 拖曳本機檔案到裝置樹 = 上傳（走 `fs.ts` 的 `writeFile`）。
- 上傳中該節點顯示一個 `amber` 的進度條，並且**整個傳輸期間 `busy` 鎖住燒錄與 REPL**。

- [ ] **Step 5: 手動驗證：用真板子上傳 `main.py` 並確認裝置重開機後會執行**

- [ ] **Step 6: Commit**

---

### Task 11: 把燒錄/傳輸移出主執行緒

**Files:**
- Create: `apps/web/src/workers/serial.worker.ts`
- Create: `apps/web/src/store/workerBridge.ts`

- [ ] **Step 1: 定義 worker 訊息契約並寫測試**

```ts
export type WorkerRequest =
  | { id: number; kind: "open"; baudRate: number }
  | { id: number; kind: "exec"; program: string }
  | { id: number; kind: "listDir"; path: string }
  | { id: number; kind: "writeFile"; path: string; content: string }
  | { id: number; kind: "flash"; files: { name: string; address: number; data: ArrayBuffer }[] };

export type WorkerEvent =
  | { id: number; kind: "progress"; scope: string; written: number; total: number }
  | { id: number; kind: "log"; line: string }
  | { id: number; kind: "done"; result?: unknown }
  | { id: number; kind: "error"; message: string };
```

- [ ] **Step 2–4: 實作、通過、手動驗證**

驗證方式：燒錄一塊 1.5MB 的固件時，UI 的進度條動畫不會掉格（`requestAnimationFrame` 的間隔維持 < 20ms）。

- [ ] **Step 5: Commit**

**P1 完成檢查點（這是專案的第一個真實驗收）：**
插著一塊燒好 MicroPython 的 ESP32 → 開網頁 → 按連線 → 選埠 → **看到 REPL**。全程三次點擊以內，不需要裝任何東西。

---

## P2 — 燒錄與裝置管理

### Task 12: 板子目錄（catalog）

**Files:**
- Create: `packages/catalog/src/{schema.ts,boards.seed.json}`
- Create: `packages/catalog/src/fetch-micropython.ts`, `fetch-circuitpython.ts`
- Test: `packages/catalog/src/fetch.test.ts`（用固定 JSON fixture，不打真網路）

- [ ] **Step 1: 定義 schema**

```ts
export type ChipFamily =
  | "esp8266" | "esp32" | "esp32s2" | "esp32s3" | "esp32c3"
  | "esp32c6" | "esp32h2" | "rp2040" | "rp2350" | "stm32" | "samd" | "nrf52";

export interface FirmwareVariant {
  name: string;             // "ESP32_GENERIC-SPIRAM"
  version: string;          // "1.24.1"
  url: string;              // 直接可下載的 .bin
  chipFamily: ChipFamily;
  /** 燒錄位址。ESP32 = 0x1000，ESP8266/C3/S3 原生 USB = 0x0 */
  address: number;
}

export interface Board {
  id: string;               // "esp32-devkitc-v4"
  label: string;            // "ESP32 DevKitC V4"
  chipFamily: ChipFamily;
  flashSize: "2MB" | "4MB" | "8MB" | "16MB";
  /** 對應的 USB 晶片，用於連線時的建議 */
  usbIds: { vid: number; pid: number }[];
  variants: FirmwareVariant[];
}
```

- [ ] **Step 2–4: 實作兩個 fetcher 並通過測試**

- **MicroPython**：抓 `https://micropython.org/download/<board>/` 的 HTML，解析出 `.bin` 連結與版本號（沒有官方 JSON API，用 regex 抓 `<a href=".../*.bin">`）。**快取 24 小時**在 `localStorage`。
- **CircuitPython**：抓 `https://raw.githubusercontent.com/adafruit/circuitpython/main/.github/workflows/*.yml` 太脆弱；改用 Adafruit 的 board 頁面 JSON（`https://www.adafruit.com/api/...`）也不穩。**最穩的路**是 Adafruit 的 S3 bucket 清單：`https://adafruit-circuit-python.s3.amazonaws.com/bin/<board>/en_US/` 有 `directory listing`，抓 `adafruit-circuitpython-<board>-<lang>-<version>.uf2`。

> ⚠️ **這裡一定會遇到「上游改了 HTML 就壞掉」**。所以：fetcher 必須有 fixture 測試 + 上線後在 UI 上顯示「上次同步時間」，並保底允許使用者手動輸入 URL 或選本機 `.bin`。**手動路徑永遠不能被拿掉。**

- [ ] **Step 5: Commit**

---

### Task 13: 燒錄狀態機

**Files:**
- Create: `packages/flash/src/flasher.ts`, `detect.ts`, `esptool-bridge.ts`
- Test: `packages/flash/src/flasher.test.ts`

- [ ] **Step 1: 寫失敗的測試**

```ts
it("runs erase → write → reset in order and reports progress", async () => {
  const calls: string[] = [];
  const fakeLoader = {
    main: async () => { calls.push("main"); return "ESP32-S3"; },
    eraseFlash: async () => { calls.push("erase"); },
    writeFlash: async (o: any) => { calls.push("write"); o.reportProgress(0, 1, 2); },
    after: async (m: string) => { calls.push(`after:${m}`); },
  };
  const events: string[] = [];
  await flash(fakeLoader as any, {
    files: [{ name: "fw.bin", address: 0x0, data: new Uint8Array(1024) }],
    eraseAll: true,
    onEvent: (e) => events.push(e.kind),
  });
  expect(calls).toEqual(["main", "erase", "write", "after:hard_reset"]);
  expect(events).toContain("progress");
});
```

- [ ] **Step 2–4: 實作並通過**

`flasher.ts` 的重點：
1. `flashSize: "keep"`（**不要**動使用者的 flash 大小設定，除非他在進階選項明確選了）。
2. `eraseAll` 預設 `false`；選了就顯示「這會清掉裝置上所有檔案」的確認。
3. 燒錄失敗時**不要重置**，讓裝置停在 bootloader，並在 UI 給出「重試」按鈕與原始錯誤。
4. 收尾一律 `transport.disconnect()` + `waitForUnlock(1500)`（借用 Adafruit 的做法）。

`detect.ts` 負責「按了連線但裝置不是 ESP」的判斷：先試 `esploader.main()`，若在 500ms 內失敗就改試 MicroPython raw REPL 的 `Ctrl-C Ctrl-A`；兩者都失敗則提示「請確認驅動（CP210x / CH34x）已安裝，或按住 BOOT 鍵再按 RESET」。

- [ ] **Step 5: 手動驗證：燒一塊 ESP32-C3 的 MicroPython，燒完能自動進 REPL**

- [ ] **Step 6: Commit**

---

### Task 14: 燒錄精靈 UI（含 flash map 視覺化）

**Files:**
- Create: `apps/web/src/features/flasher/{FlashWizard,BoardStep,SourceStep,OptionsStep,ProgressStep}.tsx`
- Create: `packages/ui/src/progress-map/FlashMap.tsx`

- [ ] **Step 1–4: 實作並用 Playwright 元件測試**

測試重點：步驟前進/後退不丟狀態、`eraseAll` 勾選會出現二次確認、燒錄中「取消」按鈕真的會 abort。

- [ ] **Step 5: 視覺驗收**

`ProgressStep` **不用傳統單一進度條**，改用 `FlashMap`：一條水平軸代表 flash 位址空間，每個要寫入的區段畫成一個帶標籤的方塊（`bootloader @0x0`、`partitions @0x8000`、`firmware @0x10000`），寫入時方塊由左而右填滿，右側顯示速率。

**實作前務必先讀 `docs/UI-DESIGN.md` 第 4 節** —— 那裡記錄了原型實測出來的坑：低址三段只佔 4 MB 的 0.66%，純按比例畫會讓標籤疊成一團（實測可用寬度只剩 18px）。正確做法是低址區給固定最小寬度、軸上用虛線標示不按比例的區間、並在地圖下方明寫這件事。驗收標準是：**把視窗縮到 768px 寬，三個位址標籤仍然不重疊、可讀。**

- [ ] **Step 6: Commit**

---

### Task 15: 固件來源整合

**Files:**
- Create: `apps/web/src/features/flasher/useFirmwareSources.ts`
- Modify: `apps/web/src/features/flasher/SourceStep.tsx`

三個來源，UI 上並列：**官方最新**（從 catalog 抓）、**官方指定版本**（下拉選版本）、**本機檔案**（拖曳 `.bin` / `.uf2`）。一律顯示檔案大小與 SHA256，並在燒錄完成後用 `readFlash` 回讀前 1KB 做一次 sanity check。

- [ ] **Step 1–5: 實作、測試、手動驗證、Commit**

**P2 完成檢查點：** 一塊全新的 ESP32 → 選板子 → 自動抓官方 MicroPython → 燒錄 → 自動重置 → 自動進 REPL → 打 `print('hello')`。**全程沒離開這個工具，也沒下載任何安裝檔。**

---

## P3 — 套件、監控、無線

### Task 16: mip 套件管理員
`packages/mpy/src/mip.ts` 包裝裝置端的 `mip` 模組（`mip.install("name")`），UI 提供搜尋（先查 `https://micropython.org/pi/v2/index.json` 的套件索引）與一鍵安裝/移除。

### Task 17: 序列埠繪圖器
`apps/web/src/features/monitor/` — 解析裝置吐出的 CSV / `key=value` 行，用 canvas 即時畫折線。**不引入繪圖庫**（Chart.js 之類的太肥），300 行 canvas 程式碼就夠。

### Task 18: WebREPL 無線連線
`packages/mpy/src/webrepl.ts` — WebSocket 版協議（同樣的 `Ctrl-A/Ctrl-D` 框架，只是走 ws）。UI 上「連線」按鈕變成一個下拉：`USB` / `Wi-Fi (WebREPL)`。

### Task 19: 記憶體與檔案系統儀表
裝置面板加入 `gc.mem_free()` / `os.statvfs('/')` 的即時讀數，用 `packages/ui/gauge` 呈現。**每秒最多輪詢一次**，因為 raw REPL 的每次 exec 都會打斷裝置。

---

## P4 — 桌面外殼與發佈

### Task 20: Tauri 2 外殼（Windows 先行）
- [ ] **Step 1: 安裝 Rust 工具鏈**（本機目前沒有）

```powershell
winget install --id Rustlang.Rustup
rustup default stable
cargo --version
```

- [ ] **Step 2: 建立 Tauri 專案並指向 Vite dev server**

Run: `pnpm --filter @mp/web add -D @tauri-apps/cli@^2.12.1 && pnpm --filter @mp/web exec tauri init`
`tauri.conf.json` 的 `build.devUrl` 指到 `http://localhost:5173`，前端一律用 `devUrl`，**不要**讓 Tauri 打包時另外跑一個 server。

- [ ] **Step 3: 驗證 Windows 上 Web Serial 可用**

插上板子，在 Tauri 視窗內按連線。
Expected: WebView2 有 `navigator.serial`，能開埠。
**若失敗**：Task 21 立刻升級為 P4 第一優先，不要繞路。

- [ ] **Step 4: Commit**

### Task 21: 原生序列埠 transport（macOS / Linux 必需）
- [ ] **Step 1–5:** `apps/desktop/src-tauri/src/serial.rs` 用 `serialport` crate 開埠，透過 `tauri::ipc::Channel` 把讀到的位元組推給前端；前端 `TauriSerialTransport` 實作同一組 5 方法介面。**`packages/*` 一行都不用改。**
- [ ] **Step 6:** 在 macOS 與 Linux 各做一次「連線 → REPL → 燒錄」的驗證；這兩個平臺的 Web Serial 不存在，所以這是唯一的路。

### Task 22: 打包與簽章
- [ ] Windows：`.msi`（WiX）。macOS：`.dmg`（**未簽章版本要寫清楚「右鍵 → 打開」的說明**）。Linux：`.AppImage` + `.deb`。
- [ ] CI：GitHub Actions matrix（`windows-latest`、`macos-latest`、`ubuntu-22.04`）。

### Task 23: Web 版發佈
- [ ] 部署到靜態 hosting，設定 `COOP/COEP` header（若日後要用 `mpy-cross-wasm` 的 SharedArrayBuffer 就需要）。
- [ ] PWA：`manifest.webmanifest` + service worker，讓它離線可用（這是 ViperIDE 最被稱讚的一點，值得抄）。

---

## 風險登記簿

| 風險 | 影響 | 對策 |
|---|---|---|
| Tauri 在 macOS/Linux 沒有 Web Serial | 桌面版在兩個平臺完全不能用 | Task 21 的原生 transport 是**必要**項目，不是加分項。架構上已經預留（`SerialTransport` 介面） |
| esptool-js 0.7 的 API 變動 | 燒錄壞掉 | `packages/flash` 是唯一的接觸點；版本鎖 `~0.7.0`；升級前先跑 `flash.test.ts` |
| 上游固件網站改版讓 catalog 抓不到 | 抓不到官方固件 | fixture 測試 + 永遠保留「手動選本機 .bin」路徑 + UI 顯示上次同步時間 |
| CircuitPython 與 MicroPython 的協議差異 | 同一套 `mpy` 套件在 CircuitPython 上行為不同 | `DeviceProfile` 抽象（`boot.py` vs `code.py`、storage 唯讀偵測）；P1 先只保證 MicroPython，CircuitPython 在 P2 補測試 |
| Web Serial 的單一 reader 限制 | 燒錄與 REPL 搶埠 → 整個 session 卡死 | `DeviceManager` 獨佔持有 + `busy` 全域互斥鎖 + 借出/歸還協定（D2） |
| 燒錄中途拔線 | 裝置變磚（ESP8266 尤其） | 燒錄中偵測 `disconnect` 事件 → 立刻停止寫入並顯示「請重新燒錄」；UI 上永遠顯示「燒錄中請勿拔線」 |
| 瀏覽器不支援 Web Serial（Safari/Firefox） | 使用者開不起來 | 偵測後顯示明確引導：改用 Chrome/Edge，或下載桌面版。**不要**只顯示「不支援」四個字 |

## 開放決策（實作到那個 Task 時再定，不擋前面）

1. **`mpy-cross-wasm` 要不要做**（ViperIDE 用它做 `.py` → `.mpy` 編譯與語法驗證）。價值中等，但它會讓 bundle 變大、還要處理 COOP/COEP。排在 P3 之後再評估。
2. **MCP server**（ViperIDE 有）。若要讓 AI 助理直接操作裝置，這是個差異化功能，但屬於 P4+。
3. **`readUntil` 逾時後遲到資料的處理**：目前靠 residual 吸收。若真機上出現「上一次的輸出被下一次讀到」的實際災情，就要改成每種操作前先 `clearResidual()`。
4. **`listDir` 的 `os.stat` 對每個檔案各問一次**：檔案多的目錄會慢。MicroPython 沒有 `os.stat` 的批次版本，替代方案是用 `os.ilistdir` 的第三個欄位（`inode`）——但那個欄位在不同 port 上的語意不一致（有些是大小，有些真的只是 inode）。**先在真機上實測再決定。**

## 自我檢查（寫完計畫後跑過一遍）

- **規格覆蓋**：燒錄 → Task 12–15；mpy IDE → Task 7–10；REPL → Task 9；檔案同步 → Task 6/10；套件 → Task 16；「跨平臺方便啟動」→ Task 20–23；「綜合工具」的入口感 → Task 7 的 BoardStrip + Task 8。✅
- **佔位符掃描**：P0/P1 每個 Step 都有可貼上的程式碼或可跑的指令。P2–P4 只到「任務 + 檔案 + 關鍵決策」層級，因為那裡的細節取決於 P0/P1 的真機實測結果 —— 這是刻意的，不是偷懶。
- **型別一致性**：`SerialTransport`（5 方法）在 Task 2/3/21 一致；`MpyExecutor.enter/exec/execOrThrow` 在 Task 5/6 一致；`FsEntry{name,isDir,size}` 在 Task 6/10 一致；`Busy{owner,label}` 在 Task 8/13 一致。✅
