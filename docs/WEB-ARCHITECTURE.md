# 網頁版架構

> 這份文件記錄的是**已經在瀏覽器裡實測驗證過**的網頁版實作。
> `docs/PLAN.md` 是原始規劃（TypeScript + Tauri），`docs/PYTHON-ARCHITECTURE.md` 是選配的本機服務。

---

## 1. 已驗證的瀏覽器能力

用一支探測頁在 Chromium 裡實測的結果，不是查文件抄來的：

| 項目 | 結果 | 意義 |
|---|---|---|
| `navigator.serial` | ✓ 存在 | 可以走 Web Serial |
| `isSecureContext` | ✓ true | `http://localhost` 也算安全來源，開發不受阻 |
| `navigator.usb` | ✓ 存在 | WebUSB 後備路徑可用 |
| `esptool-js` ES module import | ✓ 成功 | bundle 可直接餵給 `<script type="module">` |
| 匯出的符號 | `ESPLoader` `Transport` `ROM` `ClassicReset` `HardReset` `UsbJtagSerialReset` `CustomReset` `ESPRESSIF_VID` `USB_JTAG_SERIAL_PID` | 需要的全都有 |
| `getPorts()` 已授權埠 | 0（全新 origin） | **第一次一定要使用者手勢** |

## 2. CORS：為什麼固件目錄必須是靜態的

實測 `HEAD https://micropython.org/resources/firmware/...bin`（帶 `Origin` 標頭）：

```
200 OK · 1742 KB · access-control-allow-origin = (none)
```

**沒有 CORS 標頭。** 所以瀏覽器不能直接抓官方固件 —— 而且失敗訊息長得像網路問題，
非常難診斷。任何「執行期去官網抓固件」的設計在純網頁版都會無聲地失敗。

因此取得固件有三條路，**三條都要有**：

1. **靜態目錄**（`web/js/catalog.js`）—— 已驗證存在的 URL，使用者按「下載」再拖進來
2. **本機檔案**（拖放 / 檔案選擇）—— 永遠可用的保底路線，也是離線時唯一的路
3. **自架代理端點** —— 本機服務可以代抓（它不受 CORS 限制），網頁再向它要

實測可用的 URL 格式（`RELEASE` 常數要跟著更新）：

```
https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin   （1742 KB）
https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.uf2   （3355 KB）
https://micropython.org/resources/firmware/ESP8266_GENERIC-20260824-v1.29.0.bin    （ 628 KB）
https://micropython.org/resources/firmware/RPI_PICO-20260824-v1.29.0.uf2           （ 665 KB）
```

## 3. Web Serial 的四個硬限制

這些都不是「之後可以優化」，是瀏覽器端的物理限制。UI 必須**在設計上接受它們**。

### 3.1 沒有埠清單，只有使用者手動選

`requestPort()` 一定要在使用者手勢中呼叫，而且一定會跳作業系統原生的對話框。
使用者看到的是「USB Serial Device (COM27)」—— 沒有 VID:PID、沒有晶片型號。

**這正是本機服務存在的理由。** 網頁版只能在 UI 上誠實說明這個限制。

### 3.2 埠被佔用時的錯誤訊息完全沒有幫助

| 實際情況 | 瀏覽器說的 |
|---|---|
| 埠被別的程序佔用 | `Failed to open serial port` |
| 沒有使用者手勢 | `SecurityError` |
| 使用者按取消 | `NotFoundError` |
| 拔線 | 讀取突然回 `undefined`，不丟錯 |

`web/js/serial.js` 的 `explainOpenFailure()` 就是為了這個而存在 ——
它把每一種翻成**可行動**的訊息。這是那個檔案最重要的函式。

### 3.3 一定要做完整收尾，否則 origin 會壞掉

```js
await transport.disconnect();
await transport.waitForUnlock(1500);   // 少了這行，拔插之後就再也開不起這個埠
await port.close();
```

這是 Web Serial 最常見的「怎麼突然壞了」。`serial.js` 的 `close()` 與
`index.html` 的 `startFlash()` finally 區塊都必須走完。

### 3.4 沒有 Safari / Firefox

沒有 polyfill 可以救。UI 必須在**使用者按下去之前**就偵測並說明
（`capabilities()`），而不是讓他按了才發現不能用。

## 4. 三種燒錄模式

| 模式 | 適用 | 需要什麼 |
|---|---|---|
| `esptool` | 所有 ESP 晶片 | Web Serial + esptool-js |
| `uf2` | RP2040 / RP2350 / **原生 USB 的 ESP32-S3·S2·C3** | 只要拖放，**不需要驅動、任何瀏覽器都能用** |
| `manual` | 其他 | 只給下載連結與說明 |

> **`.uf2` 是最被低估的一條路。** ESP32-S3 現在也有官方 `.uf2`，對原生 USB 的板子來說
> 它完全繞過了驅動、baud rate、bootloader 進入時機這些最容易失敗的環節。
> 目錄裡每一塊支援的板子都應該同時提供 `.bin` 與 `.uf2`。

## 5. 燒錄位址：全部都是 `0x0`

```
ESP32 / S2 / S3 / C3 / C6  → 0x0
ESP8266                    → 0x0
```

舊文件常寫「ESP32 = 0x1000」，那是**含 bootloader 的合併映像**位址。
MicroPython 官方發佈的是單一映像，一律從 `0x0` 開始。
`catalog.test` 有一條測試在守這個（`每個板子的燒錄位址都是 0x0`）。

## 6. 檔案結構與邊界

