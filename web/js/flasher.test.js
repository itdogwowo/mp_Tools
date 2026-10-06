/**
 * flasher.js 的單元測試 —— 直接用 Node 內建的 test runner，零 npm 依賴。
 *
 *     node --test web/js/flasher.test.js
 *
 * 這裡測的是**順序與決策**，不是「能不能真的燒進晶片」（那需要硬體）。
 * 燒錄最常見的災難都是順序問題：
 *   · 忘了在最後放開序列埠 → 拔插之後這個 origin 再也開不起那個埠
 *   · 抹除排在寫入之後     → 抹掉剛寫好的固件
 *   · 重置失敗就當成燒錄失敗 → 明明成功了卻叫使用者重試
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FlashError,
  ProgressAggregator,
  explainFlashFailure,
  formatBytes,
  formatRate,
  runFlash,
} from './flasher.js';
import { BOARDS, defaultFlashOptions, findBoard, guessBoardByUsb, micropythonUrl } from './catalog.js';

/** 記錄呼叫順序的假 loader。 */
function makeLoader(overrides = {}) {
  const calls = [];
  const loader = {
    calls,
    async main(mode) {
      calls.push(['main', mode]);
      if (overrides.mainThrows) throw overrides.mainThrows;
      return overrides.chip ?? 'ESP32-S3';
    },
    async eraseFlash() {
      calls.push(['eraseFlash']);
      if (overrides.eraseThrows) throw overrides.eraseThrows;
    },
    async writeFlash(options) {
      calls.push(['writeFlash', options]);
      if (overrides.writeThrows) throw overrides.writeThrows;
      // 模擬 esptool 對每個檔案逐段回報進度
      const files = options.fileArray;
      for (let index = 0; index < files.length; index += 1) {
        const size = files[index].data.length;
        options.reportProgress(index, Math.floor(size / 2), size);
        options.reportProgress(index, size, size);
      }
    },
    async after(mode) {
      calls.push(['after', mode]);
      if (overrides.afterThrows) throw overrides.afterThrows;
    },
  };
  return loader;
}

const sampleFiles = [
  { name: 'firmware.bin', data: new Uint8Array(1000), address: 0x0 },
];

test('呼叫順序必須是 main → eraseFlash → writeFlash → after', async () => {
  const loader = makeLoader();
  const result = await runFlash({ loader, files: sampleFiles, eraseAll: true });

  assert.equal(result.ok, true);
  assert.deepEqual(
    loader.calls.map((call) => call[0]),
    ['main', 'eraseFlash', 'writeFlash', 'after'],
  );
});

test('writeFlash 內部的 eraseAll 必須是 false —— 抹除已經在外面做過了', async () => {
  const loader = makeLoader();
  await runFlash({ loader, files: sampleFiles, eraseAll: true });

  const writeCall = loader.calls.find((call) => call[0] === 'writeFlash');
  assert.equal(
    writeCall[1].eraseAll,
    false,
    'eraseAll 傳 true 會讓 esptool 在寫入前再抹一次，等於抹掉剛寫的內容',
  );
});

test('沒有勾選抹除時，不應該呼叫 eraseFlash', async () => {
  const loader = makeLoader();
  await runFlash({ loader, files: sampleFiles, eraseAll: false });
  assert.equal(loader.calls.some((call) => call[0] === 'eraseFlash'), false);
});

test('flashSize 預設是 keep —— 絕不擅自改動使用者的 flash 設定', async () => {
  const loader = makeLoader();
  await runFlash({ loader, files: sampleFiles });

  const writeCall = loader.calls.find((call) => call[0] === 'writeFlash');
  assert.equal(writeCall[1].flashSize, 'keep');
  assert.equal(writeCall[1].flashMode, 'keep');
  assert.equal(writeCall[1].flashFreq, 'keep');
});

test('resetAfter: false 時不應該重置裝置', async () => {
  const loader = makeLoader();
  await runFlash({ loader, files: sampleFiles, resetAfter: false });
  assert.equal(loader.calls.some((call) => call[0] === 'after'), false);
});

test('no_reset 模式在收尾時要改用 hard_reset（否則裝置不會開始跑新固件）', async () => {
  const loader = makeLoader();
  await runFlash({ loader, files: sampleFiles, resetMode: 'no_reset', resetAfter: true });

  const afterCall = loader.calls.find((call) => call[0] === 'after');
  assert.equal(afterCall[1], 'hard_reset');
});

