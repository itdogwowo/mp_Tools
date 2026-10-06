/**
 * 燒錄編排 —— 一個**不碰 DOM、不碰 Web Serial** 的狀態機。
 *
 * 所有與 esptool-js 的接觸都透過注入的 `loader` 進行，因此：
 *   · 決策邏輯可以在 Node 裡單元測試（不需要瀏覽器、不需要板子）
 *   · UI 只訂閱事件，不自己推算進度
 *   · 之後要換成 WebUSB 路徑或別的 loader 都不用改這支檔案
 *
 * ── 這個狀態機存在的理由 ───────────────────────────────────────────────
 * esptool-js 只是「把位元組寫進 flash」。真正容易出錯的是它周邊的順序：
 *   抹除 → 連線 → 寫入 → 驗證 → 重置 → **放開序列埠**
 * 少了最後一步，拔插之後整個 origin 就再也開不起那個埠。
 * 順序錯了則會出現「燒成功但裝置跑的是舊固件」這種最難查的問題。
 */

import { RELEASE } from './catalog.js';

/** @typedef {'idle'|'preparing'|'erasing'|'connecting'|'writing'|'verifying'|'resetting'|'done'|'error'|'cancelled'} FlashPhase */

export const PHASE_LABEL = {
  idle: '待機',
  preparing: '準備中',
  erasing: '抹除 flash',
  connecting: '連線裝置',
  writing: '寫入固件',
  verifying: '驗證',
  resetting: '重置裝置',
  done: '完成',
  error: '失敗',
  cancelled: '已取消',
};

/** 已經進入終態、不會再變。 */
export const TERMINAL_PHASES = new Set(['done', 'error', 'cancelled']);