```
web/
├─ index.html               UI（單檔，設計 token 與 prototype/index.html 一致）
├─ js/
│  ├─ catalog.js            板子 / 固件 / 預設參數（純資料 + 純函式）
│  ├─ serial.js             挑埠 + 錯誤翻譯 + 開埠登記表（**不開埠**）
│  ├─ flasher.js            燒錄編排 —— 不碰 DOM、不碰 Web Serial
│  └─ flasher.test.js       20 個單元測試（node 內建 runner，零 npm）
├─ smoke.test.mjs           UI 煙霧測試（CDP）
└─ vendor/
   ├─ esptool-js.bundle.js  305 KB
   ├─ fonts.css             15 KB（已把 Google Fonts 的 @font-face 改成本地路徑）
   └─ fonts/*.woff2         24 個檔案，約 400 KB
```

**邊界規則：** `flasher.js` 不准 import `serial.js` 或碰 DOM。
所有與 esptool-js 的接觸都透過注入的 `loader` 物件。這讓燒錄邏輯可以在 Node 裡
單元測試，不需要瀏覽器也不需要板子。

## 6.1 離線能力（實測）

```
document.styleSheets            → 只有 /vendor/fonts.css
performance.getEntriesByType    → 過濾掉本機 origin 之後：[] （零外部請求）
document.fonts.size             → 42 個 face，全部本地
```

啟動方式（不需要任何工具鏈）：

```
start-web.cmd                   # Windows：起 http.server 並開瀏覽器
# 或
cd web && python -m http.server 8807 --bind 127.0.0.1
```

> **為什麼不能雙擊 `index.html`：** ES module 在 `file://` 下會被同源政策擋掉，
> 而且 Web Serial 需要安全來源。`http://127.0.0.1` 兩者都滿足 —— 這是唯一
> 「本機依賴」，而且 Python / Node / PHP 任一都行。

**唯一需要網路的時候**是按「下載」抓官方固件（因為沒有 CORS，見第 2 節）。
把檔案存下來之後，之後的燒錄、重刷、換版本都完全離線。

## 6.2 序列埠的擁有權（避免 `The port is already open`）

這是一個實際發生過的 bug，值得單獨記錄。

**症狀：**
```
Failed to execute 'open' on 'SerialPort': The port is already open.
```

**根因：** 原本的設計是「`serial.js` 先 `port.open()`，再把開好的埠交給 esptool」。
但 esptool-js 的 `Transport.connect()` **無條件**呼叫 `device.open()`，沒有先檢查狀態；
而且 `ESPLoader` 內部還會透過 `changeBaudrate()` 自己 `disconnect()` → `connect()`。

**所以：`serial.js` 不准開埠。** 它只負責挑埠與描述埠，把原始 `SerialPort` 交出去，
由 esptool 完全擁有。收尾一律走 `Transport.disconnect()`（它最後會 `device.close()`）。

**三道防線：**

1. **結構上不可能重複開埠** —— 只有 esptool 會呼叫 `open()`。
2. **開埠登記表**（`OPEN_PORTS`）—— Web Serial 沒有「這個埠開著嗎」的查詢 API，
   所以自己記。`acquirePort()` 一開始就 `releaseAllSessions()`。
3. **給使用者的自救按鈕** —— 錯誤面板上的「釋放序列埠」會強制清掉所有殘留連線。
   有這個按鈕，使用者不必重新整理頁面就能脫困。

## 8. 最重要的除錯案例：reset mode 選錯，連線永遠失敗

### 8.1 症狀

使用者的 ESP32-S3（VID:PID `303A:1001`，USB-Serial-JTAG）燒錄失敗：

```
esptool.js
Serial port WebSerial VendorID 0x303a ProductID 0x1001
連線裝置（reset mode: no_reset）…
Connecting...
連不上裝置的 bootloader
Failed to connect with the device
```

### 8.2 我原本的（錯誤的）診斷

我當時的推理是：

> USB-Serial-JTAG 沒有自動重置電路 —— 沒有 DTR/RTS 可以拉、沒有 RESET 腳可以踢，
> 所以 esptool 的 `default_reset` / `usb_reset` / `no_reset` 三種模式都救不了。
> 唯一的路是使用者手動進 bootloader。

**症狀描述對了一半，但結論錯了。** 我甚至用官方 Python esptool 驗證過三種模式都失敗，
就更加確信這個結論 —— 但那次驗證其實有個盲點：**當時裝置正在跑 MicroPython，
而且我沒有給它正確的重置序列。**

### 8.3 真正的答案（讀 esptool-js 原始碼得到）

`ESPLoader.constructResetSequence()`：

```js
constructResetSequence(mode) {
  if (mode === "no_reset") return [];                    // ← 空序列！完全不重置
  if (mode === "usb_reset" || this.isUsbJtagSerialPort()) {
    return [this.resetConstructors.usbJTAGSerialReset(this.transport)];
  } else {
    return [classicReset(50), classicReset(550)];         // 橋接晶片
  }
  return [];
}

isUsbJtagSerialPort() {
  return this.transport.getVid() === 0x303A && this.transport.getPid() === 0x1001;
}
```

（常數值已從 bundle 反查確認：`ESPRESSIF_VID = 12346 = 0x303A`、
`USB_JTAG_SERIAL_PID = 4097 = 0x1001`。）

而且 `UsbJtagSerialReset` **確實存在**，它是專門為 USB-Serial-JTAG 寫的：

```js
class UsbJtagSerialReset {
  async reset() {
    setRTS(false); setDTR(false); wait(100);
    setDTR(true);  setRTS(false); wait(100);
    setRTS(true);  setDTR(false); setRTS(true); wait(100);
    setRTS(false); setDTR(false);
  }
}
```

**所以：**

| resetMode | 原生 USB（303A:1001）的結果 |
|---|---|
| `no_reset` | **回傳空序列 → 晶片永遠不會進 bootloader** |
| `usb_reset` | 走 `usbJTAGSerialReset` ✅ |
| `default_reset` | 因為 `isUsbJtagSerialPort()` 為真，**也**走 `usbJTAGSerialReset` ✅ |
| `hard_reset` | 走 `HardReset` |

**我的 bug：`defaultFlashOptions()` 對原生 USB 給了 `no_reset`。** 那個模式回傳空序列，
等於完全不重置 —— 連線必定失敗。

