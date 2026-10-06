/**
 * 序列埠生命週期的測試 —— Node 內建 runner，零 npm。
 *
 *     node web/js/serial.test.js
 *
 * ══ 為什麼這些行為需要測試 ═════════════════════════════════════════════
 *
 * `serial.js` 管的是**獨佔資源**（序列埠）與**跨次操作的狀態**。
 * 這一類 bug 的症狀都很難查：
 *
 *   · 收尾沒做好 → 下一次操作撞 `The port is already open`，錯誤訊息完全
 *     指不出真正原因
 *   · 把預期情況當錯誤 → console 充滿「已經關了」的警告，真正的問題被埋掉
 *
 * 這裡用**假的 SerialPort**（不需要真硬體），專注測狀態轉移與錯誤分類。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FlashSession, describePort, describeUsb } from './serial.js';

/* ── 測試替身 ───────────────────────────────────────────────────────── */

/**
 * 假的 SerialPort。
 *
 * `behavior` 控制 `close()` 的行為，用來模擬真實世界的三種情況：
 *   'ok'        正常關閉
 *   'closed'    已經關了（USB-JTAG 重置後裝置重新列舉 → 埠自動關閉）
 *   'gone'      裝置被拔掉
 *   'io'        真的 I/O 錯誤（**這個才該印警告**）
 */
function fakePort(behavior = 'ok', info = { usbVendorId: 0x303a, usbProductId: 0x1001 }) {
  const calls = { close: 0, open: 0 };
  return {
    calls,
    // `readable`／`writable` 一律給 truthy —— 那代表「埠是開著的」，
    // 所以 release() 的保險 `close()` 會真的被執行到。
    // 如果給 null，那一步會被跳過，測試就測不到東西。
    readable: {},
    writable: {},
    getInfo: () => info,
    async close() {
      calls.close += 1;
      if (behavior === 'closed') {
        throw Object.assign(
          new Error("Failed to execute 'close' on 'SerialPort': The port is already closed."),
          { name: 'InvalidStateError' },
        );
      }
      if (behavior === 'gone') {
        throw Object.assign(new Error('The device was disconnected.'), { name: 'NotFoundError' });
      }
      if (behavior === 'io') {
        throw Object.assign(new Error('An I/O error occurred.'), { name: 'NetworkError' });
      }
    },
  };
}

/** 假的 Transport，記錄 disconnect / waitForUnlock 有沒有被呼叫。 */
function fakeTransport(disconnectError = null) {
  const calls = { disconnect: 0, waitForUnlock: 0 };
  return {
    calls,
    async disconnect() {
      calls.disconnect += 1;
      if (disconnectError) throw disconnectError;
    },
    async waitForUnlock(ms) {
      calls.waitForUnlock += 1;
      if (disconnectError) throw disconnectError;
      return ms;
    },
  };
}

/**
 * 收集 `console.warn`。
 *
 * ⚠️ **必須是 async 並 await 傳入的 promise。**
 *
 * 第一版寫成同步的：
 *
 *     function captureWarnings(fn) {
 *       const original = console.warn;
 *       console.warn = (...a) => warnings.push(...);
 *       try { return { result: fn(), warnings }; }
 *       finally { console.warn = original; }     // ← 這裡就還原了
 *     }
 *
 * 但 `release()` 是 async，警告在 promise 完成之後才印 —— 那時 `console.warn`
 * 已經被還原，所以測試收到空陣列，看起來像「程式碼沒印警告」。
 *
 * 測試輔助函式本身出錯，會讓測試**說謊**（回報一個不存在的 bug，
 * 或者掩蓋一個真的 bug）。所以這裡要 await。
 */
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

const portAlreadyClosed = () =>
  Object.assign(
    new Error("Failed to execute 'close' on 'SerialPort': The port is already closed."),
    { name: 'InvalidStateError' },
  );

/* ── release() 的正常路徑 ────────────────────────────────────────────── */

test('release() 會呼叫 disconnect 與 waitForUnlock', async () => {
  const port = fakePort('ok');
  const session = new FlashSession(describePort(port));
  const transport = fakeTransport();
  session.transport = transport;

  await session.release();

  assert.equal(transport.calls.disconnect, 1, 'disconnect 必須被呼叫');
  assert.equal(transport.calls.waitForUnlock, 1, 'waitForUnlock 必須被呼叫');
  assert.equal(session.transport, null, 'transport 要放掉');
});