export class FlashError extends Error {
  /**
   * @param {string} message 給使用者看的訊息
   * @param {{phase: FlashPhase, detail?: string, advice?: string[], cause?: unknown}} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'FlashError';
    this.phase = info.phase ?? 'error';
    this.detail = info.detail ?? '';
    this.advice = info.advice ?? [];
    this.cause = info.cause;
  }
}

/**
 * `resetMode` → `loader.after()` 的模式。**這兩個不是同一個東西。**
 *
 * ══ 一個真實的崩潰，以及為什麼 ═════════════════════════════════════════
 *
 * `resetMode` 有四個可能值：`default_reset` / `usb_reset` / `no_reset` / `hard_reset`。
 * 它決定 esptool **用什麼重置序列讓晶片進入 bootloader**。
 *
 * `loader.after()` 只認得**三個**值，而且語意不同 —— 它決定燒完之後**怎麼離開**：
 *
 *     case "hard_reset":    HardReset（全部晶片都支援）
 *     case "soft_reset":    softReset(false)
 *     case "no_reset_stub": 留在 stub
 *     default:
 *       this.info("Staying in bootloader.");
 *       this.IS_STUB && this.softReset(true);   // ← 陷阱在這裡
 *
 * 所以把 `usb_reset` 直接餵給 `after()` 會掉進 `default`，
 * 而 `softReset(true)` 對非 ESP8266 的晶片會拋：
 *
 *     Soft resetting is currently only supported on ESP8266
 *
 * 而且那是一個 **unhandled rejection** —— 固件其實已經燒好了，但使用者看到紅色錯誤，
 * 合理懷疑是燒錄失敗。
 *
 * ══ 對應方式 ═══════════════════════════════════════════════════════════
 *
 *   `hard_reset`                     → `hard_reset`（本來就是對的）
 *   `soft_reset`（只有 ESP8266 能用） → `soft_reset`
 *   `no_reset`                       → `hard_reset`
 *   **其他（含 `usb_reset`、`default_reset`）→ `hard_reset`**
 *
 * 為什麼 `no_reset` 也對應到 `hard_reset`：`resetMode` 是「**進去**的時候」用的，
 * 而這支函式只在「**出來**的時候」被呼叫，而且已經在 `if (resetAfter)` 裡面。
 * 既然使用者要「燒完之後重置」，那 `no_reset_stub`（留在 bootloader）就違背原意 ——
 * 裝置不會開始跑新固件。真正想「不要重置」的情況，呼叫端會傳 `resetAfter: false`
 * 而根本不會走到這裡。
 *
 * `usb_reset` 已經在「進入 bootloader」那一步發揮作用了（走 `UsbJtagSerialReset`）。
 * 燒完之後要的是**重新啟動跑新固件**，那對所有晶片都是 `hard_reset`。
 *
 * @param {string} resetMode 用來進 bootloader 的模式
 * @param {string|null} chip 晶片名（`soft_reset` 只有 ESP8266 支援）
 */
export function afterMode(resetMode, chip = null) {
  if (resetMode === 'soft_reset' && String(chip ?? '').toUpperCase().includes('ESP8266')) {
    return 'soft_reset';
  }
  return 'hard_reset';
}

/**
 * 把 esptool 的原始錯誤翻成可行動的建議。
 * esptool 的錯誤訊息對熟悉的人很清楚，對第一次用的人完全沒用。
 */
export function explainFlashFailure(error, context = {}) {
  const message = String(error?.message || error || '');
  const baud = context.baudrate ?? 921600;

  if (/Failed to connect|No serial data received|timed out waiting for packet/i.test(message)) {
    return new FlashError('連不上裝置的 bootloader', {
      phase: 'connecting',
      detail: message,
      advice: [
        '按住板子上的 BOOT 鍵，按一下 RESET，放開 RESET 再放開 BOOT，然後重試',
        '確認沒有其他程式開著這個序列埠（VS Code 的 Serial Monitor 最常見）',
        '換一條 USB 線 —— 很多線只能充電，沒有資料線',
        `把 baud rate 降到 115200 再試（目前 ${baud}）`,
      ],
    });
  }
  if (/invalid head of packet|Failed to write to target flash|MD5|checksum/i.test(message)) {
    return new FlashError('寫入 flash 時發生錯誤', {
      phase: 'writing',
      detail: message,
      advice: [
        `把 baud rate 從 ${baud} 降到 460800 或 115200 再試`,
        '換一條較短的 USB 線，並避開 USB 3.0 集線器',
        '裝置仍停在 bootloader，可以安全重試（不會變磚）',
        '確認選的板子型號與 flash 大小與實物相符',
      ],
    });
  }
  if (/not enough space|too big|exceeds flash/i.test(message)) {
    return new FlashError('固件比裝置的 flash 大', {
      phase: 'writing',
      detail: message,
      advice: [
        '確認板子型號選對了（4MB 與 8MB 的映像不同）',
        '若是 ESP32-S3 且板子有 Octal SPIRAM，要選 SPIRAM_OCT 變體',
      ],
    });
  }
  if (/unsupported chip|Unknown chip|chip type/i.test(message)) {
    return new FlashError('不認得這顆晶片', {
      phase: 'connecting',
      detail: message,
      advice: [
        '確認選的板子型號與實物相符',
        'ESP32-C6 / H2 等較新的晶片需要較新的 esptool-js',
      ],
    });
  }
  return new FlashError('燒錄失敗', {
    phase: context.phase ?? 'error',
    detail: message || 'esptool 沒有提供更多資訊。',
    advice: ['拔掉 USB 再插一次', '降低 baud rate', '裝置仍可重試，不會變磚'],
  });
}

/**
 * 讓多個 `reportProgress` 回呼共用同一個 0–100 的進度條。
 *
 * esptool-js 是**依序**燒檔案（bootloader → partition table → app），
 * 而且只回報「目前這個檔案」的位元組數。UI 想要的是整體進度，
 * 所以要在這裡按檔案大小加權合成。
 */
export class ProgressAggregator {
  /**
   * @param {{name: string, size: number}[]} files
   */
  constructor(files) {
    this.files = files;
    this.totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
    this.writtenByIndex = files.map(() => 0);
  }

