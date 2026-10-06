/**
 * 序列埠存取層 —— 純 Web Serial / WebUSB，零本機依賴。
 *
 * ══ 最重要的一條規則：這一層**不准開啟序列埠** ════════════════════════
 *
 * 這個檔案原本會在挑完埠之後呼叫 `port.open()`，然後把已經開好的埠交給
 * esptool-js。那會炸：
 *
 *     Failed to execute 'open' on 'SerialPort': The port is already open.
 *
 * 原因在 esptool-js 的 `Transport`：它的 `connect()` 會**無條件**呼叫
 * `device.open()`，沒有先檢查埠的狀態；而且 `ESPLoader` 內部還會透過
 * `changeBaudrate()` 自己 `disconnect()` → 再 `connect()`。
 * 所以「先開好再交出去」一定會撞。
 *
 * 正確做法：這一層只負責**挑埠與描述埠**，把原始的 SerialPort 交出去，
 * 由 esptool 完全擁有它。收尾一律走 `Transport.disconnect()`
 * （它最後會呼叫 `device.close()`）。
 *
 * ══ 第二條規則：錯誤訊息要能照著做 ═══════════════════════════════════
 * Web Serial 的錯誤訊息對使用者完全沒有幫助：
 *   埠被別的程序佔用 → `Failed to open serial port`（不會說是被佔用）
 *   沒有使用者手勢   → `SecurityError`
 *   使用者取消選擇   → `NotFoundError`
 *   拔線             → 讀取回 undefined，不丟錯
 * `explainOpenFailure()` 就是為了把這些翻成可行動的指示。
 */

import { Transport } from '../vendor/esptool-js.bundle.js';

const KNOWN_USB = [
  { vid: 0x303a, pid: 0x4001, label: 'Espressif USB-Serial-JTAG（ESP32-S3 原生 USB）' },
  { vid: 0x303a, pid: 0x1001, label: 'Espressif USB-Serial-JTAG（ESP32-S2/C3/C6 原生 USB）' },
  { vid: 0x10c4, pid: 0xea60, label: 'Silicon Labs CP2102/CP2104' },
  { vid: 0x10c4, pid: 0xea70, label: 'Silicon Labs CP2105' },
  { vid: 0x1a86, pid: 0x7523, label: 'WCH CH340' },
  { vid: 0x1a86, pid: 0x55d4, label: 'WCH CH9102' },
  { vid: 0x0403, pid: 0x6001, label: 'FTDI FT232R' },
  { vid: 0x2e8a, pid: 0x0003, label: 'RP2040 BOOTSEL（UF2 磁碟）' },
  { vid: 0x2e8a, pid: 0x000f, label: 'RP2350 BOOTSEL（UF2 磁碟）' },
];

/** 橋接晶片：DTR/RTS 自動重置有效。原生 USB 則不一定。 */
const BRIDGE_VIDS = new Set([0x10c4, 0x1a86, 0x0403]);

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, '0');

export function describeUsb(vid, pid) {
  if (vid == null || pid == null) return { label: '未知裝置', isNativeUsb: false, isBridge: false };
  const known = KNOWN_USB.find((entry) => entry.vid === vid && entry.pid === pid);
  return {
    label: known ? known.label : `未知 USB 裝置 ${hex4(vid)}:${hex4(pid)}`,
    isNativeUsb: vid === 0x303a || vid === 0x2e8a,
    isBridge: BRIDGE_VIDS.has(vid),
  };
}

/** 把 SerialPort 變成一個純資料物件（不含任何開啟狀態）。 */
export function describePort(port) {
  let info = {};
  try {
    info = port.getInfo ? port.getInfo() : {};
  } catch {
    info = {};
  }
  const usb = describeUsb(info.usbVendorId ?? null, info.usbProductId ?? null);
  return {
    port,
    vid: info.usbVendorId ?? null,
    pid: info.usbProductId ?? null,
    usbId:
      info.usbVendorId != null
        ? `${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}`
        : '—',
    label: usb.label,
    isNativeUsb: usb.isNativeUsb,
    isBridge: usb.isBridge,
  };
}

/** 瀏覽器能力。UI 應該在**使用者按下去之前**就顯示這個結果。 */
export function capabilities() {
  const hasSerial = typeof navigator !== 'undefined' && 'serial' in navigator;
  const secure = typeof window !== 'undefined' ? window.isSecureContext : false;
  return {
    hasSerial,
    hasUsb: typeof navigator !== 'undefined' && 'usb' in navigator,
    secure,
    usable: hasSerial && secure,
    reason: !hasSerial
      ? '這個瀏覽器沒有 Web Serial。請用 Chrome / Edge 89+ 或 Chrome for Android 61+。'
      : !secure
        ? 'Web Serial 只能在安全來源使用（https:// 或 http://localhost）。'
        : '',
  };
}

