# mp_Tools

一個跨平臺的 MicroPython / CircuitPython 開發者工作臺 —— 燒錄、IDE、REPL、檔案同步，
收在一個入口裡。

**兩條路，同一套設計：**

| | 純網頁版（主要方向） | 本機服務（選配） |
|---|---|---|
| 位置 | `web/` | `mptools/` |
| 需要什麼 | 一個靜態伺服器 | Python 3.10+ |
| 序列埠 | Web Serial（Chrome / Edge / Android） | pyserial（任何瀏覽器） |
| 燒錄 | esptool-js（已內含在 repo，**不需要 npm**） | 官方 esptool |
| 看得到 COM port 清單嗎 | ✗ 只能跳系統對話框 | ✓ 含 VID:PID 與「被誰佔用」 |

## 純網頁版

```bash
cd web
python -m http.server 8807 --bind 127.0.0.1
# 開 http://127.0.0.1:8807/
```

零 build step、零 npm、零 `node_modules`。`web/vendor/esptool-js.bundle.js` 已經在 repo 裡。

**目前的完成度：** 燒錄精靈四個步驟都能用（選板子 → 選固件 → 選項 → Flash Map 燒錄），
含 esptool 錯誤訊息的可行動化建議。尚未接上：MicroPython REPL、檔案總管、套件管理。

## 本機服務（選配，但解決純網頁做不到的事）

```bash
python -m mptools            # 啟動 web 服務
python -m mptools ports      # 列出序列埠，並指出被誰佔用
python -m mptools doctor     # 環境檢查
python -m mptools repl       # 終端機 REPL
```

純網頁有三件事做不到，需要它的時候再用：

1. **列出所有序列埠** —— `navigator.serial.requestPort()` 一定要使用者手動點、一定會跳對話框。
2. **告訴你埠被誰佔用** —— Windows 的序列埠是獨佔的，這是最常見的卡關原因。
3. **Firefox / Safari** —— 它們沒有 Web Serial。

## 文件

| 文件 | 內容 |
|---|---|
| [docs/WEB-ARCHITECTURE.md](docs/WEB-ARCHITECTURE.md) | **網頁版的事實來源**：已驗證的瀏覽器能力、CORS 限制、架構與測試 |
| [docs/PYTHON-ARCHITECTURE.md](docs/PYTHON-ARCHITECTURE.md) | Python 服務與 raw REPL 協定（含三個實測踩到的坑） |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | UI 設計規格 |
| [docs/PLAN.md](docs/PLAN.md) | 原始規劃（TypeScript + Tauri 路線），保留作參考 |
| [prototype/index.html](prototype/index.html) | 完整 IDE 的 UI 原型（單檔、零依賴） |

## 測試

```bash
node web/js/flasher.test.js     # 20 個燒錄狀態機的單元測試，零 npm 依賴
python -m pytest tests -q       # 9 個 raw REPL 協定測試
python tests/fake_device.py     # 開一個假的 MicroPython 裝置（TCP），不需要硬體
```

## 授權

MIT