而 Adafruit 的實作**預設就是 `default_reset`**：

```js
let resetMode = "default_reset";        // ← 他們的預設
if (noReset.checked) { resetMode = "no_reset"; /* passthrough 用 */ }
```

他們的 `noReset` 是給 **ESP32 co-processor passthrough 更新**用的特殊情境，
不是給原生 USB 的通用預設。我把那個特殊選項當成通則了。

### 8.4 修法

```js
// catalog.js
resetMode: nativeUsb ? 'usb_reset' : 'default_reset',
```

並且**在 UI 上隱藏 reset mode 選項**（USB-JTAG 時顯示「usb_reset（USB-JTAG 自動）」）——
因為那個值會被 `isUsbJtagSerialPort()` 覆蓋，給一個沒有作用的控制項只會誤導。

`flasher.test.js` 有一條測試專門守這件事，並在註解裡寫明為什麼。

### 8.5 從 Adafruit 學到的另外兩件事

**① 埠只 request 一次，之後重複使用。**

```js
if (device === null) { device = await serialLib.requestPort({}); }
```

`requestPort()` 每次都會跳系統對話框，而使用者選的幾乎每次都是同一塊板子。
我們的作法更進一步：先用 `navigator.serial.getPorts()`（**不需要手勢**）拿已授權的埠，
沒有才跳對話框 —— **重新整理頁面之後也能自動接回來**。

**② 收尾要三步，而且順序固定。**

```js
await transport.disconnect();       // 取消 reader、關埠
await transport.waitForUnlock(1500); // 等鎖真的放掉
await device.close();                // 保險：確保回到關閉狀態
```

少了第 2 步，下次開啟會撞 `InvalidStateError`（俗稱 `The port is already open`）。
少了第 3 步，disconnect 半途失敗時埠會卡在開啟狀態。

### 8.6 仍然成立的部分

「裝置正在跑 MicroPython 時 esptool 連不上」**還是對的** ——
但原因不是「硬體做不到重置」，而是**重置序列會把晶片踢進 bootloader，
而 MicroPython 正在跑的時候，那個重置確實可能不生效**（取決於板子的 reset 電路）。

所以 `diagnose.js` 的診斷**仍然有價值**：它會告訴使用者「裝置已經有 MicroPython 了，
可能不需要燒錄」。但它給的指示要修正 —— 不該說「一定要手動按 BOOT」，
因為正確的 `usb_reset` 通常就能自己完成。

## 9. 多裝置：能連幾個，以及為什麼 UI 只有一個

### 9.1 技術上做得到，已查證

| 檢查 | 結果 |
|---|---|
| esptool-js 有模組層級可變狀態嗎 | **0 個**（頂層 `let`/`var` 數量 = 0，`ESPLoader` 沒有靜態屬性寫入）。每個實例的狀態都在 `this` 上，**多實例是安全的** |
| 一個頁面能開幾個 SerialPort | 多個。`navigator.serial.getPorts()` 回傳陣列，每個埠有自己的 `readable` / `writable` / `setSignals`，**baud rate 是每個埠獨立的** |
| 能同時燒嗎 | 可以，各 `ESPLoader` 持有自己的 `Transport`。USB 2.0 的 480 Mbps 對兩三塊板子是夠的 |

### 9.2 真正的阻礙：瀏覽器分不出哪塊是哪塊

```
SerialPort.getInfo()   →  只有 usbVendorId + usbProductId
```

```
pyserial 拿得到：                      瀏覽器拿得到：
  device          COM26                  —
  vid:pid         303A:1001              usbVendorId / usbProductId   ✓
  serial_number   '58:E6:C5:72:42:24'    ✗ 沒有
  location        '1-5:x.0'              ✗ 沒有
```

兩塊同型號的 ESP32-S3 連上去之後，**瀏覽器眼中完全一樣**：
`getInfo()` 回傳相同值、系統對話框顯示兩個一樣的 `USB Serial Device`。
而且就算用 Python 後端拿到了清單，**頁面也沒辦法把它手上的 `SerialPort` 物件對應到 COM26**
—— Web Serial 沒有提供這個對應。

**這不是可以繞過的，是規格就沒給。** 額外證據：這顆 ESP32-S3 連 chip ID 都沒有
（`Warning: ESP32-S3 has no chip ID. Reading MAC address instead.`）。

### 9.3 唯一可靠的解法：把身分寫進裝置

連接之後在裝置上寫 `/mpt_id.py`，內容含名稱與 uuid，之後靠讀它來認身分。
這是唯一可靠的辦法，也順便補上了原廠沒給唯一 ID 的問題。

### 9.4 三個實務地雷

1. **USB 供電。** 兩塊 ESP32-S3 同時燒錄，每塊瞬時可抓 350–500 mA。接在同一個
   hub port 上很容易電壓不足 → brownout → 燒錄中途斷線。要平行燒就得用獨立 USB 埠
   或有供電的 hub。
2. **重置會讓埠重新編號。** 實測：`COM27` → `COM26`。原生 USB 的板子在 `hard_reset`
   之後會重新列舉，舊的 `SerialPort` 物件可能失效。**所以裝置的識別碼不能用埠號。**
3. **權限是「選一次、授權永久」。** 每個裝置都要使用者手動點一次對話框，無法用程式碼代勞。

### 9.5 目前的取捨

**底層寫成 N 個，UI 只顯示一個。** `DeviceRegistry` 是陣列、`DeviceSession` 每個裝置
一個實例（自己的埠、loader、進度、日誌）。多裝置只是「遍歷 registry」，
而不是把單數概念散落各處再重寫。

UI 維持單裝置的理由：多裝置沒有命名機制時**使用者自己也分不出哪塊是哪塊**，
先做多裝置只會製造混亂。等 `/mpt_id.py` 的身分機制做好再開。

---