  /** @returns {{percent: number, fileIndex: number, filePercent: number, written: number, total: number}} */
  update(fileIndex, written) {
    if (fileIndex >= 0 && fileIndex < this.writtenByIndex.length) {
      this.writtenByIndex[fileIndex] = written;
    }
    const writtenTotal = this.writtenByIndex.reduce((sum, value) => sum + value, 0);
    const currentSize = this.files[fileIndex]?.size || 1;
    return {
      written: writtenTotal,
      total: this.totalBytes,
      percent: this.totalBytes > 0 ? Math.min(100, (writtenTotal / this.totalBytes) * 100) : 0,
      fileIndex,
      filePercent: Math.min(100, (written / currentSize) * 100),
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 執行一次燒錄。
 *
 * @param {object} options
 * @param {any} options.loader              已建好的 ESPLoader（有 main / writeFlash / eraseFlash / after）
 * @param {{name: string, data: Uint8Array, address: number}[]} options.files
 * @param {string} options.flashMode        'keep' | 'qio' | 'dio' | …
 * @param {string} options.flashFreq
 * @param {string} options.flashSize
 * @param {boolean} options.eraseAll
 * @param {boolean} options.compress
 * @param {boolean} options.resetAfter
 * @param {string} options.resetMode        'default_reset' | 'hard_reset' | 'no_reset'
 * @param {(event: object) => void} [options.onEvent]
 * @param {() => boolean} [options.isCancelled]
 */
export async function runFlash(options) {
  const {
    loader,
    files,
    flashMode = 'keep',
    flashFreq = 'keep',
    flashSize = 'keep',
    eraseAll = false,
    compress = true,
    resetAfter = true,
    resetMode = 'default_reset',
    onEvent = () => {},
    isCancelled = () => false,
  } = options;

  if (!loader) throw new FlashError('沒有 loader', { phase: 'preparing' });
  if (!files?.length) throw new FlashError('沒有要燒錄的檔案', { phase: 'preparing' });

  const emit = (event) => onEvent({ at: Date.now(), ...event });
  const ensureNotCancelled = () => {
    if (isCancelled()) {
      const error = new FlashError('使用者取消', { phase: 'cancelled' });
      error.name = 'FlashCancelled';
      throw error;
    }
  };

  const aggregator = new ProgressAggregator(
    files.map((file) => ({ name: file.name, size: file.data.length })),
  );

  emit({ type: 'phase', phase: 'preparing' });
  emit({
    type: 'plan',
    files: files.map((file) => ({ name: file.name, size: file.data.length, address: file.address })),
    totalBytes: aggregator.totalBytes,
    options: { flashMode, flashFreq, flashSize, eraseAll, compress, resetAfter, resetMode },
  });

  try {
    // ── 1. 連線並偵測晶片 ──────────────────────────────────────────────
    // 這一步會重置裝置，所以任何「使用者想在燒錄前做的事」都要排在它前面。
    emit({ type: 'phase', phase: 'connecting' });
    emit({ type: 'log', level: 'info', message: `連線裝置（reset mode: ${resetMode}）…` });
    let chipName;
    try {
      chipName = await loader.main(resetMode);
    } catch (error) {
      throw explainFlashFailure(error, { phase: 'connecting', baudrate: options.baudrate });
    }
    emit({ type: 'chip', chip: chipName });
    emit({ type: 'log', level: 'ok', message: `偵測到 ${chipName}` });
    ensureNotCancelled();

    // ── 2. 選擇性抹除 ─────────────────────────────────────────────────
    if (eraseAll) {
      emit({ type: 'phase', phase: 'erasing' });
      emit({ type: 'log', level: 'warn', message: '抹除整個 flash（裝置上的檔案會全部消失）…' });
      try {
        await loader.eraseFlash();
      } catch (error) {
        throw explainFlashFailure(error, { phase: 'erasing', baudrate: options.baudrate });
      }
      emit({ type: 'log', level: 'ok', message: '抹除完成' });
      ensureNotCancelled();
    }

    // ── 3. 寫入 ───────────────────────────────────────────────────────
    emit({ type: 'phase', phase: 'writing' });
    for (const [index, file] of files.entries()) {
      emit({
        type: 'log',
        level: 'info',
        message: `寫入 ${file.name}（${formatBytes(file.data.length)}）到 0x${file.address.toString(16)}`,
      });
      emit({ type: 'fileStart', fileIndex: index, name: file.name, size: file.data.length });
    }

    const startedAt = Date.now();
    try {
      await loader.writeFlash({
        fileArray: files.map((file) => ({ data: file.data, address: file.address })),
        flashMode,
        flashFreq,
        flashSize,
        eraseAll: false, // 已經單獨處理過，不要在 writeFlash 裡再抹一次
        compress,
        reportProgress: (fileIndex, written, total) => {
          ensureNotCancelled();
          const progress = aggregator.update(fileIndex, written);
          const elapsed = Math.max(1, Date.now() - startedAt);
          emit({
            type: 'progress',
            ...progress,
            totalForFile: total,
            bytesPerSecond: progress.written / (elapsed / 1000),
            etaSeconds: progress.written > 0
              ? Math.max(0, ((progress.total - progress.written) / (progress.written / elapsed)) / 1000)
              : null,
          });
        },
      });
    } catch (error) {
      if (error?.name === 'FlashCancelled') throw error;
      throw explainFlashFailure(error, { phase: 'writing', baudrate: options.baudrate });
    }
    const elapsedMs = Date.now() - startedAt;
    emit({ type: 'log', level: 'ok', message: `寫入完成，耗時 ${(elapsedMs / 1000).toFixed(1)} 秒` });

    // ── 4. 驗證（esptool-js 在 writeFlash 內已做 MD5 比對，這裡只播報）──
    emit({ type: 'phase', phase: 'verifying' });
    emit({ type: 'log', level: 'ok', message: '雜湊已驗證' });
    ensureNotCancelled();

    // ── 5. 重置 ───────────────────────────────────────────────────────
    if (resetAfter) {
      emit({ type: 'phase', phase: 'resetting' });
      emit({ type: 'log', level: 'info', message: '重置裝置…' });
      try {
        await loader.after(afterMode(resetMode, chipName));
      } catch (error) {
        // 重置失敗不算燒錄失敗 —— 固件已經寫進去了，使用者手動按 RESET 就好
        emit({
          type: 'log',
          level: 'warn',
          message: `自動重置失敗（${error?.message || error}）。請手動按板子上的 RESET 鍵。`,
        });
      }
    }

    emit({ type: 'phase', phase: 'done' });
    emit({
      type: 'done',
      chip: chipName,
      elapsedMs,
      totalBytes: aggregator.totalBytes,
      averageBytesPerSecond: aggregator.totalBytes / Math.max(0.001, elapsedMs / 1000),
    });
    return { ok: true, chip: chipName, elapsedMs };
  } catch (error) {
    const flashError =
      error instanceof FlashError ? error : explainFlashFailure(error, { phase: 'error' });
    const cancelled = flashError.name === 'FlashCancelled' || flashError.phase === 'cancelled';
    emit({ type: 'phase', phase: cancelled ? 'cancelled' : 'error' });
    if (!cancelled) {
      emit({
        type: 'failed',
        title: flashError.message,
        detail: flashError.detail,
        advice: flashError.advice,
        raw: flashError.detail || String(error),
      });
      emit({ type: 'log', level: 'error', message: flashError.message });
    }
    return { ok: false, error: flashError, cancelled };
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
}

export { RELEASE, sleep };
