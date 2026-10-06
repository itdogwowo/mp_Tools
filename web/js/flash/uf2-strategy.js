/**
 * UF2 拖放策略。
 *
 * ══ 這是最不容易失敗的燒錄路徑，理由值得寫清楚 ═════════════════════════
 *
 * 它繞過了 `.bin` / esptool 路徑上**三個最容易失敗的環節**：
 *
 *   1. 驅動      —— 拖放不需要驅動。CP210x / CH34x 的驅動問題直接消失。
 *   2. baud rate —— 沒有 baud rate 這回事。USB 大量儲存裝置。
 *   3. 進 bootloader —— 使用者按 BOOT 插 USB，bootloader 自己開一個磁碟。
 *                       不需要 esptool 去「踢」晶片（那正是 ESP32-S3 原生 USB
 *                       永遠做不到的事，見 docs/WEB-ARCHITECTURE.md 第 8 節）。
 *
 * ══ 誠實的限制：瀏覽器不能寫入磁碟 ═════════════════════════════════════
 *
 * 網頁**沒有辦法**把檔案寫進使用者電腦上的隨身碟。File System Access API
 * 需要使用者逐次授權，而且在 `chrome://` 之外的頁面上對「卸除式磁碟」支援很差。
 * WebUSB 理論上可以自己實作 USB Mass Storage + FAT，但那是**幾千行的
 * 底層實作**，換來的只是「少拖一次」。不值得。
 *
 * 所以這條路的 UI 是：**我們把檔案準備好、驗證完、給你下載 + 告訴你拖到哪裡。**
 * 這是可靠的，而且任何瀏覽器都能用。
 */

import { checkUf2AgainstBoard, parseUf2 } from './uf2.js';

/** 不同晶片的 BOOTSEL 磁碟名稱。用來告訴使用者「找哪個磁碟」。 */
export const UF2_DRIVE_HINT = {
  rp2040: 'RPI-RP2',
  'rp2350-arm-s': 'RP2350',
  'rp2350-riscv': 'RP2350',
  'rp2350-arm-ns': 'RP2350',
  esp32s3: 'ESP32-S3',
  esp32s2: 'ESP32-S2',
  esp32c3: 'ESP32-C3',
  esp32c6: 'ESP32-C6',
};

/**
 * 依晶片給出「怎麼讓 BOOTSEL 磁碟出現」的指示。
 *
 * 這段文字必須精準 —— 不同晶片的方式**不一樣**，給錯會讓使用者按半天沒反應。
 */
export function espBootselAdvice(board, family) {
  const chip = board?.chip ?? family?.id ?? '';
  const drive = UF2_DRIVE_HINT[family?.id] ?? '（磁碟名稱依晶片而定）';

  if (chip === 'rp2040' || chip === 'rp2350') {
    return {
      drive,
      steps: [
        '拔掉板子的 USB',
        '**按住 BOOTSEL 鍵不放**',
        '插上 USB（保持按住）',
        `電腦上會出現一個叫 **${drive}** 的磁碟，這時才放開 BOOTSEL`,
        '把剛剛下載的 .uf2 拖進那個磁碟 —— 拖進去就開始燒了',
        '燒完磁碟會自己消失、板子自動重開',
      ],
      note: 'RP2040 / RP2350 不需要任何驅動，也不需要安裝工具。',
    };
  }

  if (chip.startsWith('esp32')) {
    return {
      drive,
      steps: [
        '拔掉板子的 USB',
        '**按住 BOOT 鍵不放**',
        '插上 USB（保持按住）',
        `電腦上會出現一個叫 **${drive}** 的磁碟，這時才放開 BOOT`,
        '把剛剛下載的 .uf2 拖進那個磁碟',
        '燒完磁碟會自己消失、板子自動重開並執行新固件',
      ],
      note:
        '注意：ESP32 系列的 UF2 磁碟**只在原生 USB 的型號上出現**' +
        '（S2 / S3 / C3 / C6 等）。如果你的是 ESP32 或 ESP8266（走 CP2102 / CH340），' +
        '不會有磁碟 —— 那種板子只能走 esptool 路徑。',
    };
  }

  return {
    drive,
    steps: [
      '把板子切到 bootloader 模式（通常是按住 BOOT 再插 USB）',
      `找到出現的 **${drive}** 磁碟`,
      '把 .uf2 拖進去',
    ],
    note: '',
  };
}

