/**
 * esptool 燒錄策略（`.bin`）。
 *
 * 把 `flasher.js` 的狀態機接到 `DeviceSession` 上。
 * 職責分工：
 *
 *   flasher.js      純狀態機 —— 順序、進度合成、錯誤翻譯（可在 Node 測）
 *   device.js       一個裝置的所有權與生命週期
 *   esptool.js      **這個檔案** —— 把兩者接起來，並處理埠的取得與釋放
 *
 * ══ 埠的擁有權（這個檔案最容易寫錯的地方）═════════════════════════════
 *
 * **esptool 完全擁有序列埠。** 我們只負責：
 *   1. 拿到一個**尚未開啟**的 SerialPort
 *   2. 建 Transport 交給 ESPLoader
 *   3. 收尾時呼叫 `transport.disconnect()`（它最後會 close 埠）
 *
 * 不要自己 `port.open()`、也不要自己 `port.close()`。兩者都會炸：
 *   · 先開 → `Transport.connect()` 無條件再開一次 → "The port is already open"
 *   · 自己關 → 重複 close 丟錯，而且會蓋掉真正的錯誤原因
 * （見 docs/WEB-ARCHITECTURE.md 第 6.2 節）
 */

import { runFlash } from '../flasher.js';
import { acquirePort, explainOpenFailure } from '../serial.js';

/**
 * @param {object} options
 * @param {import('../device.js').DeviceSession} options.device
 * @param {typeof import('../../vendor/esptool-js.bundle.js').ESPLoader} options.ESPLoader
 * @param {{name: string, data: Uint8Array, address: number}} options.firmware
 * @param {object} options.settings          baudrate / resetMode / eraseAll …
 * @param {(event: object) => void} [options.onEvent]
 * @param {() => boolean} [options.isCancelled]
 */
export async function runEsptoolFlash(options) {
  const { device, ESPLoader, firmware, settings, onEvent = () => {}, isCancelled = () => false } = options;

  const emit = (event) => onEvent(event);
  let acquiredHere = false;

  try {
    // ── 1. 取得序列埠 ─────────────────────────────────────────────────
    // 如果 device 還沒有埠（例如使用者直接按「燒錄」而沒先連線），在這裡要。
    if (!device.portOpenRequested) {
      emit({ type: 'phase', phase: 'preparing' });
      emit({ type: 'log', level: 'info', message: '正在取得序列埠…' });
      // acquirePort 內部會先釋放殘留連線，所以不會撞 already open
      const session = await acquirePort({ preferredUsbId: device.usbId, reuseAuthorized: true });
      if (!session) {
        emit({
          type: 'failed',
          title: '沒有選擇序列埠',
          detail: '使用者取消了裝置選擇。',
          advice: ['再按一次「燒錄」，然後在對話框裡選你的開發板'],
        });
        return { ok: false, cancelled: true };
      }
      device.port = session.port;
      device.described = session.described;
      device.portOpenRequested = true;
      acquiredHere = true;
    }

    // ── 2. 建 loader（**不開埠**）────────────────────────────────────
    const loader = device.createLoader(ESPLoader, {
      baudrate: settings.baudrate,
      terminal: {
        clean: () => {},
        writeLine: (line) => emit({ type: 'log', level: 'info', message: String(line) }),
        write: (chunk) => emit({ type: 'log', level: 'info', message: String(chunk).replace(/\n+$/, '') }),
      },
    });
    emit({
      type: 'log',
      level: 'info',
      message: `loader 已建立 · baud ${settings.baudrate} · reset mode ${settings.resetMode}`,
    });

    // ── 3. 交給狀態機 ─────────────────────────────────────────────────
    const result = await runFlash({
      loader,
      files: [{ name: firmware.name, data: firmware.data, address: firmware.address ?? 0 }],
      flashMode: 'keep',   // 絕不擅自改動使用者的 flash 設定
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: Boolean(settings.eraseAll),
      compress: true,
      resetAfter: settings.resetAfter !== false,
      resetMode: settings.resetMode || 'default_reset',
      baudrate: settings.baudrate,
      isCancelled,
      onEvent: (event) => {
        emit(event);
        if (event.type === 'progress') device.progress = { ...device.progress, ...event };
        if (event.type === 'chip') device.chip = event.chip;
      },
    });

    if (result.ok) {
      emit({
        type: 'done',
        chip: result.chip || device.chip,
        elapsedMs: result.elapsedMs,
        totalBytes: firmware.data.length,
      });
    } else if (result.cancelled) {
      emit({ type: 'cancelled' });
    } else {
      const error = result.error ?? {};
      emit({
        type: 'failed',
        title: error.message || '燒錄失敗',
        detail: error.detail || '',
        advice: error.advice?.length ? error.advice : ['拔掉 USB 再插一次', '降低 baud rate 再試'],
        needsDiagnosis: /connect|timed out|no serial data/i.test(error.detail || ''),
      });
    }
    return result;
  } catch (error) {
    const explained = explainOpenFailure(error, device.described?.label || '這個序列埠');
    emit({
      type: 'failed',
      title: explained.title,
      detail: explained.detail,
      advice: explained.actions || [],
      needsDiagnosis: explained.kind === 'busy' || explained.kind === 'already-open',
    });
    return { ok: false, error };
  } finally {
    // ── 4. 一定放開埠 ────────────────────────────────────────────────
    // 少了這一步，這個 origin 之後就再也開不起這個埠。
    if (acquiredHere || device.portOpenRequested) {
      await device.release();
      device.portOpenRequested = false;
    }
  }
}

/** 給 UI 用的策略描述。 */
export const EsptoolStrategy = {
  id: 'esptool',
  label: 'esptool（.bin）',
  accepts: ['.bin'],
  /** 需要 Web Serial；原生 USB 與橋接晶片都可，但後者要驅動。 */
  requiresSerial: true,
  description: '走 Web Serial，適用所有 ESP 晶片。橋接晶片（CP210x / CH34x）需要驅動。',
  run: runEsptoolFlash,
};