test('重置失敗不算燒錄失敗 —— 固件已經寫進去了', async () => {
  const loader = makeLoader({ afterThrows: new Error('RTS pin not supported') });
  const events = [];
  const result = await runFlash({
    loader,
    files: sampleFiles,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true, '重置失敗不該讓整場燒錄被判定為失敗');
  assert.ok(
    events.some((event) => event.type === 'log' && event.level === 'warn'),
    '應該有警告告訴使用者手動按 RESET',
  );
});

test('連線失敗要給出「按住 BOOT」這種可行動的建議', async () => {
  const loader = makeLoader({ mainThrows: new Error('Failed to connect to ESP32: No serial data received.') });
  const events = [];
  const result = await runFlash({
    loader,
    files: sampleFiles,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.phase, 'connecting');
  const failed = events.find((event) => event.type === 'failed');
  assert.ok(failed, '應該發出 failed 事件');
  assert.ok(
    failed.advice.some((line) => /BOOT/.test(line)),
    '建議裡必須提到 BOOT 鍵 —— 這是新手最需要的一行',
  );
});

test('寫入失敗要建議降低 baud rate，並說明裝置不會變磚', async () => {
  const loader = makeLoader({ writeThrows: new Error('Failed to write to target flash (invalid head of packet)') });
  const events = [];
  await runFlash({ loader, files: sampleFiles, baudrate: 921600, onEvent: (event) => events.push(event) });

  const failed = events.find((event) => event.type === 'failed');
  assert.ok(failed.advice.some((line) => /baud/i.test(line)));
  assert.ok(failed.advice.some((line) => /變磚|重試/.test(line)));
});

test('取消會中止流程，且不會發 failed 事件（取消不是錯誤）', async () => {
  let cancelled = false;
  const loader = makeLoader();
  const events = [];
  const originalWrite = loader.writeFlash.bind(loader);
  loader.writeFlash = async (options) => {
    cancelled = true;
    return originalWrite(options);
  };

  const result = await runFlash({
    loader,
    files: sampleFiles,
    isCancelled: () => cancelled,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(
    events.some((event) => event.type === 'failed'),
    false,
    '使用者自己按的取消不該顯示成錯誤',
  );
});

test('進度事件會合成出跨檔案的整體百分比', async () => {
  const loader = makeLoader();
  const events = [];
  await runFlash({
    loader,
    files: [
      { name: 'bootloader.bin', data: new Uint8Array(1000), address: 0x0 },
      { name: 'app.bin', data: new Uint8Array(3000), address: 0x10000 },
    ],
    onEvent: (event) => events.push(event),
  });

  const last = events.filter((event) => event.type === 'progress').at(-1);
  assert.equal(last.percent, 100);
  assert.equal(last.total, 4000);
});

test('ProgressAggregator 依檔案大小加權，不是簡單平均', () => {
  const aggregator = new ProgressAggregator([
    { name: 'small', size: 100 },
    { name: 'big', size: 900 },
  ]);
  // 小檔寫完 → 只應該有 10%，不是 50%
  const progress = aggregator.update(0, 100);
  assert.equal(progress.percent, 10);
});

test('plan 事件會先告訴 UI 有哪些檔案與總大小', async () => {
  const loader = makeLoader();
  const events = [];
  await runFlash({ loader, files: sampleFiles, onEvent: (event) => events.push(event) });

  const plan = events.find((event) => event.type === 'plan');
  assert.ok(plan, 'UI 需要 plan 才能先畫出 Flash Map');
  assert.equal(plan.totalBytes, 1000);
  assert.equal(plan.files[0].name, 'firmware.bin');
});

// ── catalog ────────────────────────────────────────────────────────────

test('每個板子的燒錄位址都是 0x0（單一映像）', () => {
  for (const board of BOARDS) {
    assert.equal(board.flashAddress, 0x0, `${board.id} 的位址應該是 0x0`);
  }
});

test('micropythonUrl 產生已驗證過的 URL 格式', () => {
  assert.equal(
    micropythonUrl('ESP32_GENERIC_S3', 'v1.29.0', '20260824', 'bin'),
    'https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin',
  );
});

test('ESP8266 預設要抹除，其他晶片不要', () => {
  assert.equal(defaultFlashOptions(findBoard('esp8266-generic')).eraseAll, true);
  assert.equal(defaultFlashOptions(findBoard('esp32s3-generic')).eraseAll, false);
});

test('原生 USB 的晶片要用 no_reset 與較保守的 baud rate', () => {
  const options = defaultFlashOptions(findBoard('esp32s3-generic'), { usbSerialJtag: true });
  assert.equal(options.resetMode, 'no_reset');
  assert.equal(options.baudrate, 460800);

  const bridge = defaultFlashOptions(findBoard('esp32s3-generic'), { usbSerialJtag: false });
  assert.equal(bridge.resetMode, 'default_reset');
  assert.equal(bridge.baudrate, 921600);
});

test('橋接晶片的 VID:PID 只能給低信心度的猜測', () => {
  const viaCh340 = guessBoardByUsb(0x1a86, 0x7523);
  assert.equal(viaCh340.confidence, 'low', 'CH340 只代表這條線，不代表板子型號');

  const nativeS3 = guessBoardByUsb(0x303a, 0x4001);
  assert.equal(nativeS3.confidence, 'low', 'Espressif 原生 USB 無法區分 S3/C3/C6');

  assert.equal(guessBoardByUsb(0xffff, 0xffff), null, '認不出來就要回 null，不能亂猜');
});

// ── 格式化 ─────────────────────────────────────────────────────────────

test('formatBytes 對各種大小都給出可讀的結果', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1783808), '1.70 MB');
  assert.equal(formatBytes(undefined), '—');
});

test('formatRate 不會因為除以零而爆掉', () => {
  assert.equal(formatRate(0), '—');
  assert.equal(formatRate(Infinity), '—');
  assert.equal(formatRate(2_100_000), '2.00 MB/s');
});