## 10. 兩種燒錄策略

`.bin` 與 `.uf2` 在**每一個層面**都不一樣，所以各自一個 strategy，共用同一組事件：

|              | `.bin` / esptool | `.uf2` / 拖放 |
|--------------|------------------|---------------|
| 通訊          | Web Serial（獨佔埠） | 檔案系統（磁碟） |
| 需要驅動      | 原生 USB 不用；橋接晶片要 | **完全不用** |
| 進 bootloader | esptool 自己試 —— **原生 USB 常常失敗** | 使用者按 BOOT 插 USB |
| 可回報進度    | 可以（位元組層級） | 不行（只有 0 與 100） |
| 失敗訊息      | esptool 的（要翻譯） | 幾乎沒有（板子就不開機） |
| 適用晶片      | 全部 ESP | 原生 USB：S2/S3/C3/C6、RP2040/2350 |

### 10.1 為什麼 `.uf2` 值得做

它繞過**三個最容易失敗的環節**：驅動、baud rate、以及「esptool 把晶片踢進 bootloader」
—— 第三個正是這顆 ESP32-S3 永遠做不到的事（第 8 節）。

### 10.2 誠實的限制：瀏覽器不能寫入磁碟

網頁**沒有辦法**把檔案寫進使用者電腦上的隨身碟。File System Access API 對
「卸除式磁碟」的支援很差；WebUSB 理論上可以自己實作 USB Mass Storage + FAT，
但那是幾千行的底層實作，換來的只是「少拖一次」。不值得。

所以這條路的 UI 是：**我們把檔案驗證好、給你下載、告訴你拖到哪個磁碟。**
這是可靠的，而且任何瀏覽器都能用。

### 10.3 拖放沒有安全網，所以驗證要在拖之前做完

拖錯晶片的 `.uf2` 進 BOOTSEL 磁碟，**bootloader 不會解釋，板子就是不開機**。
所以 `parseUf2()` 在拖之前檢查：魔數、block 數與實際大小是否相符、每個 block 的
檔頭/結尾魔數、payload 上限、以及 **family ID 與選定板子是否相符**。

`web/js/flash/uf2.test.js` 有 20 條測試守這件事，其中兩條是
「把 Pico 的 uf2 拖進 ESP32-S3 必須擋下來」與反向。

## 11. 目前哪些是真的、哪些還是設計稿

UI 是從設計原型演進來的，所以有些畫面仍然是原型的**示範資料**。
這件事必須明講 —— **假資料假裝是真的比缺功能更糟**，因為使用者無法分辨
「184 KB」是從板子讀回來的還是寫死的。

| 功能 | 狀態 | 說明 |
|---|---|---|
| **esptool 燒錄（`.bin`）** | ✅ 真的 | 已在實機走到 `Stub running` + `Changed`（921600）|
| **序列埠取得 + 認晶片** | ✅ 真的 | `acquirePort()` → `navigator.serial.requestPort()` |
| **esptool 輸出解析** | ✅ 真的 | MAC / Features / Flash ID 從 log 撈出來填進裝置面板 |
| **連線失敗診斷** | ✅ 真的 | 認出「裝置在跑 MicroPython」（見第 8 節）|
| UF2 解析與驗證 | ✅ 真的 | `parseUf2()`，20 條測試。**但還沒接進 UI** |
| 檔案總管 | ❌ 空的 | 已移除示範資料。需要 raw REPL |
| 編輯器 | ❌ 空的 | 已移除示範資料。需要 raw REPL + CodeMirror |
| REPL | ❌ 空的 | 已移除示範資料。需要 Web Serial 版 raw REPL 協定 |
| 裝置面板（記憶體／檔案系統） | ❌ 空的 | 已移除假數字。需要 raw REPL |
| 套件管理 | ❌ 空的 | 已移除假清單。需要 `mip` + raw REPL |
| 序列埠監控 | ❌ 空的 | 已移除亂數圖表。需要 raw REPL |

**畫面上沒接上的地方一律是空的，並附上「需要什麼才能變成真的」。**
示範資料全部移到 `web/mock/`（見 11.3）。

### 11.1 這輪修掉的「按了沒反應」與「假裝是真的」

這些都是同一類問題：**程式碼參照了不存在的東西，而失敗是安靜的。**
UI 是從設計原型演進來的，所以我在原型的基礎上改時，用了它沒有的函式與欄位。

| # | 問題 | 症狀 |
|---|---|---|
| 1 | `connect()` 是原型的模擬函式（`await sleep(700); S.connected = true`） | **從來沒碰過 `navigator.serial`** → 沒有對話框 |
| 2 | `$("#conn-label")` → 這個 id 在 HTML 裡不存在 | TypeError |
| 3 | `S.caps` → 這個欄位沒定義 | TypeError |
| 4 | `setBusy()` → 函式不存在 | TypeError |
| 5 | `renderProgress()` → 函式不存在 | **進度條完全不動**（燒錄其實在跑） |
| 6 | `progress` 事件只寫狀態、沒有重繪 | 同上 |
| 7 | 裝置面板的「不在 bootloader」提示條件寫錯 | 讀到晶片名卻同時說讀不到 |
| 8 | 側欄顯示寫死的示範檔案樹 | 使用者以為 `main.py` 在他板子上（他的板子只有 `boot.py`） |

**2–5 都發生在 async 函式裡 → 變成未處理的 promise rejection →
console 乾淨、畫面毫無反應。** 使用者只看到「按了沒動靜」。

### 11.2 防線：啟動自我檢查

`SELF_CHECK` 在渲染之前驗證 19 個 DOM id 與 8 個狀態欄位，
缺任何一個就同時 `console.error` 與彈紅色 toast。`checkState()` 的訊息裡
直接寫明「這會變成未處理的 promise rejection，症狀是 console 乾淨、畫面沒反應」——
把教訓寫進程式碼，而不是只寫在文件裡。

