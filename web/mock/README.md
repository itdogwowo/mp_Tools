# web/mock — 設計範式存放區

**這個目錄的東西不會被 `web/index.html` 載入，也不該被載入。**
它是 UI 的**設計參考**：理想的版面、示範資料的形狀、元件的完整狀態。

## `index.html`

整個工作臺的**完整設計原型** —— 單檔、零依賴、用瀏覽器直接開就能看。

打開來會看到全部面板都「有內容」，因為那是設計稿該有的樣子：

| 面板 | 裡面是什麼 | 對應的真實來源 |
|---|---|---|
| 檔案總管 | `boot.py`、`main.py`、`lib/sensor.py`、`ssd1306.mpy` | 裝置的 `os.ilistdir()`（需要 raw REPL） |
| 編輯器 | DHT22 範例程式 + 錯誤波浪線 + 行號 | 裝置上的 `.py` 檔（需要 raw REPL 讀寫） |
| REPL | MicroPython banner 與對話 | Web Serial raw REPL session |
| 裝置面板 | `1.34 MB / 184 KB / 00:14:22` | `os.statvfs()` / `gc.mem_free()`（需要 raw REPL） |
| 套件管理 | `dht`、`ssd1306`、`umqtt.simple` … | `mip` 模組 + micropython.org/pi 索引 |
| 序列埠監控 | 溫度／濕度／heap 折線圖 | 解析裝置 `print()` 出來的 `key=value` |
| Flash Map | bootloader / partitions / firmware 三段 | **已經是真的** —— `web/js/catalog.js` 的固件資料 |
| 命令面板 | 11 個指令 | 真的（`Ctrl-K`） |

## 為什麼要分開放

這些示範資料原本混在 `web/index.html` 裡，造成兩個實際問題：

1. **使用者會以為那是真的。** 連上裝置後看到 `main.py`、`lib/sensor.py`，
   自然會以為那是他板子上的檔案 —— 但那些是寫死的
   （實測某塊 ESP32-S3 上只有 `boot.py`）。
2. **它讓「還沒接上」這件事看不出來。** 一個畫面有內容、有版面、有數字，
   看起來就是完成品。假資料假裝是真的，比缺功能更糟。

所以：**示範資料集中在這裡，`web/index.html` 只顯示真的東西。**
尚未接上的地方，主 UI 會明確寫「尚未接上」而不是填假數字。

## 還原某個面板的設計

要接上某個面板時，**從這裡抄版面和資料形狀**，不要抄資料本身：

```js
// web/mock/index.html 裡的形狀
const TREE = { name: "/", open: true, children: [
  { name: "boot.py", size: 142 },
  { name: "lib", dir: true, open: true, children: [...] },
]};

// 真實版本要產生同樣的形狀，但資料來自裝置
// 見 docs/PYTHON-ARCHITECTURE.md 第 4 節的 raw REPL 協定
```

## 這個目錄可以刪掉嗎

**不行，除非所有面板都接上真實資料了。** 它是唯一的視覺規格來源之一
（另一份是 `docs/UI-DESIGN.md`，那份講的是「為什麼長這樣」）。