/** 已經被授權過的埠。**不需要使用者手勢**，所以「重新連線」可以是一個按鈕。 */
export async function getAuthorizedPorts() {
  if (!capabilities().hasSerial) return [];
  try {
    const ports = await navigator.serial.getPorts();
    return ports.map(describePort);
  } catch (error) {
    console.warn('[serial] getPorts 失敗', error);
    return [];
  }
}

export class SerialAccessError extends Error {
  constructor(message, kind = 'unknown', cause) {
    super(message);
    this.name = 'SerialAccessError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * 跳出瀏覽器的挑埠對話框。**必須在使用者手勢中呼叫。**
 *
 * 這是純網頁版最大的體驗限制：**沒有辦法列出所有 COM port**。
 * 使用者看到的是作業系統原生的對話框，裡面只有「USB Serial Device (COM27)」
 * 這種沒有辨識度的名稱。想看到「ESP32-S3」就必須用本機服務。
 *
 * @returns {Promise<ReturnType<typeof describePort> | null>} 使用者取消時回 null
 */
export async function requestPort(options = {}) {
  const caps = capabilities();
  if (!caps.usable) throw new SerialAccessError(caps.reason, 'unsupported');
  try {
    const port = options.filters?.length
      ? await navigator.serial.requestPort({ filters: options.filters })
      : await navigator.serial.requestPort();
    return describePort(port);
  } catch (error) {
    if (error?.name === 'NotFoundError') return null; // 使用者按取消，不是錯誤
    if (error?.name === 'SecurityError') {
      throw new SerialAccessError(
        '瀏覽器拒絕了這個操作。請確認是在點擊按鈕之後才呼叫 requestPort()。',
        'security',
      );
    }
    throw new SerialAccessError(`挑選序列埠失敗：${error?.message || error}`, 'unknown', error);
  }
}

/**
 * 把瀏覽器丟出來的原始錯誤翻成人看得懂、而且能照著做的訊息。
 * 這是這個檔案存在的理由。
 */
export function explainOpenFailure(error, portLabel = '這個序列埠') {
  const name = error?.name || '';
  const message = String(error?.message || error || '');

  // 這個錯誤是我們自己造成的（重複開埠），不是使用者的問題 —— 要說清楚。
  if (/already open/i.test(message)) {
    return {
      kind: 'already-open',
      title: '序列埠已經開著',
      detail:
        '這個頁面裡的某個連線還沒放開這個埠。這通常發生在燒錄被中斷之後。',
      actions: [
        '按「重新連線並重試」—— 它會先把舊的連線收乾淨',
        '還是不行就重新整理這個頁面（F5）',
        '最後手段：拔掉 USB 再插一次',
      ],
    };
  }
  if (name === 'InvalidStateError') {
    return {
      kind: 'busy',
      title: '序列埠正被使用中',
      detail: `${portLabel}已經被這個頁面或其他程式開著。`,
      actions: ['先按「中斷」釋放它', '關掉其他佔用它的程式（VS Code 的 Serial Monitor、Thonny、Arduino IDE）'],
    };
  }
  if (name === 'NetworkError' || /failed to open|access denied|permission/i.test(message)) {
    return {
      kind: 'busy',
      title: '無法開啟序列埠',
      detail:
        `${portLabel}開不起來。最常見的原因是**它正被別的程序佔用** —— ` +
        'Windows 的序列埠是獨佔的，不能同時被兩個程式開著。',
      actions: [
        '關掉 VS Code 的 Serial Monitor / ESP-IDF monitor',
        '關掉 Thonny、Arduino IDE、PuTTY 等任何開著這個埠的程式',
        '只留一個分頁開著這個工具',
        '還是不行就拔掉 USB 再插一次',
      ],
    };
  }
  if (name === 'NotFoundError') {
    return {
      kind: 'unplugged',
      title: '找不到裝置',
      detail: '裝置可能已經被拔掉，或是驅動沒有載入。',
      actions: ['重新插上 USB', 'Windows 需要 CP210x / CH34x 驅動（可用 .uf2 路徑繞過）', '按「重新連線」再挑一次'],
    };
  }
  return {
    kind: 'unknown',
    title: '開啟序列埠失敗',
    detail: message || '瀏覽器沒有提供更多資訊。',
    actions: ['拔掉 USB 再插一次', '換一個 USB 埠（避開 USB 3.0 集線器）', '換一條有資料線的 USB 線'],
  };
}

/* ══════════════════════════════════════════════════════════════════════
   開埠登記表
   ──────────────────────────────────────────────────────────────────────
   Web Serial 沒有「這個埠現在開著嗎」的查詢 API，而重複開埠的錯誤
   （already open）非常難從訊息回推原因。所以我們自己記。
   ══════════════════════════════════════════════════════════════════════ */

/** @type {Map<SerialPort, {transport: any, openedAt: number}>} */
const OPEN_PORTS = new Map();

export function isPortTracked(port) {
  return OPEN_PORTS.has(port);
}

export function trackedPortCount() {
  return OPEN_PORTS.size;
}

/**
 * 一個燒錄工作階段 —— **由 esptool-js 完全擁有序列埠**。
 *
 * 生命週期：
 *   acquire(port)          → 建 Transport（**不開埠**）
 *   loader                 → 交給 ESPLoader 使用
 *   release()              → Transport.disconnect()（它會關掉埠）→ 解除登記
 *
 * `release()` 一定要被呼叫，而且要在 finally 裡。沒做的話：
 *   1. 這個 origin 之後再也開不起這個埠
 *   2. 使用者會看到 "The port is already open"
 */
export class FlashSession {
  /** @param {ReturnType<typeof describePort>} described */
  constructor(described) {
    this.described = described;
    this.port = described.port;
    this.transport = null;
    this.released = false;
  }

  /**
   * 建立 Transport。**刻意不呼叫 port.open()** —— esptool 的 connect() 會開。
   * @param {{trace?: boolean}} [options]
   */
  acquire(options = {}) {
    if (this.transport) return this.transport;
    if (OPEN_PORTS.has(this.port)) {
      // 前一次沒有收乾淨。先盡力清掉，再繼續。
      console.warn('[serial] 這個埠還在登記表裡，先強制釋放');
      this.forceReleaseTracked();
    }
    this.transport = new Transport(this.port, Boolean(options.trace));
    OPEN_PORTS.set(this.port, { transport: this.transport, openedAt: Date.now() });
    return this.transport;
  }

  /** 丟掉登記表裡的參照（不碰硬體）。只有確定埠已經被關掉時才可用。 */
  forceReleaseTracked() {
    OPEN_PORTS.delete(this.port);
  }

  /**
   * 收尾。**必須呼叫。**
   *
   * `Transport.disconnect()` 做三件事：取消 reader、等 unlock、`device.close()`。
   * 我們**不要**自己再呼叫一次 `port.close()` —— 重複關閉會丟錯，而且會蓋掉
   * 真正的錯誤原因。
   */
  async release() {
    if (this.released) return;
    this.released = true;
    const transport = this.transport;
    this.transport = null;
    if (!transport) {
      OPEN_PORTS.delete(this.port);
      return;
    }
    try {
      await transport.disconnect();
    } catch (error) {
      console.warn('[serial] transport.disconnect 失敗（仍會解除登記）', error);
    }
    try {
      await transport.waitForUnlock?.(1500);
    } catch (error) {
      console.warn('[serial] waitForUnlock 逾時', error);
    }
    OPEN_PORTS.delete(this.port);
  }
}

/**
 * 緊急清理：把登記表裡所有連線都收掉。
 * 給「重新連線」與頁面卸載時使用。
 */
export async function releaseAllSessions() {
  const entries = [...OPEN_PORTS.entries()];
  OPEN_PORTS.clear();
  for (const [port, entry] of entries) {
    try {
      await entry.transport?.disconnect?.();
    } catch (error) {
      console.warn('[serial] 緊急清理失敗', error);
    }
    // disconnect() 應該已經關掉了；這裡只是最後一道保險
    try {
      if (port.readable || port.writable) await port.close();
    } catch {
      /* 已經關了就忽略 */
    }
  }
  return entries.length;
}

// 頁面關閉時盡力收乾淨（不保證執行，但成本很低）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    releaseAllSessions();
  });
}