### 11.3 示範資料全部移出主 UI（`web/mock/`）

上面只是冰山一角。實際盤點後發現主 UI 裡有**七處**寫死的示範資料：

| 位置 | 內容 | 為什麼危險 |
|---|---|---|
| 側欄檔案樹 | `boot.py`、`main.py`、`lib/sensor.py`、`ssd1306.mpy` | 看起來完全是合理的檔案樹，很容易被當成自己板子上的內容 |
| 編輯器 | DHT22 範例程式 + 行號 + 錯誤波浪線 | 一段看起來合理的程式 |
| REPL | `MicroPython v1.25.0 on …`、`machine.freq()` → `240000000` | 一段像真的的 REPL 對話 |
| 裝置面板 | `1.34 MB / 184 KB / 00:14:22 / 41 °C` | 具體數字，最容易被當成真讀數 |
| 套件管理 | `dht`、`ssd1306`、`umqtt.simple` … | 看起來像已安裝清單 |
| 監控圖表 | 溫度／濕度／heap 折線，每 700 ms **亂數跳動** | **一張會動的圖最容易騙到人** —— 看起來真的在讀資料 |
| 假動作 toast | `已重新整理 · 讀到 4 個項目`、`已儲存到裝置`、`裝置已重置` | **假成功訊息**：使用者會以為檔案真的上去了 |

**處置：分開存放。**

```
web/mock/index.html   ← 完整設計原型（單檔、零依賴），示範資料全在這裡
web/mock/README.md    ← 說明每個面板的示範資料對應哪個真實來源
web/index.html        ← 只顯示真的東西；沒接上的地方明確寫「尚未接上」
```

主 UI 現在的行為：

- 尚未接上的動作 → `toast("warn", "這個功能還沒接上", "它需要 Web Serial 版的 raw REPL。目前只有「燒錄」是真的。")`
- 尚未接上的面板 → 虛線框 + 說明「需要什麼才能變成真的」
- 裝置面板 → **只顯示 esptool 真的讀回來的東西**（見 11.4）

> **原則：假資料假裝是真的，比缺功能更糟 —— 使用者無法分辨。**
> 而「假成功訊息」又比假資料更糟：它會讓使用者以為操作成功了。

### 11.4 讓裝置面板顯示真資料

修完上面之後裝置面板變全空。空的不是問題，但**可以填真的**。

esptool-js 不把晶片資訊回傳成物件，只印到 terminal：

```
Chip is ESP32-S3 (QFN56) (revision v0.2)
Features: Wi-Fi,BLE,Embedded PSRAM 8MB (AP_3v3)
Crystal is 40MHz
MAC: 58:e6:c5:72:42:24
Flash ID: 184046
```

所以 `catalog.js` 的 `parseEsptoolLine()` 解析這些行，
`handleEsptoolOutput()` 把結果填進裝置面板。**面板顯示的與 log 顯示的是同一份資料** ——
不可能出現「log 說 MAC 是 A、面板說 B」。

解析器有 12 條測試（`catalog.test.js`），測資是**真實的 log**，不是編的。
其中兩條守著兩個方向的錯誤：

- 撈不到 → 面板永遠空白，使用者覺得整個工具都是假的
- 撈錯了 → 顯示一個錯的 MAC，而且看起來很合理，根本沒人會發現

**實測結果**（把真實 log 餵進去）：

```
CHIP      ESP32-S3 (QFN56) (revision v0.2)
MAC       58:e6:c5:72:42:24
FEATURES  Wi-Fi,BLE,Embedded PSRAM 8MB (AP_3v3)
CRYSTAL   40 MHz
FLASH ID  184046
```

> **`(revision` 這個字串有特殊用途。** 我們用它分辨「真晶片名」與「認不出來時的
> 佔位字串」，所以解析時絕對不能把它削掉。`catalog.test.js` 有一條測試專門守這件事。

### 11.5 最貴的一個 bug：兩份 UI 互相漂移

**這一節值得單獨列出來，因為它讓前面幾小時的修改全部白費。**

`mptools/web/server.py` 原本服務的是**自己的 UI 副本**：

```
mptools/web/index.html   82.6 KB   12:12   ← Python 服務送的（過時）
web/index.html          122.8 KB   16:37   ← 我們一直在改的
```

使用者的習慣是開 Python 服務（`python -m mptools` → `http://127.0.0.1:8765`），
所以**他看到的一直是那份舊副本**：模擬的 `connect()`、示範檔案樹、假資料。
而我們在另一份檔案上修了好幾個小時，還納悶為什麼「按了沒反應」。

更糟的是：我自己在前一輪才剛寫下「兩份 UI 應該合併，不該維護兩份」，
然後就繼續在錯的那一份上工作。

**修法：刪掉副本，Python 服務直接服務 `web/`。**

```python
# 從 mptools/web/ 往上兩層 → repo 根目錄的 web/
WEB_DIR = Path(__file__).resolve().parent.parent.parent / "web"
```

同時移除了 `bridge.js`（它負責把假資料換成真的）—— 現在 UI 自己就會做，
不需要注入任何東西。**少一層注入就少一個會漂移的地方。**

> **通則：同一個東西只能有一份。** 如果某個檔案有兩個副本，
> 那你改的永遠有 50% 機率是錯的那一份，而且**沒有任何東西會報錯**。

### 11.6 修完之後才發現的第二層：靜態路由對不上

刪掉副本之後畫面變**全白**，console 只有 404：

```
/js/serial.js                  404
/vendor/esptool-js.bundle.js   404
```

原因：Python 服務只註冊了 `/static/`，但 UI 用相對路徑載入 `./js/…`、`./vendor/…`。
檔案都在，只是路徑對不上 —— 整個 module graph 載入失敗。

```python
for sub in ("js", "vendor"):
    app.router.add_static(f"/{sub}/", WEB_DIR / sub)
```

