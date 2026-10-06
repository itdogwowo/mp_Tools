/**
 * 開燒之前先問裝置：「你現在是什麼狀態？」
 *
 * ══ 為什麼需要這個檔案 ═══════════════════════════════════════════════
 *
 * 實際發生過的案例（ESP32-S3 原生 USB-Serial-JTAG）：
 *
 *     按住 BOOT 重試 → 失敗
 *     降低 baud rate → 失敗
 *     換 USB 線      → 失敗
 *     esptool 只說：Failed to connect with the device
 *
 * 真正的原因是**裝置正在跑 MicroPython，而且它活得好好的**：
 *
 *     Ctrl-C ×2  →  b'\r\n>>> \r\n>>> '
 *     Ctrl-B     →  b'MicroPython 1.30.0-preview ... Octal-SPIRAM ...'
 *
 * USB-Serial-JTAG **沒有自動重置電路** —— 沒有 DTR/RTS 可以拉、沒有 RESET 腳可以踢。
 * 所以 esptool 的 default_reset / usb_reset / no_reset **三種模式都救不了**。
 * 唯一的辦法是使用者手動進 bootloader。
 *
 * 但 esptool 不會告訴使用者這件事。它只會說「連不上」，然後使用者開始
 * 換線、降速、重插 —— 全部都在浪費時間。
 *
 * 這個檔案的工作就是在燒錄失敗之後、把真正的原因問出來。
 */

/** 常見的 MicroPython 開機輸出特徵。用來判斷「裝置在跑 MicroPython」。 */
const MICROPYTHON_MARKERS = [/MicroPython/i, /CircuitPython/i, /^>>>\s*$/m, /Type "help\(\)"/i];

/**
 * 從一段位元組裡判斷裝置是不是在跑 MicroPython / CircuitPython。
 * @param {Uint8Array|string} bytes
 * @returns {{running: boolean, banner: string, version: string|null, variant: string|null}}
 */
export function looksLikeMicroPython(bytes) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes || new Uint8Array());
  const running = MICROPYTHON_MARKERS.some((re) => re.test(text));

  // banner 形如：
  //   MicroPython b4e7797d10-dirty on 2026-10-06; Generic ESP32S3 module with Octal-SPIRAM with ESP32-S3
  const match = text.match(/(MicroPython|CircuitPython)\s+(\S+)\s+on\s+(\S+?);\s*([^\r\n]*)/i);
  const version = match ? `${match[2]} (${match[3]})` : null;
  const variant = match ? match[4].trim() : null;
  return { running, banner: text.trim(), version, variant };
}

/**
 * 從 banner 的變體描述猜出正確的固件變體。
 *
 * 這一條很重要：有 Octal-SPIRAM 的板子燒標準版映像會**開不起來**（或只認到一半的 RAM）。
 * banner 裡的 "Octal-SPIRAM" 是唯一可靠的線索 —— USB VID:PID 看不出來。
 *
 * 比對要寬鬆：各家的寫法不一致，實測至少看過這幾種
 *   "Octal-SPIRAM"、"Octal SPI RAM"、"SPIRAM_OCT"、"with SPIRAM"、"PSRAM"
 * 所以用 `spi[\s_-]?ram` 一次涵蓋 SPIRAM / SPI-RAM / SPI RAM，再往前找 "octal"。
 *
 * @param {string|null} variant  banner 裡的變體描述，例如 "Generic ESP32S3 module with Octal-SPIRAM"
 * @returns {'SPIRAM_OCT'|'SPIRAM'|null}
 */
export function guessFirmwareVariant(variant) {
  if (!variant) return null;
  // 順序很重要：先判斷 oct，否則 "Octal-SPIRAM" 會先被下面的 SPIRAM 規則抓走
  if (/octal[\s_-]*spi[\s_-]?ram|spiram[\s_-]*oct/i.test(variant)) return 'SPIRAM_OCT';
  if (/spi[\s_-]?ram|psram/i.test(variant)) return 'SPIRAM';
  return null;
}

/**
 * 在燒錄失敗之後，判斷「為什麼連不上」。
 *
 * **前提：呼叫端必須先放開序列埠。** 這個函式會回傳一個新的 transport 供它自己使用，
 * 用完也會放開。它刻意不假設埠的狀態。
 *
 * @param {object} options
 * @param {() => Promise<{port: SerialPort, release: () => Promise<void>}>} options.reopen
 *        回傳一個**尚未開啟**的埠；這個函式會自己開、自己關。
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<{verdict: string, microPython: object|null, advice: string[]}>}
 */
