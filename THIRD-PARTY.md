# 第三方元件授權聲明

這個 repo 包含以下第三方元件（為了**完全離線**可用而直接內含，不是用 CDN）：

---

## esptool-js

- **檔案**：`web/vendor/esptool-js.bundle.js`（v0.7.0，bundle 版本）
- **來源**：https://github.com/espressif/esptool-js
- **授權**：Apache License 2.0
- **版權**：Copyright (c) 2023 Espressif Systems (Shanghai) Co. Ltd.

用途：ESP32 / ESP8266 系列的 Web Serial 燒錄。

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## 字型（`web/vendor/fonts/`、`web/vendor/fonts.css`）

三個家族都是 **SIL Open Font License 1.1**，允許自由嵌入與再散布。
檔案由 Google Fonts 取得後改寫成相對路徑（見 `fonts.css`）。

| 家族 | 版權 | 授權 |
|---|---|---|
| **Archivo** | Copyright (c) Omnibus-Type | SIL OFL 1.1 |
| **IBM Plex Sans** | Copyright (c) IBM Corp. | SIL OFL 1.1 |
| **IBM Plex Mono** | Copyright (c) IBM Corp. | SIL OFL 1.1 |

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is available with a FAQ at: https://scripts.sil.org/OFL
```

---

## 為什麼要內含而不是連 CDN

1. **離線**是這個工具的硬需求（見 `docs/WEB-ARCHITECTURE.md` 第 6.1 節）。
2. 不該把使用者的 IP 位址送給第三方字型服務。
3. 上游改版或下架時工具不會跟著壞掉。

`python -m mptools doctor` 與 `start-web.cmd` 都不需要網路。
唯一需要網路的時候是按「下載」抓官方固件（原因見 `docs/WEB-ARCHITECTURE.md` 第 2 節）。