> 這一類「檔案在但路徑錯」的錯，症狀是**畫面全白 + console 只有 404**，
> 很容易被誤判成「JavaScript 壞了」。

### 11.7 「我接在哪個埠？」—— 瀏覽器不知道

使用者問「他連接了什麼端口現在是完全沒有提示的」。查證後：

```js
SerialPort.getInfo()  →  { usbVendorId, usbProductId }   // 就只有這兩個
```

**沒有埠號、沒有序號、沒有 USB 拓撲位置。** 這是規格就沒給。
所以兩塊一樣的板子，網頁看到的值完全相同。

原本裝置面板把 `303A:1001` 標成 `Port` —— **那是錯的標籤**，
會讓人以為看到的是埠號。改成 `USB ID`，並明確加註「這不是埠號」。

要拿到真正的埠號有兩條路，UI 兩條都告訴使用者：

1. **系統的裝置選擇對話框** —— 裡面會顯示 `USB Serial Device (COM26)`
2. **本機服務**（`python -m mptools`）—— 用 pyserial，看得到埠號、序號、位置

有本機服務時，`probeBackend()` 會打 `/api/health` 與 `/api/ports`，
裝置面板就多一段：

```
連接的埠   [本機服務已連線]
  埠號      COM26
  USB 晶片  Espressif USB-Serial-JTAG
  序號      58:E6:C5:72:42:24
  位置      1-5:x.0
```

沒有服務時顯示「瀏覽器不會告訴網頁『是 COM 幾』」並說明兩個辦法。
**兩種情況都不留空白、也不假裝。**

### 11.8 第十次之後：加了靜態檢查

到這裡，「程式碼參照了不存在的東西」已經發生**十次**，而且症狀全部一樣：

```
console 乾淨、畫面沒反應
```

因為多半發生在 async 函式裡，變成未處理的 promise rejection。

完整清單：

| # | 參照了什麼 | 後果 |
|---|---|---|
| 1 | `$("#conn-label")` | 那個 DOM id 不存在 |
| 2 | `S.caps` | 狀態欄位沒定義 |
| 3 | `setBusy()` | 函式不存在 |
| 4 | `renderProgress()` | 函式不存在 → **進度條完全不動** |
| 5 | `row()` | 定義在別的函式裡（作用域） |
| 6 | `RELEASE` | 忘了 import → **整個燒錄頁壞掉** |
| 7 | `startChart()` | 刪掉圖表引擎時忘了改呼叫點 |
| 8 | `drawChart()` | 同上（第二個呼叫點） |
| 9 | `mptools/web/index.html` | 那是另一份 UI（見 11.5） |
| 10 | `/js/*` 路由 | 路徑對不上 → 畫面全白 |

**`node --check` 抓不到**（語法正確），**啟動自我檢查也抓不到**
（那只驗 DOM id 與狀態欄位）。所以要專門掃一次：

```
node tools/check-undefined.mjs
```

它做的事：

1. 剝掉字串與註解 —— **但保留 template literal 的 `${}` 內容**（那是真實程式碼，
   也是最常見的錯誤位置：`${esc(x)}` 而 `esc` 不存在）
2. 收集有定義的名字：import / function / const / let / class / 參數 / catch / 解構
3. 找出被「呼叫」或「取屬性」的裸識別碼
4. 扣掉 JS 內建與瀏覽器 API

**從 31 個候選收斂到 1 個真 bug。** 第一版沒剝字串，報告裡全是
`micropython.org`、`rgb(...)`、`docs/WEB-ARCHITECTURE.md`、`.js`、`v1` 這種噪音 ——
**一份充滿噪音的報告會讓人開始忽略它**，然後真正的問題跟著被忽略。

兩個實作陷阱（都寫進程式碼註解了）：

- **`let cmdSel = 0, cmdHits = COMMANDS;` 一行宣告兩個名字。** 只抓緊接在關鍵字
  後的那個，就會把 `cmdHits` 誤報成未定義。要拿整行切逗號。
- **`return"x"in y` 不能剝成 `returnin y`** —— 那會冒出一個假識別碼。留 `""` 佔位。

檢查器自己有 18 條測試（`tools/check-undefined.test.mjs`），因為
**一個壞掉的檢查器會回報「✓ 沒有未定義的識別碼」，那比沒有檢查器更糟**。
其中一條測試**故意斷言這個檢查器抓不到純作用域錯誤**（它不做作用域分析）——
把限制寫成測試，免得有人誤以為它萬能。

#### 檢查器漏掉 `selected` 的那一次，以及修法

檢查器上線後，使用者貼來第四個 `ReferenceError`：

```
Uncaught (in promise) ReferenceError: selected is not defined
    at renderFlash
```

`renderFlash()` 的三個步驟分支裡，step 1 與 step 2 各自 `const selected = …`，
而 step 3 用了 `selected` —— **兩個都不在它的作用域裡**。

檢查器當時回報「✓ 沒有問題」，因為它**只檢查兩種形狀**：

| 形狀 | 例子 | 檢查器 |
|---|---|---|
| 被呼叫 | `startChart()` | ✅ 抓到 |
| 被取屬性 | `RELEASE.version` | ✅ 抓到 |
| **裸識別碼** | `${selected && …}` | ❌ **漏掉** |

修法是把裸識別碼也納入，但**過濾規則要嚴**，否則會被誤報淹沒。
加了三條規則之後仍然漏，於是最後補上一條**針對 template literal `${}` 的專門規則**
（真實 bug 就出現在那裡）。

同一次也修掉三個誤報：

- `const { x } = obj` 的 **`obj`**（解構右值）
- `const [p] = arr` 的 **`arr`**（同上）
- `import { bar as baz }` 的 **`bar`**（模組原名，不是本地識別碼）

`import` 那條的修法是**整條 import 語句跳過** —— 本地綁定名由 `collectDeclared`
處理，原名根本不需要檢查。整句當一個單位處理最乾淨。

