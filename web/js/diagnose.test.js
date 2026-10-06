/**
 * diagnose.js 的單元測試 —— Node 內建 runner，零 npm。
 *
 *     node web/js/diagnose.test.js
 *
 * 這些測試的內容全部來自一次真實的除錯經驗（ESP32-S3 原生 USB）：
 *
 *     按住 BOOT 重試 → 失敗
 *     降低 baud rate → 失敗
 *     換 USB 線      → 失敗
 *
 * 真正的原因是裝置正在跑 MicroPython，而 USB-Serial-JTAG 沒有自動重置電路。
 * 這些測試就是在守「能不能正確認出這個狀態」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBootloaderAdvice, guessFirmwareVariant, looksLikeMicroPython } from './diagnose.js';

// 實際從板子上抓到的位元組（COM27，ESP32-S3，Octal-SPIRAM）
const REAL_BANNER =
  '\r\nMicroPython b4e7797d10-dirty on 2026-10-06; ' +
  'Generic ESP32S3 module with Octal-SPIRAM with ESP32-S3\r\n' +
  'Type "help()" for more information.\r\n>>> ';

const REAL_CTRL_C = '\r\n>>> \r\n>>> ';

test('認得出真實的 MicroPython banner', () => {
  const result = looksLikeMicroPython(REAL_BANNER);
  assert.equal(result.running, true);
  assert.equal(result.version, 'b4e7797d10-dirty (2026-10-06)');
  assert.match(result.variant, /Octal-SPIRAM/);
});

test('認得出只有提示字元的情況（Ctrl-C 之後）', () => {
  const result = looksLikeMicroPython(REAL_CTRL_C);
  assert.equal(result.running, true, '>>> 提示字元就足以判斷裝置在跑 MicroPython');
});

test('認得出 CircuitPython', () => {
  const result = looksLikeMicroPython(
    'Adafruit CircuitPython 9.2.1 on 2024-11-20; Adafruit Feather ESP32-S3 with ESP32S3\r\n>>> ',
  );
  assert.equal(result.running, true);
  assert.equal(result.version, '9.2.1 (2024-11-20)');
});

test('不會把純噪音誤判成 MicroPython', () => {
  // 這是 esptool 連不上時實際收到的東西
  const noise = new Uint8Array([0x08, 0x00, 0xff, 0x12, 0x08, 0x00]);
  const result = looksLikeMicroPython(noise);
  assert.equal(result.running, false);
  assert.equal(result.version, null);
});

test('不會把空回應誤判成 MicroPython', () => {
  assert.equal(looksLikeMicroPython(new Uint8Array(0)).running, false);
  assert.equal(looksLikeMicroPython('').running, false);
});

// ── 固件變體判斷 ───────────────────────────────────────────────────────

test('Octal-SPIRAM 的板子要選 SPIRAM_OCT 變體', () => {
  // 這一條很重要：燒標準版映像會認不到完整的 RAM
  assert.equal(
    guessFirmwareVariant('Generic ESP32S3 module with Octal-SPIRAM with ESP32-S3'),
    'SPIRAM_OCT',
  );
  assert.equal(guessFirmwareVariant('ESP32-S3 with Octal SPI RAM'), 'SPIRAM_OCT');
});

test('一般 SPIRAM / PSRAM 要選 SPIRAM 變體', () => {
  assert.equal(guessFirmwareVariant('Generic ESP32S3 module with SPIRAM'), 'SPIRAM');
  assert.equal(guessFirmwareVariant('ESP32 module with PSRAM'), 'SPIRAM');
});

test('沒有 SPIRAM 的板子回 null（不要亂加變體）', () => {
  assert.equal(guessFirmwareVariant('Generic ESP32S3 module with ESP32-S3'), null);
  assert.equal(guessFirmwareVariant(null), null);
  assert.equal(guessFirmwareVariant(''), null);
});

// ── 指示文字 ───────────────────────────────────────────────────────────

test('USB-JTAG 的指示要指向 reset mode，而不是斷言硬體做不到', () => {
  // ══ 這一條原本守的是錯的規格 ═════════════════════════════════════════
  //
  // 第一版寫的是「沒有自動重置電路，一定要手動按 BOOT」。**那是錯的。**
  // 讀 esptool-js 的 constructResetSequence() 之後發現它有專門的
  // UsbJtagSerialReset 策略，只要 VID:PID 是 303A:1001 就會自動使用。
  //
  // 真正的問題是我們自己送了 `no_reset`（回傳空序列）。
  // 所以指示應該指向 reset mode，手動按 BOOT 是**備案**。
  const text = buildBootloaderAdvice(null, { usbJtag: true }).join('\n');
  assert.match(text, /UsbJtagSerialReset|USB-Serial-JTAG/, '要說明正確的機制');
  assert.match(text, /no_reset/, '要指出真正的兇手是 no_reset');
  assert.match(text, /usb_reset/, '要給出正確的值');
  assert.match(text, /備案/, '手動進 bootloader 應該是備案而不是唯一的路');
  assert.ok(!/沒有自動重置電路/.test(text), '不該再斷言硬體做不到（那是錯的）');
});

test('手動進 bootloader 的步驟仍然要清楚（備案用）', () => {
  const text = buildBootloaderAdvice().join('\n');
  assert.match(text, /BOOT/, '一定要提到 BOOT 鍵');
  assert.match(text, /RESET/, '一定要提到 RESET 鍵');
  assert.match(text, /拔掉再插上|拔掉再插/, '沒有 RESET 鍵的板子需要替代方案');
  assert.match(text, /可能換一個名字|換一個名字/, '要提醒埠號會變 —— 實測 COM27 → COM26');
});

test('偵測到 Octal-SPIRAM 時要提醒選對變體', () => {
  const advice = buildBootloaderAdvice('SPIRAM_OCT').join('\n');
  assert.match(advice, /SPIRAM_OCT/);
  assert.match(advice, /認不到完整的 RAM/);
});

test('每一種情況都要告訴使用者「你可能根本不需要燒錄」', () => {
  // 這是整個診斷最重要的產出：實際案例中裝置已經在跑 MicroPython 了
  for (const variant of [null, 'SPIRAM', 'SPIRAM_OCT']) {
    const text = buildBootloaderAdvice(variant).join('\n');
    assert.match(text, /不需要燒錄/, `variant=${variant} 時缺少「不需要燒錄」的提示`);
  }
});