/**
 * 準備一個 UF2 檔案：解析、驗證、對照板子。
 *
 * **不做任何寫入。** 它只回傳「這個檔案能不能用」與「要怎麼用」。
 *
 * @param {object} options
 * @param {ArrayBuffer|Uint8Array} options.data
 * @param {string} options.filename
 * @param {{id: string, label: string, chip: string}} options.board
 * @param {(event: object) => void} [options.onEvent]
 */
export async function prepareUf2(options) {
  const { data, filename, board, onEvent = () => {} } = options;
  const emit = (event) => onEvent(event);

  emit({ type: 'phase', phase: 'preparing' });
  emit({ type: 'log', level: 'info', message: `解析 ${filename}…` });

  const parsed = parseUf2(data);

  for (const problem of parsed.problems) {
    emit({ type: 'log', level: 'error', message: `✗ ${problem}` });
  }
  for (const warning of parsed.warnings) {
    emit({ type: 'log', level: 'warn', message: `⚠ ${warning}` });
  }

  if (!parsed.ok) {
    emit({ type: 'phase', phase: 'error' });
    emit({
      type: 'failed',
      title: '這個 .uf2 檔有問題，不要拖進去',
      detail: parsed.problems.join(' '),
      advice: [
        '重新下載一次（下載中斷是最常見的原因）',
        '確認你下載的是 `.uf2` 而不是 `.bin` 或 `.elf`',
        '確認檔案大小與官方頁面上標示的一致',
      ],
    });
    return { ok: false, parsed, verdict: 'mismatch' };
  }

  const check = checkUf2AgainstBoard(parsed, board);
  emit({
    type: 'log',
    level: check.verdict === 'ok' ? 'ok' : check.verdict === 'warn' ? 'warn' : 'error',
    message: check.message,
  });

  if (check.verdict === 'mismatch') {
    emit({ type: 'phase', phase: 'error' });
    emit({
      type: 'failed',
      title: '晶片不符，已阻止',
      detail: check.message,
      advice: [
        `請下載 ${board.label} 專用的固件（不是別塊板子的）`,
        'ESP32 與 RP2040 的 .uf2 完全不能互換 —— 拖錯板子會不開機',
      ],
    });
    return { ok: false, parsed, verdict: 'mismatch', check };
  }

  const advice = espBootselAdvice(board, parsed.family);
  emit({
    type: 'log',
    level: 'info',
    message: `檔案可用：${parsed.blocks} 個 block，${parsed.payloadBytes} bytes 資料，` +
      `family ${parsed.family?.label ?? '未知'}`,
  });

  // UF2 沒有逐位元組的進度可以回報 —— 拖放是一次寫完的。
  // 所以進度只有「還沒拖」與「拖完了」兩種，UI 要靠使用者的確認。
  emit({ type: 'progress', percent: 0, written: 0, total: parsed.payloadBytes });

  emit({
    type: 'ready-to-drag',
    filename,
    parsed: {
      blocks: parsed.blocks,
      payloadBytes: parsed.payloadBytes,
      family: parsed.family,
      targetRange: parsed.targetRange,
    },
    advice,
    verdict: check.verdict,
  });

  return { ok: true, parsed, verdict: check.verdict, advice };
}

/** 給 UI 用的策略描述。 */
export const Uf2Strategy = {
  id: 'uf2',
  label: 'UF2 拖放',
  accepts: ['.uf2'],
  /** **不需要 Web Serial。** 這是它最珍貴的地方 —— 任何瀏覽器都能用。 */
  requiresSerial: false,
  description:
    '把 .uf2 拖進 BOOTSEL 磁碟。不需要驅動、不需要 baud rate、不需要 esptool 踢進 bootloader。',
  prepare: prepareUf2,
};