> **通則：靜態檢查的價值取決於它的誤報率。** 一份充滿噪音的報告會讓人開始
> 忽略它，然後真正的問題跟著被忽略 —— 那比沒有檢查器更糟。

### 11.9 兩個「有防護、沒修好」的地方

使用者貼來的 console 裡還有兩行，各自代表一種不同的失誤：

**① `[ui] #conn-label 不存在`**

我為了 `connect()` 的 null 參照加了「找不到就吵鬧地失敗」的防護 ——
**但忘了把元素加進 HTML**。結果每次連線都印一行錯誤，卻沒有任何功能壞掉，
於是那行錯誤被當成雜訊忽略了好幾輪。

> **加防護不等於修好。** 防護只是讓失敗變得可看見 —— 看見之後還是要修。
> 而且現在 `conn-label` 進了 `SELF_CHECK.domIds`，缺了就直接擋在啟動。

**② `GET /api/health 404 (File not found)`**

本機服務的探測是無條件執行的。用靜態伺服器（`python -m http.server`）開的時候，
那個路徑不存在，於是每次載入都留一行紅字。

**那不是錯誤** —— 靜態託管本來就沒有後端。但一行紅字會讓真正的問題被忽略，
而且瀏覽器記錄失敗請求這件事**沒辦法從 `fetch` 的 catch 攔掉**。

修法：**只在有機會成功的時候才探。**

```js
if (location.port !== BACKEND_PORT) return;   // 靜態伺服器、file://、桌面殼都不探
```

順便也消除了 `favicon.ico` 的 404（改用 inline SVG data-URI，零額外檔案）。

**實測結果**（靜態伺服器，10 個請求）：

```
failedRequests: []
apiProbes:      []
```

console 現在是乾淨的 —— 所以下次真的有東西壞掉時，那一行會很顯眼。

**③ 但 `#conn-label` 還是找不到 —— 而我的錯誤訊息指錯了方向**

加了元素之後，使用者回報**同一個錯誤還在**。查下去才發現真正的原因：

```js
// connect() 為了顯示「正在連線…」而這麼做：
$("#strip-slot").innerHTML = `…正在連線…`;
```

**`#conn-label` 就住在 `#strip-slot` 裡面** —— 那一行把它連根刪掉，
所以幾行之後的 `setConnLabel()` 當然找不到。

而我寫的錯誤訊息是「檢查 HTML 是否被改壞了」，**那個判斷是錯的**，
它讓我朝錯的方向找了好幾輪。元素一直在 HTML 裡，是**執行期被自己的程式碼清掉的**。

修法：加一支 `renderStrip(html, label)`，所有改動裝置條的地方都走它 ——
它會把 `#conn-label` 重新種回去。四處呼叫點全部改掉，並且在直接寫
`innerHTML` 的位置留註解警告。

錯誤訊息也改成指向真正的兇手：

```
[ui] #conn-label 不見了。它在 #strip-slot 裡面，而某處直接改寫了
     #strip-slot.innerHTML —— 請改用 renderStrip()，它會把標籤種回去。
```

**實測**（連按三次「連線裝置」，每次都會重寫裝置條）：

```
afterThreeAttempts: { connLabel: "請在對話框中選擇你的開發板", exists: true, count: 1 }
consoleErrors: []
```

> **通則：錯誤訊息指錯方向，比沒有訊息更貴。**
> 「檢查 HTML 是否被改壞了」讓我假設問題在靜態檔案；
> 實際上問題在執行期的 DOM 操作。訊息要指向**機制**，不是猜測。

### 11.10 `Soft resetting is currently only supported on ESP8266`

固件燒完之後冒出這個 **unhandled rejection**：

```
Uncaught (in promise) A: Soft resetting is currently only supported on ESP8266
    at yi.softReset (esptool-js.bundle.js)
    at yi.after (esptool-js.bundle.js)
    at runFlash (flasher.js:281)
```

**固件其實已經燒好了**，但使用者看到紅色錯誤，合理懷疑是燒錄失敗。

#### 根因：兩個不同的東西被當成同一個

`resetMode` 有四個值，決定**怎麼進入 bootloader**：

```
default_reset | usb_reset | no_reset | hard_reset
```

`loader.after()` 只認得**三個**值，決定**燒完之後怎麼離開**：

```js
case "hard_reset":    HardReset（全部晶片都支援）
case "soft_reset":    softReset(false)
case "no_reset_stub": 留在 stub
default:
  this.info("Staying in bootloader.");
  this.IS_STUB && this.softReset(true);   // ← 陷阱在這裡
```

而 `softReset(true)` 對非 ESP8266 直接拋錯。

**我們把 `usb_reset` 直接餵給 `after()`** → 掉進 `default` → 拋錯。

而 `usb_reset` 正是我上一輪為了修「晶片不進 bootloader」才加上的值 ——
**修好一個 bug 引入了另一個**，而且新的那個在燒錄**成功之後**才爆，
所以看起來像燒錄失敗。

#### 修法

```js
export function afterMode(resetMode, chip = null) {
  if (resetMode === 'soft_reset' && String(chip).toUpperCase().includes('ESP8266')) {
    return 'soft_reset';
  }
  return 'hard_reset';   // 其他一律 hard_reset
}
```

`usb_reset` 已經在「進入 bootloader」那一步發揮作用（走 `UsbJtagSerialReset`），
燒完之後要的是**重新啟動跑新固件**，那對所有晶片都是 `hard_reset`。

三條測試守著它，其中一條**窮舉所有 `resetMode` × 晶片組合**，
斷言輸出永遠落在 `after()` 認得的三個值裡面。

#### 順便修掉的第二層

`applyFlashDefaults()`（它算 `resetMode`）原本在
`if (!flashRuntime.session)` **裡面**。如果 session 已經存在
（例如使用者先按過「連線裝置」），就跳過重算，於是拿**步驟 2 顯示的猜測值**去燒。

