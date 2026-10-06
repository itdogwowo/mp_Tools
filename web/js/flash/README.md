# web/js/flash — 燒錄策略層（**尚未接線**）

⚠️ **這個目錄的程式碼目前沒有任何地方 import。**
`web/index.html` 走的是 `web/js/flasher.js` 的狀態機，不是這裡。
把這個目錄當成「已經在用的程式」會誤判除錯方向。

## 為什麼還是放進來

因為裡面有**已驗證的事實**，那些比程式碼本身更有價值：

| 檔案 | 內容 | 有測試嗎 |
|---|---|---|
| `uf2.js` | UF2 格式解析與驗證（magic、familyID、payload 邊界） | ✅ 20 條 |
| `uf2.test.js` | 上面那個的測試，測資是照 UF2 規格手工建的 | — |
| `uf2-strategy.js` | 為什麼瀏覽器**不能**寫入卸除式磁碟（File System Access API 的限制） | ❌ |
| `esptool.js` | 序列埠擁有權的規則（esptool 完全擁有，我們不 open/close） | ❌ |
| `index.js` | `.bin` 與 `.uf2` 兩條路的介面契約與事件格式 | ❌ |

`uf2.js` 的價值在於它擋掉三件**沒有任何安全網**的事故：

- 拖錯晶片的 `.uf2` 進去 → 板子直接不開機，bootloader 不會告訴你為什麼
- 下載沒完成的檔案 → 同樣不開機
- 檔案損毀 → 同樣不開機

所以驗證必須在**拖進去之前**做完。那 20 條測試守的就是這個，
其中一條是**雙向的**：對的晶片要通過，錯的晶片要被擋。

## 要接上時做什麼

1. 讓 `web/index.html` 改 import `./js/flash/index.js`，用 `pickStrategy()` 挑路徑
2. 把 `esptool.js` 接到 `device.js` 的 `DeviceSession`（那是埠的所有權來源）
3. `.uf2` 那條路目前**缺 UI**：需要「下載檔案 → 告訴使用者拖到哪個磁碟」的流程

## 相關文件

- `docs/WEB-ARCHITECTURE.md` 第 6.2 節 —— 序列埠的擁有權
- `docs/WEB-ARCHITECTURE.md` 第 10 節 —— 兩種燒錄策略的比較
- `docs/WEB-ARCHITECTURE.md` 第 13 節 —— 已知限制與下一步

## 同類狀況

`web/js/device.js`（多裝置註冊表）也是**尚未接線**。
它的設計前提是「瀏覽器無法分辨兩塊一樣的板子」——
要真正支援多裝置，得先寫 `/mpt_id.py` 到每塊裝置上。
見 `docs/WEB-ARCHITECTURE.md` 第 9 節。
