/**
 * esptool 輸出解析的測試 —— Node 內建 runner，零 npm。
 *
 *     node web/js/catalog.test.js
 *
 * ══ 為什麼這支解析器需要測試 ═══════════════════════════════════════════
 *
 * 裝置面板顯示的 MAC / Features / Flash ID **全部來自這裡**。
 * esptool-js 不把這些東西回傳成物件，只印到 terminal，所以我們只能解析文字。
 *
 * 兩種錯法都很糟：
 *   · 撈不到    → 面板永遠空白，使用者覺得整個工具都是假的
 *   · 撈錯了    → 顯示一個錯的 MAC，而且看起來很合理，根本沒人會發現
 *
 * 測試資料是**真實的 log**（從一塊 ESP32-S3 上抄下來的），不是編的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDeviceFacts,
  defaultFlashOptions,
  findBoard,
  guessBoardByUsb,
  isUsbSerialJtag,
  micropythonUrl,
  parseEsptoolLine,
} from './catalog.js';

/** 真實的 esptool-js 輸出。順序與內容都照抄。 */
const REAL_LOG = [
  'esptool.js',
  'Serial port WebSerial VendorID 0x303a ProductID 0x1001',
  'Connecting...',
  'Detecting chip type... ESP32-S3',
  'Chip Revision: 0',
  'Chip is ESP32-S3 (QFN56) (revision v0.2)',
  'Features: Wi-Fi,BLE,Embedded PSRAM 8MB (AP_3v3)',
  'Crystal is 40MHz',
  'MAC: 58:e6:c5:72:42:24',
  'Uploading stub...',
  'Running stub...',
  'Stub running...',
  'Changing baudrate to 921600',
  'Changed',
  'Flash ID: 184046',
];

function collect(lines) {
  const board = {};
  for (const line of lines) {
    const facts = parseEsptoolLine(line);
    if (facts) applyDeviceFacts(board, facts);
  }
  return board;
}

// ── 從真實 log 撈 ──────────────────────────────────────────────────────

test('從真實的 esptool log 撈出全部五個欄位', () => {
  const board = collect(REAL_LOG);
  assert.equal(board.chip, 'ESP32-S3 (QFN56) (revision v0.2)');
  assert.equal(board.mac, '58:e6:c5:72:42:24');
  assert.equal(board.features, 'Wi-Fi,BLE,Embedded PSRAM 8MB (AP_3v3)');
  assert.equal(board.crystalMHz, 40);
  assert.equal(board.flashId, '184046');
});

test('MAC 一律轉小寫（esptool 有時大寫有時小寫）', () => {
  assert.equal(parseEsptoolLine('MAC: 58:E6:C5:72:42:24').mac, '58:e6:c5:72:42:24');
  assert.equal(parseEsptoolLine('MAC: 58:e6:c5:72:42:24').mac, '58:e6:c5:72:42:24');
});

test('晶片名保留完整字串（含 revision）', () => {
  // `(revision` 是我們分辨「真晶片名」與「佔位字串」的依據，
  // 所以解析時絕對不能把它削掉。
  const facts = parseEsptoolLine('Chip is ESP32-S3 (QFN56) (revision v0.2)');
  assert.match(facts.chip, /\(revision/);
});

// ── 不該誤判 ───────────────────────────────────────────────────────────

test('無關的行一律回 null，不要瞎猜', () => {
  const harmless = [
    'esptool.js',
    'Connecting...',
    'Uploading stub...',
    'Running stub...',
    'Stub running...',
    'Changed',
    'Changing baudrate to 921600',
    'Hard resetting via RTS pin...',
    '',
    null,
    undefined,
  ];
  for (const line of harmless) {
    assert.equal(parseEsptoolLine(line), null, `不該從 ${JSON.stringify(line)} 撈出東西`);
  }
});

test('Features 的開頭不會被誤認成晶片名', () => {
  // `Chip is` 與 `Features:` 是兩條不同的規則，不能互相污染
  const chipOnly = parseEsptoolLine('Chip is ESP32-S3');
  assert.ok(chipOnly.chip, '應該撈到 chip');
  assert.equal(chipOnly.features, undefined, '不該同時撈到 features');
});

test('MAC 格式不對時不要硬撈', () => {
  // 寧可留白，也不要顯示一個編出來的 MAC
  assert.equal(parseEsptoolLine('MAC: not-a-mac'), null);
  assert.equal(parseEsptoolLine('MAC: 58:e6:c5'), null);
  assert.equal(parseEsptoolLine('MAC:'), null);
});

// ── applyDeviceFacts ───────────────────────────────────────────────────

test('applyDeviceFacts 只在真的有變化時回報 changed', () => {
  const board = {};
  assert.equal(applyDeviceFacts(board, { mac: 'aa:bb:cc:dd:ee:ff' }), true, '第一次是變化');
  assert.equal(applyDeviceFacts(board, { mac: 'aa:bb:cc:dd:ee:ff' }), false, '同樣的值不算變化');
  assert.equal(applyDeviceFacts(board, { mac: '11:22:33:44:55:66' }), true, '不同的值是變化');
  assert.equal(applyDeviceFacts(board, null), false, 'null 不該炸');
});

test('applyDeviceFacts 不會覆蓋掉沒撈到的欄位', () => {
  const board = { mac: 'aa:bb:cc:dd:ee:ff', chip: 'ESP32-S3' };
  applyDeviceFacts(board, { crystalMHz: 40 });
  assert.equal(board.mac, 'aa:bb:cc:dd:ee:ff', 'MAC 不該被清掉');
  assert.equal(board.chip, 'ESP32-S3', 'chip 不該被清掉');
  assert.equal(board.crystalMHz, 40, '新的值要寫進去');
});

// ── reset mode（實際踩過的坑，見 flasher.test.js 的詳細說明）────────────

test('原生 USB 用 usb_reset，橋接晶片用 default_reset', () => {
  const usbJtag = defaultFlashOptions(findBoard('esp32s3-generic'), { usbSerialJtag: true });
  assert.equal(usbJtag.resetMode, 'usb_reset');

  const bridge = defaultFlashOptions(findBoard('esp32s3-generic'), { usbSerialJtag: false });
  assert.equal(bridge.resetMode, 'default_reset');
});

test('isUsbSerialJtag 只認 303A:1001', () => {
  assert.equal(isUsbSerialJtag(0x303a, 0x1001), true);
  assert.equal(isUsbSerialJtag(0x303a, 0x4001), false);
  assert.equal(isUsbSerialJtag(0x10c4, 0xea60), false);
  assert.equal(isUsbSerialJtag(undefined, undefined), false);
});

// ── 仍然要守的既有行為 ─────────────────────────────────────────────────

test('micropythonUrl 的格式沒有變', () => {
  assert.equal(
    micropythonUrl('ESP32_GENERIC_S3', 'v1.29.0', '20260824', 'bin'),
    'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin',
  );
});

test('USB 身分猜測：橋接晶片只能給低信心度', () => {
  assert.equal(guessBoardByUsb(0x1a86, 0x7523).confidence, 'low');
  assert.equal(guessBoardByUsb(0x303a, 0x4001).confidence, 'low');
  assert.equal(guessBoardByUsb(0xffff, 0xffff), null);
});