移到 `if` 外面，並在註解寫明「顯示的那個值是猜測，這裡才是真的會被用到的值」。

> **通則：修 bug 時要檢查「這個新值和既有的其他元件相容嗎」。**
> `usb_reset` 對「進 bootloader」是對的，對「離開 bootloader」是錯的 ——
> 同一個字串在兩個介面上語意不同。

---

### 11.11 `InvalidStateError: The port is already closed.` —— 誤報警告

使用者回報這行：

```
serial.js:326 [serial] transport.disconnect 失敗（仍會繼續收尾）
InvalidStateError: Failed to execute 'close' on 'SerialPort': The port is already closed.
    at Pe.disconnect (esptool-js.bundle.js)
    at async FlashSession.release (serial.js:324)
    at async connect ((index):1754)
```

**不是錯誤，是預期情況。** USB-Serial-JTAG 的重置序列會讓裝置**重新列舉** ——
埠在那一刻就自動關閉了，我們之後再 `close()` 當然撞 `InvalidStateError`。

而我們要的結果是「埠是關的」—— **那個結果已經達成了。**

#### 為什麼這種誤報值得修

它不會弄壞功能，但會**侵蝕信任**。這個 session 已經出現過好幾次「雜訊麻痺」：

| 雜訊 | 後果 |
|---|---|
| `[ui] #conn-label 不存在` | 每次連線印一行，被當雜訊忽略了好幾輪 |
| `GET /api/health 404` | 靜態伺服器的正常現象，卻像錯誤 |
| `favicon.ico 404` | 同上 |
| 檢查器第一版的 31 個誤報 | 報告失去可信度 |

**console 越吵，真正的錯誤越容易被忽略。** 所以每一條警告都必須是
「有人應該採取行動」的訊號。

#### 修法

```js
function isAlreadyClosed(error) {
  const name = error.name || '';
  const message = String(error.message || error);
  return (
    name === 'InvalidStateError' ||     // 埠本來就是關的
    name === 'NotFoundError' ||         // 裝置已拔除
    /already closed|not open|device was disconnected|device has been lost/i.test(message)
  );
}
```

`release()` 與 `releaseAllSessions()` 的每一步都用它判斷 ——
「已經關了」不是失敗，其他錯誤照樣印警告。

#### 順便加的測試（`web/js/serial.test.js`，12 條）

用**假的 SerialPort**（不需要硬體）測狀態轉移與錯誤分類。兩條最關鍵：

- **「埠已經關了」→ 斷言 `warnings` 是空的**（防這個 bug 回來）
- **真正的 `NetworkError` → 斷言警告必須出現**（防「把所有錯都吞掉」）

> 修這類雜訊時，最容易順手把**真的**錯誤也一起吞掉。
> 所以兩邊都要有測試：該安靜的安靜，該吵的吵。

#### 測試輔助函式自己出錯的那一次

第一版的 `captureWarnings` 是同步的：

```js
function captureWarnings(fn) {
  const original = console.warn;
  console.warn = (...a) => warnings.push(...);
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }   // ← 這裡就還原了
}
```

但 `release()` 是 async，警告在 promise 完成之後才印 —— 那時 `console.warn`
已經被還原，所以測試收到**空陣列**，看起來像「程式碼沒印警告」。

> **測試輔助函式出錯會讓測試說謊** —— 回報一個不存在的 bug，或掩蓋一個真的 bug。
> 所以輔助函式也要當成產品程式碼來寫（這裡：`async` + `await`）。

## 12. 測試策略

| 層次 | 指令 | 測什麼 |
|---|---|---|
| 燒錄狀態機 | `node web/js/flasher.test.js` | 呼叫順序、預設參數、錯誤建議、取消語意、進度合成（20 項） |
| 連線診斷 | `node web/js/diagnose.test.js` | 認不認得出 MicroPython、SPIRAM 變體、BOOT 指示文字（12 項） |
| UF2 驗證 | `node web/js/flash/uf2.test.js` | 擋掉拖錯晶片、下載中斷、檔案損毀（20 項） |
| raw REPL 協定 | `python -m pytest tests -q` | 位元組框架、`OK` 前綴、逾時語意（9 項） |
| 真機 | 手動 | 驅動、baud rate、原生 USB vs 橋接晶片 |

**為什麼這些測試值得寫：** 燒錄最常見的災難都是順序與判斷問題，而不是 esptool 壞掉 ——
`writeFlash` 裡再抹除一次會抹掉剛寫的固件、忘了 `waitForUnlock` 會讓 origin 壞掉、
重置失敗被當成燒錄失敗會讓使用者白重試、把「裝置在跑 MicroPython」誤判成「連不上」
會讓使用者換掉一條好線。這些全部靠測試守住。

## 13. 已知限制與下一步

- **編輯器 / REPL / 檔案總管還沒有接上真裝置。** 它們目前是設計稿畫面。
  燒錄是真的（esptool-js + Web Serial）；其餘是 UI。
  Web 版的 raw REPL 協定要照 `docs/PYTHON-ARCHITECTURE.md` 第 4 節重寫一份 JS 實作
  （同樣的框架，已經在 Python 驗證過三次踩坑）。
- **`prototype/index.html` 與 `web/index.html` 目前是兩份相近的 UI。**
  `web/` 是能跑的（真實燒錄），`prototype/` 是純設計稿。
  下一步應該讓 `prototype/` 只保留「展示用」的角色，或直接合併。
- **固件 SHA256 只有 ESP8266 那一筆有填。** 有填才驗證，沒填就只比對大小。
- **`.uf2` 模式還沒實作。** 目錄裡已經有 `.uf2` 的 URL，但拖放/WebUSB 送到
  BOOTSEL 磁碟的路徑還沒做。這是**最值得優先做的下一步** —— 它完全繞過驅動、
  baud rate、bootloader 進入時機這三個最容易失敗的環節。