/**
 * 便利函式：取得一個可以燒錄的埠（必要時跳對話框）。
 * 回傳的是 **尚未開啟** 的 FlashSession。
 *
 * 會先嘗試「已授權的埠」—— 那不需要使用者手勢，所以「重試」可以是純按鈕操作。
 */
export async function acquirePort(options = {}) {
  await releaseAllSessions(); // 先把上一次的收乾淨，避免 already open

  let described = null;
  const authorized = await getAuthorizedPorts();
  if (options.reuseAuthorized !== false) {
    if (authorized.length === 1) described = authorized[0];
    else if (authorized.length > 1 && options.preferredUsbId) {
      described = authorized.find((entry) => entry.usbId === options.preferredUsbId) ?? null;
    }
  }
  if (!described) {
    described = await requestPort({ filters: options.filters });
  }
  if (!described) return null; // 使用者取消

  const session = new FlashSession(described);
  session.acquire({ trace: options.trace });
  return session;
}

/** 監聽「插上 / 拔掉」事件。 */
export function watchPortEvents(handlers = {}) {
  if (!capabilities().hasSerial) return () => {};
  const onConnect = (event) => handlers.onConnect?.(describePort(event.port));
  const onDisconnect = (event) => handlers.onDisconnect?.(describePort(event.port));
  navigator.serial.addEventListener('connect', onConnect);
  navigator.serial.addEventListener('disconnect', onDisconnect);
  return () => {
    navigator.serial.removeEventListener('connect', onConnect);
    navigator.serial.removeEventListener('disconnect', onDisconnect);
  };
}