test('release() 是幂等的 —— 呼兩次只做一次事', async () => {
  const port = fakePort('ok');
  const session = new FlashSession(describePort(port));
  const transport = fakeTransport();
  session.transport = transport;

  await session.release();
  await session.release();

  assert.equal(transport.calls.disconnect, 1, '第二次不該再 disconnect');
});

test('transport 為 null 時 release() 不會炸', async () => {
  const session = new FlashSession(describePort(fakePort('ok')));
  await session.release();
  assert.equal(session.released, true);
});

/* ── 「已經關了」不該當成錯誤 ────────────────────────────────────────── */

test('★ 埠已經關了 → 不該印任何警告', async () => {
  // ══ 這是真實使用者回報的雜訊 ═══════════════════════════════════════════
  //
  //     [serial] transport.disconnect 失敗（仍會繼續收尾）
  //     InvalidStateError: Failed to execute 'close' on 'SerialPort':
  //     The port is already closed.
  //
  // USB-Serial-JTAG 的重置序列會讓裝置**重新列舉**，埠在那一刻就自動關了。
  // 我們要的結果（埠是關的）已經達成 —— 那不是失敗。
  const port = fakePort('closed');
  const session = new FlashSession(describePort(port));
  session.transport = fakeTransport(portAlreadyClosed());

  const { warnings } = await captureWarnings(() => session.release());
  assert.deepEqual(warnings, [], `不該有警告，卻得到：${warnings.join(' / ')}`);
});

test('裝置被拔掉（NotFoundError）也不算失敗', async () => {
  const port = fakePort('gone');
  const session = new FlashSession(describePort(port));
  session.transport = fakeTransport(
    Object.assign(new Error('The device was disconnected.'), { name: 'NotFoundError' }),
  );

  const { warnings } = await captureWarnings(() => session.release());
  assert.deepEqual(warnings, [], '拔線是預期情況');
});

test('★ 真正的 I/O 錯誤還是要印警告（不要把所有錯都吞掉）', async () => {
  const port = fakePort('io');
  const session = new FlashSession(describePort(port));
  session.transport = fakeTransport(
    Object.assign(new Error('An I/O error occurred.'), { name: 'NetworkError' }),
  );

  const { warnings } = await captureWarnings(() => session.release());
  assert.ok(warnings.length > 0, '真的 I/O 錯誤必須看得見');
  assert.ok(
    warnings.some((w) => /I\/O error/.test(w)),
    `警告要包含原始訊息，得到：${warnings.join(' / ')}`,
  );
});

test('收尾一律完成，即使 disconnect 拋錯', async () => {
  const port = fakePort('ok');
  const session = new FlashSession(describePort(port));
  session.transport = fakeTransport(Object.assign(new Error('boom'), { name: 'NetworkError' }));

  await captureWarnings(() => session.release());

  // 即使 disconnect 失敗，保險的 port.close() 還是要跑
  assert.equal(port.calls.close, 1, '保險的 close 必須執行');
  assert.equal(session.released, true);
});

/* ── describePort / describeUsb ──────────────────────────────────────── */

test('describePort 認得出 USB-Serial-JTAG', () => {
  const described = describePort(fakePort('ok', { usbVendorId: 0x303a, usbProductId: 0x1001 }));
  assert.equal(described.usbId, '303A:1001');
  assert.equal(described.isNativeUsb, true);
  assert.match(described.label, /USB-Serial-JTAG/);
});

test('describePort 認得出橋接晶片', () => {
  const cp210x = describePort(fakePort('ok', { usbVendorId: 0x10c4, usbProductId: 0xea60 }));
  assert.equal(cp210x.isNativeUsb, false);
  assert.match(cp210x.label, /CP210/);
});

test('describePort 對沒有 getInfo 的埠不會炸', () => {
  const described = describePort({ readable: null, writable: null });
  assert.equal(described.usbId, '—');
  assert.equal(described.vid, null);
});

test('describeUsb 對未知的 VID:PID 給出可讀的標籤，不要留白', () => {
  const unknown = describeUsb(0x1234, 0x5678);
  assert.ok(unknown.label.length > 0, '未知裝置也要有標籤');
  assert.equal(unknown.isNativeUsb, false);
  assert.equal(unknown.isBridge, false);
});

test('describeUsb 對 null 不會炸', () => {
  const none = describeUsb(null, null);
  assert.equal(none.isNativeUsb, false);
  assert.equal(none.isBridge, false);
});
