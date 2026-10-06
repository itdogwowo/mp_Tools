/**
 * UF2 解析與驗證的測試 —— Node 內建 runner，零 npm。
 *
 *     node web/js/flash/uf2.test.js
 *
 * ══ 這些測試存在的理由 ═══════════════════════════════════════════════
 * 拖放 `.uf2` 到 BOOTSEL 磁碟是**沒有任何安全網**的操作：
 *   · 拖錯晶片的檔案 → 板子不開機，而且 bootloader 不會告訴你為什麼
 *   · 下載沒完成    → 同樣不開機
 *   · 檔案損毀      → 同樣不開機
 *
 * 所以驗證必須在拖進去**之前**做完。這些測試就是在守那個驗證。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UF2_BLOCK_SIZE,
  UF2_FAMILIES,
  UF2_MAGIC_END,
  UF2_MAGIC_START0,
  UF2_MAGIC_START1,
  checkUf2AgainstBoard,
  parseUf2,
} from './uf2.js';

/** 造一個合法的 UF2 檔（N 個 block）。 */
function makeUf2({ blocks = 4, familyId = 0xe48bff56, payloadSize = 256, numBlocks = null, corruptBlock = -1 } = {}) {
  const bytes = new Uint8Array(blocks * UF2_BLOCK_SIZE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < blocks; index++) {
    const base = index * UF2_BLOCK_SIZE;
    view.setUint32(base + 0, UF2_MAGIC_START0, true);
    view.setUint32(base + 4, UF2_MAGIC_START1, true);
    view.setUint32(base + 8, 0x00002000, true); // familyID present
    view.setUint32(base + 12, 0x10000000 + index * payloadSize, true); // targetAddr
    view.setUint32(base + 16, payloadSize, true);
    view.setUint32(base + 20, index, true);
    view.setUint32(base + 24, numBlocks ?? blocks, true);
    view.setUint32(base + 28, familyId, true);
    view.setUint32(base + UF2_BLOCK_SIZE - 4, UF2_MAGIC_END, true);
    if (index === corruptBlock) view.setUint32(base + 0, 0xdeadbeef, true);
  }
  return bytes;
}

// ── 正常情況 ───────────────────────────────────────────────────────────

test('解析合法的 RP2040 UF2', () => {
  const parsed = parseUf2(makeUf2({ blocks: 8, familyId: 0xe48bff56 }));
  assert.equal(parsed.ok, true, parsed.problems.join('; '));
  assert.equal(parsed.blocks, 8);
  assert.equal(parsed.family?.id, 'rp2040');
  assert.equal(parsed.payloadBytes, 8 * 256);
  assert.deepEqual(parsed.targetRange, { start: 0x10000000, end: 0x10000000 + 8 * 256 });
});

test('解析 ESP32-S3 的 UF2', () => {
  const parsed = parseUf2(makeUf2({ blocks: 4, familyId: 0x1c5f21b0 }));
  assert.equal(parsed.ok, true, parsed.problems.join('; '));
  assert.equal(parsed.family?.id, 'esp32s3');
});

// ── 擋掉「根本不是 UF2」 ───────────────────────────────────────────────

test('擋掉空檔案（下載沒完成）', () => {
  const parsed = parseUf2(new Uint8Array(0));
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems[0], /空的/);
});

test('擋掉 .bin 之類的錯誤檔案', () => {
  // ESP 的 .bin 開頭是 e9 03 02 2f …
  const bin = new Uint8Array(UF2_BLOCK_SIZE * 2);
  bin.set([0xe9, 0x03, 0x02, 0x2f], 0);
  const parsed = parseUf2(bin);
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /不是 UF2 檔/);
  assert.match(parsed.problems.join(' '), /\.bin/);
});

test('擋掉大小不是 512 整數倍的檔案（下載中斷）', () => {
  const partial = makeUf2({ blocks: 4 }).slice(0, UF2_BLOCK_SIZE * 3 + 137);
  const parsed = parseUf2(partial);
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /不是 512 的整數倍/);
  assert.match(parsed.problems.join(' '), /下載可能沒完成/);
});

test('擋掉比一個 block 還小的檔案', () => {
  const parsed = parseUf2(new Uint8Array(100));
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /比一個 UF2 block 還小/);
});

// ── 擋掉「檔案損毀」 ───────────────────────────────────────────────────

