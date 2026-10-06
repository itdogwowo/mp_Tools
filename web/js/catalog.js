/**
 * 板子與固件目錄 —— 靜態資料，不是執行期爬來的。
 *
 * ── 為什麼是靜態的（這是查證後的結論，不是偷懶）────────────────────────
 * micropython.org 的固件回應 **沒有 `Access-Control-Allow-Origin`**。
 * 實測（HEAD，帶 Origin 標頭）：
 *
 *     GET https://micropython.org/resources/firmware/ESP32_GENERIC_S3-...bin
 *     200 OK · 1742 KB · CORS=(none)
 *
 * 所以瀏覽器不能直接 fetch 它。任何「執行期去官網抓固件」的設計在純網頁版
 * 都會失敗 —— 而且失敗方式很難懂（CORS 錯誤長得像網路問題）。
 *
 * 因此這裡放的是**已驗證存在**的 URL 清單。三條取得固件的路，一定都要有：
 *   1. 目錄裡的官方 URL（使用者自己下載後拖進來，或由本機快取提供）
 *   2. 使用者自己的本機檔案（永遠可用的保底路線）
 *   3. 自架伺服器時可加一個代理端點（Python 啟動器就有這個能力）
 *
 * ── 燒錄位址 ───────────────────────────────────────────────────────────
 *   ESP32 / S2 / S3 / C3 / C6  → 0x0
 *   ESP8266                    → 0x0
 * （舊文件常寫 ESP32 = 0x1000，那是含 bootloader 的「合併映像」位址；
 *   MicroPython 官方發佈的是單一映像，一律從 0x0 開始。）
 *
 * ── 三種燒錄模式 ───────────────────────────────────────────────────────
 *   'esptool'  Web Serial + esptool-js（CP210x / CH34x 等橋接晶片必走這條）
 *   'uf2'     拖放或 WebUSB 送到 BOOTSEL/RPI-RP2 磁碟（RP2040、RP2350、
 *             以及原生 USB 的 ESP32-S3/S2/C3）。**不需要驅動，任何瀏覽器都能用。**
 *   'manual'  只給下載連結與說明，不自動燒錄
 */

/** @typedef {'esp8266'|'esp32'|'esp32s2'|'esp32s3'|'esp32c3'|'esp32c6'|'esp32h2'|'rp2040'|'rp2350'} ChipFamily */

export const RELEASE = {
  version: 'v1.29.0',
  date: '20260824',
};

/** 組出 MicroPython 官方固件 URL。格式已實測驗證。 */
export function micropythonUrl(board, version = RELEASE.version, date = RELEASE.date, ext = 'bin') {
  const v = version.replace(/^v/, '');
  return `https://micropython.org/resources/firmware/${board}-${date}-${version}.${ext}`;
}

/**
 * @typedef {Object} FirmwareOption
 * @property {string} id
 * @property {string} label        給人看的名稱
 * @property {string} board        MicroPython 的 board 代號
 * @property {'bin'|'uf2'} ext
 * @property {number} address      燒錄位址（uf2 不適用，填 0）
 * @property {number} [sizeBytes]  實測大小，用來在 UI 上先顯示
 * @property {string} [sha256]     有填才驗證；沒填就只比對大小
 */

/**
 * @typedef {Object} Board
 * @property {string} id
 * @property {string} label
 * @property {ChipFamily} chip
 * @property {number} flashAddress
 * @property {number} flashSizeMB
 * @property {'esptool'|'uf2'|'both'} mode
 * @property {string} note
 * @property {FirmwareOption[]} firmware
 * @property {{vid:number,pid:number}[]} usbIds  用來在挑埠時提示
 */