export async function diagnoseConnectionFailure({ reopen, onEvent = () => {} }) {
  const emit = (event) => onEvent(event);

  let handle = null;
  try {
    emit({ type: 'log', level: 'info', message: '正在檢查裝置目前跑的是什麼…' });
    handle = await reopen();

    // 直接開埠（低 baud），然後：
    //   1. 先讀看有沒有開機訊息
    //   2. Ctrl-C ×2 → MicroPython 會印出提示字元
    //   3. Ctrl-B    → friendly REPL banner
    const port = handle.port;
    await port.open({ baudRate: 115200, bufferSize: 4096 });

    const readFor = async (ms) => {
      const chunks = [];
      const deadline = Date.now() + ms;
      const reader = port.readable.getReader();
      try {
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const result = await Promise.race([
            reader.read(),
            new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
          ]);
          if (result?.timeout) break;
          if (result?.done) break;
          if (result?.value?.length) chunks.push(result.value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* 已經結束了 */
        }
        reader.releaseLock();
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    };

    const write = async (bytes) => {
      const writer = port.writable.getWriter();
      try {
        await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      } finally {
        writer.releaseLock();
      }
    };

    const first = await readFor(700);
    if (first.length) emit({ type: 'log', level: 'info', message: `開埠後收到 ${first.length} B` });

    await write([0x03, 0x03]); // Ctrl-C ×2：中斷正在跑的程式
    const afterInterrupt = await readFor(700);

    await write([0x02]); // Ctrl-B：進 friendly REPL，它會印出 banner
    const afterBanner = await readFor(900);

    const all = new Uint8Array(first.length + afterInterrupt.length + afterBanner.length);
    all.set(first, 0);
    all.set(afterInterrupt, first.length);
    all.set(afterBanner, first.length + afterInterrupt.length);

    const detected = looksLikeMicroPython(all);
    if (detected.running) {
      const firmwareVariant = guessFirmwareVariant(detected.variant);
      emit({
        type: 'log',
        level: 'warn',
        message: `裝置正在跑 ${detected.version || 'MicroPython'}，所以它不會回應 bootloader 的同步訊號。`,
      });
      return {
        verdict: 'micropython-running',
        microPython: { ...detected, firmwareVariant },
        advice: buildBootloaderAdvice(firmwareVariant),
      };
    }

    emit({ type: 'log', level: 'warn', message: '裝置沒有任何回應，也不是 MicroPython。' });
    return {
      verdict: 'silent',
      microPython: null,
      advice: [
        '裝置完全沒有回應。可能是 USB 線只能充電（沒有資料線），換一條試試',
        '換一個 USB 埠，避開 USB 3.0 集線器',
        '如果是剛插上，等 2 秒再試（USB 列舉還沒完成）',
        'Windows 需要 CP210x / CH34x 驅動；原生 USB 的 ESP32-S3/S2/C3 不需要驅動',
      ],
    };
  } catch (error) {
    emit({ type: 'log', level: 'error', message: `診斷失敗：${error?.message || error}` });
    return {
      verdict: 'unknown',
      microPython: null,
      advice: ['無法診斷（埠開不起來）', '確認沒有其他程式佔用這個序列埠'],
    };
  } finally {
    if (handle) {
      try {
        await handle.release?.();
      } catch {
        /* 盡力而為 */
      }
    }
  }
}

/**
 * 依晶片類型給出「怎麼進 bootloader」的指示。
 *
 * ══ 這段文字修正過一次，原因值得記錄 ═════════════════════════════════
 *
 * 第一版寫的是「USB-Serial-JTAG **沒有自動重置電路**，esptool 無法用 DTR/RTS
 * 把它踢進 bootloader，**一定要手動**」。**那是錯的。**
 *
 * 讀 esptool-js 的 `constructResetSequence()` 之後才發現它有一個專門的
 * `UsbJtagSerialReset` 策略，而且只要 VID:PID 是 303A:1001 就會自動使用：
 *
 *     if (mode === "usb_reset" || isUsbJtagSerialPort())
 *         return [usbJTAGSerialReset(transport)];
 *
 * 真正的問題是**我們自己送了 `no_reset`**，而那個模式回傳空的重置序列。
 * 所以正確的指示是「先確認 reset mode 是 usb_reset」，手動進 bootloader 是**備案**。
 *
 * 教訓：說「硬體做不到」之前，先讀官方實作。
 */
export function buildBootloaderAdvice(firmwareVariant = null, context = {}) {
  const advice = [];

  // 如果我們知道這個埠是 USB-JTAG，就說明正確的機制
  if (context.usbJtag) {
    advice.push(
      '這個埠是 **USB-Serial-JTAG（原生 USB）**。esptool-js 有專門的重置策略 ' +
        '`UsbJtagSerialReset` 會自動處理 —— 前提是 reset mode **不能是 `no_reset`**（那會跳過重置）。',
    );
    advice.push(
      '請確認 reset mode 是 `usb_reset` 或 `default_reset`，然後再試一次。' +
        '這兩者在 USB-JTAG 上都會走同一條正確的路。',
    );
  }

  // 手動進 bootloader 是**備案**，不是唯一的路
  advice.push(
    '如果重試還是不行，手動進 bootloader（這是備案，不是必要步驟）：' +
      '按住 **BOOT** → 按一下 **RESET** → 放開 RESET → 再放開 BOOT',
  );
  advice.push('沒有 RESET 鍵的板子：按住 **BOOT** 不放，把 USB 拔掉再插上，然後放開 BOOT');
  advice.push('進去之後埠可能會換一個名字（例如 COM27 → COM26），要重新選');

  if (firmwareVariant === 'SPIRAM_OCT') {
    advice.push(
      '⚠ 這塊板子是 **Octal-SPIRAM** 版本。要重燒的話請選 `SPIRAM_OCT` 變體的固件，' +
        '燒標準版會認不到完整的 RAM。',
    );
  }

  advice.push('如果你只是想寫程式，**可能根本不需要燒錄** —— 裝置已經在跑 MicroPython 了');
  return advice;
}