test('偵測檔頭宣告的 block 數與實際不符（截斷）', () => {
  const parsed = parseUf2(makeUf2({ blocks: 4, numBlocks: 100 }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.problems.join(' '), /檔案不完整.*100.*4/s);
});

test('偵測中間某個 block 的魔數壞掉', () => {
  const parsed = parseUf2(makeUf2({ blocks: 8, corruptBlock: 5 }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /第 5 個 block/);
});

test('偵測 block 結尾魔數不對', () => {
  const bytes = makeUf2({ blocks: 2 });
  new DataView(bytes.buffer).setUint32(UF2_BLOCK_SIZE - 4, 0x12345678, true);
  const parsed = parseUf2(bytes);
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /結尾魔數不對/);
});

test('偵測 payloadSize 超過上限', () => {
  const bytes = makeUf2({ blocks: 2 });
  new DataView(bytes.buffer).setUint32(16, 999, true); // 第一個 block 的 payloadSize
  const parsed = parseUf2(bytes);
  assert.equal(parsed.ok, false);
  assert.match(parsed.problems.join(' '), /超過上限 476/);
});

// ── 警告（不阻擋，但要說出來）─────────────────────────────────────────

test('不認得的 family ID 要警告，而不是通過', () => {
  const parsed = parseUf2(makeUf2({ familyId: 0x12345678 }));
  assert.equal(parsed.ok, true, '不認得 family ID 不該直接擋掉（可能是新晶片）');
  assert.match(parsed.warnings.join(' '), /不認得的 family ID 0x12345678/);
  assert.match(parsed.warnings.join(' '), /不開機/);
});

test('混了多種 family ID 要警告', () => {
  const bytes = makeUf2({ blocks: 4 });
  new DataView(bytes.buffer).setUint32(UF2_BLOCK_SIZE + 28, 0xe48bff57, true); // 第二個 block 換 family
  const parsed = parseUf2(bytes);
  assert.match(parsed.warnings.join(' '), /混了 2 種 family ID/);
});

// ── 對照板子 ───────────────────────────────────────────────────────────

const PICO = { id: 'rp2040-pico', label: 'Raspberry Pi Pico', chip: 'rp2040' };
const S3 = { id: 'esp32s3-generic', label: 'ESP32-S3', chip: 'esp32s3' };

test('檔案與板子相符 → ok', () => {
  const parsed = parseUf2(makeUf2({ familyId: 0xe48bff56 }));
  const check = checkUf2AgainstBoard(parsed, PICO);
  assert.equal(check.verdict, 'ok');
});

test('★ 把 Pico 的 uf2 拖進 ESP32-S3 → 必須擋下來', () => {
  // 這是最危險的錯誤：bootloader 不會解釋，板子就是不開機
  const parsed = parseUf2(makeUf2({ familyId: 0xe48bff56 }));
  const check = checkUf2AgainstBoard(parsed, S3);
  assert.equal(check.verdict, 'mismatch');
  assert.match(check.message, /不開機/);
  assert.match(check.message, /RP2040/);
  assert.match(check.message, /esp32s3/);
});

test('★ 把 ESP32-S3 的 uf2 拖進 Pico → 必須擋下來', () => {
  const parsed = parseUf2(makeUf2({ familyId: 0x1c5f21b0 }));
  const check = checkUf2AgainstBoard(parsed, PICO);
  assert.equal(check.verdict, 'mismatch');
  assert.match(check.message, /ESP32-S3/);
});

test('檔案本身有問題時，不要說是晶片不符（別誤導）', () => {
  const parsed = parseUf2(new Uint8Array(100));
  const check = checkUf2AgainstBoard(parsed, PICO);
  assert.match(check.message, /檔案本身有問題/);
});

test('family ID 不認得時要說「無法確認」而不是假裝通過', () => {
  const parsed = parseUf2(makeUf2({ familyId: 0xfeedface }));
  const check = checkUf2AgainstBoard(parsed, S3);
  assert.equal(check.verdict, 'unknown');
  assert.match(check.message, /無法確認/);
  assert.match(check.message, /不開機/);
});

// ── family 表本身 ──────────────────────────────────────────────────────

test('family 表裡每一筆都要有 label 與 boards 陣列', () => {
  for (const [key, value] of Object.entries(UF2_FAMILIES)) {
    assert.ok(value.label, `family ${key} 缺 label`);
    assert.ok(Array.isArray(value.boards), `family ${key} 的 boards 不是陣列`);
    assert.ok(value.id, `family ${key} 缺 id`);
  }
});

test('目錄裡每個 UF2 板子都對應得到一個 family', () => {
  // 避免「catalog 有這塊板子，但 family 表漏了它」→ 使用者會看到無法確認
  const expected = [
    ['rp2040-pico', 'rp2040'],
    ['rp2350-pico2', 'rp2350-arm-s'],
    ['esp32s3-generic', 'esp32s3'],
    ['esp32c3-generic', 'esp32c3'],
    ['esp32c6-generic', 'esp32c6'],
  ];
  const boardIds = Object.values(UF2_FAMILIES).flatMap((family) => family.boards);
  for (const [boardId, familyId] of expected) {
    assert.ok(
      boardIds.includes(boardId),
      `${boardId} 沒有對應的 UF2 family（預期 ${familyId}）`,
    );
  }
});

// ── 效能：大檔不該卡住 UI ──────────────────────────────────────────────

test('大檔（2 MB）可以在合理時間內解析完', () => {
  const big = makeUf2({ blocks: 4096 }); // 4096 * 512 = 2 MB
  const started = Date.now();
  const parsed = parseUf2(big);
  const elapsed = Date.now() - started;
  assert.equal(parsed.ok, true);
  assert.ok(elapsed < 250, `解析花了 ${elapsed}ms，太慢（UI 會卡）`);
});