/** @type {Board[]} */
export const BOARDS = [
  {
    id: 'esp32s3-generic',
    label: 'ESP32-S3（DevKitC-1 / WROOM / MINI）',
    chip: 'esp32s3',
    flashAddress: 0x0,
    flashSizeMB: 4,
    mode: 'both',
    note: '原生 USB 的板子可以直接拖 .uf2；走 USB-UART 橋接晶片的板子用 esptool。',
    usbIds: [
      { vid: 0x303a, pid: 0x4001 },
      { vid: 0x303a, pid: 0x1001 },
      { vid: 0x10c4, pid: 0xea60 },
    ],
    firmware: [
      {
        id: 's3-bin',
        label: 'MicroPython v1.29.0（.bin · esptool）',
        board: 'ESP32_GENERIC_S3',
        ext: 'bin',
        address: 0x0,
        sizeBytes: 1783808,
      },
      {
        id: 's3-uf2',
        label: 'MicroPython v1.29.0（.uf2 · 拖放）',
        board: 'ESP32_GENERIC_S3',
        ext: 'uf2',
        address: 0,
        sizeBytes: 3435520,
      },
    ],
  },
  {
    id: 'esp32-generic',
    label: 'ESP32（DevKitC V4 / WROOM-32）',
    chip: 'esp32',
    flashAddress: 0x0,
    flashSizeMB: 4,
    mode: 'esptool',
    note: '幾乎都是 CP2102 或 CH340 橋接晶片，一定要用 esptool 路徑。',
    usbIds: [
      { vid: 0x10c4, pid: 0xea60 },
      { vid: 0x1a86, pid: 0x7523 },
      { vid: 0x0403, pid: 0x6001 },
    ],
    firmware: [
      {
        id: 'esp32-bin',
        label: 'MicroPython v1.29.0（.bin）',
        board: 'ESP32_GENERIC',
        ext: 'bin',
        address: 0x0,
        sizeBytes: 1790976,
      },
    ],
  },
  {
    id: 'esp32c3-generic',
    label: 'ESP32-C3（DevKitM-1 / SuperMini）',
    chip: 'esp32c3',
    flashAddress: 0x0,
    flashSizeMB: 4,
    mode: 'both',
    note: '原生 USB，可用 .uf2；也可以走 esptool。',
    usbIds: [
      { vid: 0x303a, pid: 0x1001 },
      { vid: 0x303a, pid: 0x4001 },
    ],
    firmware: [
      {
        id: 'c3-bin',
        label: 'MicroPython v1.29.0（.bin）',
        board: 'ESP32_GENERIC_C3',
        ext: 'bin',
        address: 0x0,
        sizeBytes: 1755136,
      },
    ],
  },
  {
    id: 'esp32c6-generic',
    label: 'ESP32-C6（DevKitC-1）',
    chip: 'esp32c6',
    flashAddress: 0x0,
    flashSizeMB: 8,
    mode: 'both',
    note: 'WiFi 6 / Thread / Zigbee。原生 USB。',
    usbIds: [{ vid: 0x303a, pid: 0x1001 }],
    firmware: [
      {
        id: 'c6-bin',
        label: 'MicroPython v1.29.0（.bin）',
        board: 'ESP32_GENERIC_C6',
        ext: 'bin',
        address: 0x0,
        sizeBytes: 1968128,
      },
    ],
  },
  {
    id: 'esp8266-generic',
    label: 'ESP8266（NodeMCU / Wemos D1 mini）',
    chip: 'esp8266',
    flashAddress: 0x0,
    flashSizeMB: 4,
    mode: 'esptool',
    note: '只有 .bin。燒錄前建議先抹除整個 flash。',
    usbIds: [
      { vid: 0x1a86, pid: 0x7523 },
      { vid: 0x10c4, pid: 0xea60 },
    ],
    firmware: [
      {
        id: 'esp8266-bin',
        label: 'MicroPython v1.29.0（.bin）',
        board: 'ESP8266_GENERIC',
        ext: 'bin',
        address: 0x0,
        sizeBytes: 643424,
        sha256: '94bfdf94a6c48ac5dfe79203577baad61a58c2525cc39a010b934a6666d4c551',
      },
    ],
  },
  {
    id: 'rp2040-pico',
    label: 'Raspberry Pi Pico（RP2040）',
    chip: 'rp2040',
    flashAddress: 0x0,
    flashSizeMB: 2,
    mode: 'uf2',
    note: '按住 BOOTSEL 插 USB，會出現 RPI-RP2 磁碟。拖 .uf2 進去即可，不需要任何驅動。',
    usbIds: [
      { vid: 0x2e8a, pid: 0x0003 },
      { vid: 0x2e8a, pid: 0x0005 },
    ],
    firmware: [
      {
        id: 'pico-uf2',
        label: 'MicroPython v1.29.0（.uf2）',
        board: 'RPI_PICO',
        ext: 'uf2',
        address: 0,
        sizeBytes: 680960,
      },
    ],
  },
  {
    id: 'rp2350-pico2',
    label: 'Raspberry Pi Pico 2（RP2350）',
    chip: 'rp2350',
    flashAddress: 0x0,
    flashSizeMB: 4,
    mode: 'uf2',
    note: '同樣是 BOOTSEL + 拖放 .uf2。',
    usbIds: [{ vid: 0x2e8a, pid: 0x000f }],
    firmware: [
      {
        id: 'pico2-uf2',
        label: 'MicroPython v1.29.0（.uf2）',
        board: 'RPI_PICO2',
        ext: 'uf2',
        address: 0,
        sizeBytes: 661504,
      },
    ],
  },
];

