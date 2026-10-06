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

## 8. 最重要的除錯案例：裝置正在跑 MicroPython

這是整個專案最有價值的一次診斷，值得完整記錄。

### 症狀

使用者的 ESP32-S3（VID:PID `303A:4001`，USB-Serial-JTAG）燒錄失敗：

```
esptool.js
Serial port WebSerial VendorID 0x303a ProductID 0x1001
連線裝置（reset mode: no_reset）…
Connecting...
連不上裝置的 bootloader
Failed to connect with the device
```

看起來完全像「連線問題」。實際發生過的嘗試：

| 嘗試 | 結果 |
|---|---|
| 按住 BOOT 重試 | 失敗 |
| 降低 baud rate（921600 → 460800 → 115200） | 失敗 |
| 換 USB 線 | 失敗 |
| 三種 `--before` 模式（`default-reset` / `usb-reset` / `no-reset`） | **全部失敗** |

### 診斷過程

**關鍵一步是不要相信「連不上」這三個字，去看裝置到底在說什麼。**
用 pyserial 直接開埠並送 Ctrl-C：

```python
p = serial.Serial('COM27', 115200, timeout=0.2)
p.write(b'\x03\x03')          # Ctrl-C ×2
# → b'\r\n>>> \r\n>>> '
p.write(b'\x02')              # Ctrl-B（friendly REPL）
# → b'\r\nMicroPython b4e7797d10-dirty on 2026-10-06;
#     Generic ESP32S3 module with Octal-SPIRAM with ESP32-S3\r\n>>> '
```

**裝置正在跑 MicroPython，而且活得好好的。** 後續查到的資訊：

```
os.uname()      → release='1.30.0-preview', machine='Generic ESP32S3 module with Octal-SPIRAM'
gc.mem_free()   → 8,314,032  （8 MB heap，因為是 Octal-SPIRAM）
esp.flash_size()→ 4,194,304  （4 MB flash）
os.listdir()    → ['boot.py']
```

### 根因

**USB-Serial-JTAG 沒有自動重置電路。**

- 沒有 DTR/RTS 可以拉（那是 USB-UART 橋接晶片才有的）
- 沒有 RESET 腳可以被 esptool 踢
- 晶片內建 USB 周邊直接接 USB，中間沒有可控制的線

所以 esptool 的**三種 reset 模式全部無效**。唯一的路是使用者手動進 bootloader。

而 MicroPython 正在跑的時候，它不會理會 bootloader 的 SYNC —— 它忙著跑使用者的程式。

### 為什麼這個 bug 特別糟

esptool 的錯誤訊息（`Failed to connect with the device`）**不區分**這三種情況：

1. 埠被別的程序佔用
2. 裝置不在 bootloader
3. 線材/驅動問題

使用者只能瞎試。而且**最諷刺的是：這個裝置根本不需要燒錄** —— 它已經有 MicroPython 了。

### 修法：`web/js/diagnose.js`

燒錄失敗且錯誤訊息像「連線問題」時，自動：

1. 放開序列埠、重新取得、以 115200 開埠
2. 送 `Ctrl-C ×2`（中斷正在跑的程式）→ 讀
3. 送 `Ctrl-B`（friendly REPL）→ 讀 banner
4. 用 `looksLikeMicroPython()` 判斷
5. 若是 → 給出**針對原生 USB 的**具體指示，並從 banner 猜出正確的固件變體

指示文字裡最重要的一行是（`buildBootloaderAdvice()`）：

> **這顆晶片是原生 USB（USB-Serial-JTAG），沒有自動重置電路** —— esptool 無法用
> DTR/RTS 把它踢進 bootloader，一定要手動：按住 **BOOT** → 按一下 **RESET** →
> 放開 RESET → 再放開 BOOT

以及最後一行：

> 如果你只是想寫程式，**根本不需要燒錄** —— 裝置已經在跑 MicroPython 了

### 附帶學到的事

- **`Octal-SPIRAM` 的板子要燒 `SPIRAM_OCT` 變體**，燒標準版會認不到完整的 RAM。
  USB VID:PID 看不出這件事，只有 banner 看得出來。`guessFirmwareVariant()` 就是為此存在。
- 比對要寬鬆：各家的寫法有 `Octal-SPIRAM` / `Octal SPI RAM` / `SPIRAM_OCT` / `SPIRAM` / `PSRAM`。
  用 `spi[\s_-]?ram` 一次涵蓋（測試裡有一條專門守 `"Octal SPI RAM"` 這個寫法 —— 第一版漏了它）。

## 9. 測試策略

| 層次 | 指令 | 測什麼 |
|---|---|---|
| 燒錄狀態機 | `node web/js/flasher.test.js` | 呼叫順序、預設參數、錯誤建議、取消語意、進度合成（20 項） |
| 連線診斷 | `node web/js/diagnose.test.js` | 認不認得出 MicroPython、SPIRAM 變體、BOOT 指示文字（12 項） |
| raw REPL 協定 | `python -m pytest tests -q` | 位元組框架、`OK` 前綴、逾時語意（9 項） |
| 真機 | 手動 | 驅動、baud rate、原生 USB vs 橋接晶片 |

**為什麼這些測試值得寫：** 燒錄最常見的災難都是順序與判斷問題，而不是 esptool 壞掉 ——
`writeFlash` 裡再抹除一次會抹掉剛寫的固件、忘了 `waitForUnlock` 會讓 origin 壞掉、
重置失敗被當成燒錄失敗會讓使用者白重試、把「裝置在跑 MicroPython」誤判成「連不上」
會讓使用者換掉一條好線。這些全部靠測試守住。

## 10. 已知限制與下一步

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