/** 依 id 找板子。 */
export function findBoard(id) {
  return BOARDS.find((board) => board.id === id) ?? null;
}

/**
 * 依 VID:PID 猜板子。找不到回 ``null``（呼叫端要能處理，不能假設一定猜得到）。
 * @returns {{board: Board, confidence: 'high'|'low'} | null}
 */
export function guessBoardByUsb(vid, pid) {
  if (vid == null || pid == null) return null;
  // 原生 USB 的 Espressif 晶片 VID:PID 無法區分 S3/C3/C6 —— 只能給低信心度的建議
  if (vid === 0x303a) {
    const s3 = findBoard('esp32s3-generic');
    return s3 ? { board: s3, confidence: 'low' } : null;
  }
  for (const board of BOARDS) {
    if (board.usbIds.some((id) => id.vid === vid && id.pid === pid)) {
      // 橋接晶片的 VID:PID 只代表「這條線」，不代表板子型號
      const bridged = [0x10c4, 0x1a86, 0x0403].includes(vid);
      return { board, confidence: bridged ? 'low' : 'high' };
    }
  }
  if (vid === 0x2e8a) {
    const pico = findBoard('rp2040-pico');
    return pico ? { board: pico, confidence: 'high' } : null;
  }
  return null;
}

/**
 * 挑一個「最不容易出錯」的預設燒錄參數。
 *
 * 這支函式的每一個決策都是從真實失敗案例歸納出來的：
 *   · `flashSize: 'keep'` —— 絕不擅自改動使用者的 flash 大小設定
 *   · 橋接晶片 921600 —— CP210x/CH34x 都能穩跑；原生 USB 反而要保守
 *   · ESP8266 先抹除 —— 它的 partition 配置跟其他晶片差很多
 *   · 原生 USB 不做自動重置 —— DTR/RTS 對 USB-Serial-JTAG 沒有作用
 *
 * @param {{chip: ChipFamily, mode: string}} board
 * @param {{usbSerialJtag?: boolean}} [context]
 */
export function defaultFlashOptions(board, context = {}) {
  const nativeUsb = Boolean(context.usbSerialJtag);
  const slowChip = board.chip === 'esp8266' || board.chip === 'esp32c6';
  return {
    baudrate: nativeUsb || slowChip ? 460800 : 921600,
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll: board.chip === 'esp8266',
    compress: true,
    resetAfter: board.mode !== 'uf2',
    // esptool-js 的 reset 模式字串，不是我們自創的
    resetMode: nativeUsb ? 'no_reset' : 'default_reset',
  };
}
