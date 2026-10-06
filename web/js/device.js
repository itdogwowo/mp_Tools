/**
 * 裝置工作階段 —— 每個已連接的裝置一個實例。
 *
 * ══ 為什麼現在就用「陣列」而不是單一裝置 ══════════════════════════════
 *
 * 目前 UI 只支援一個裝置，但**底層刻意寫成 N 個**。
 * 理由：Web Serial 的單一 reader 限制、收尾順序、進度歸屬這些事情，
 * 寫成單數會把「裝置」這個概念散落在各處；之後要改成多裝置就是重寫而不是擴充。
 *
 * 用陣列 + 每裝置獨立的 session，多裝置只是「遍歷 sessions」而已。
 *
 * ══ 每個 session 擁有什麼 ═════════════════════════════════════════════
 *
 *   SerialPort（原始物件，**不開** —— 由 esptool 開，見 serial.js 的說明）
 *   自己的 esptool Transport 與 ESPLoader
 *   自己的進度、日誌、狀態
 *   自己的「我是誰」—— 從裝置讀回來的名稱
 *
 * **不要讓兩個 session 共用任何可變的東西。** esptool-js 本身沒有模組層級
 * 狀態（已查證：頂層 let/var = 0），所以多實例是安全的 —— 前提是我們自己
 * 不要把狀態提到模組層級。
 */

import { Transport } from '../vendor/esptool-js.bundle.js';
import { describePort, explainOpenFailure } from './serial.js';

/** 裝置連線狀態。UI 直接吃這個。 */
export const DeviceState = {
  IDLE: 'idle',                 // 已取得埠，尚未開啟
  CONNECTING: 'connecting',     // esptool 正在同步
  READY: 'ready',               // 已認出晶片
  BUSY: 'busy',                 // 燒錄中
  ERROR: 'error',
};

let nextSessionId = 1;

/**
 * 一個裝置。生命週期由呼叫端管理：
 *
 *   const device = new DeviceSession(describedPort);
 *   await device.probe();        // 開啟 + 認晶片（可選）
 *   await device.flash(...);     // 燒錄（內部會自己開、自己關）
 *   await device.release();      // 一定要呼叫
 */
export class DeviceSession {
  /**
   * @param {ReturnType<typeof describePort>} described
   */
  constructor(described) {
    /** 穩定的識別碼。**不要用埠號** —— 裝置重置後埠號會變。 */
    this.id = `dev${nextSessionId++}`;
    this.described = described;
    this.port = described.port;

    this.state = DeviceState.IDLE;
    this.chip = null;
    /** 從裝置讀回來的名稱（`/mpt_id.py`）。分辨同型號板子唯一的可靠辦法。 */
    this.name = null;
    this.mac = null;
    this.flashSizeBytes = null;

    this.progress = { percent: 0, written: 0, total: 0, filePercent: 0, bytesPerSecond: 0, etaSeconds: null };
    this.logs = [];
    this.failure = null;
    this.phase = 'idle';

    this._transport = null;
    this._loader = null;
    this._released = false;
    /** @type {Set<(event: object) => void>} */
    this._listeners = new Set();
  }

  // ── 事件 ────────────────────────────────────────────────────────────

  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this._listeners) {
      try {
        listener({ deviceId: this.id, ...event });
      } catch (error) {
        console.error('[device] 事件處理器丟出錯誤', error);
      }
    }
  }

  log(level, message) {
    if (!message) return;
    const entry = { level, message, at: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit({ type: 'log', ...entry });
  }

  get label() {
    return this.name || this.described.label;
  }

  get usbId() {
    return this.described.usbId;
  }

  /**
   * 這個裝置要怎麼被認出來？（UI 顯示用）
   * 有名字就用名字，沒有就誠實說「同型號的裝置無法從瀏覽器分辨」。
   */
  get identity() {
    if (this.name) return { kind: 'named', text: this.name, reliable: true };
    if (this.mac) return { kind: 'mac', text: `MAC ${this.mac}`, reliable: true };
    return {
      kind: 'usb',
      text: `${this.usbId}（同型號裝置無法從瀏覽器分辨）`,
      reliable: false,
    };
  }

  // ── 取得 / 釋放 ─────────────────────────────────────────────────────

  /**
   * 建立 Transport。**刻意不呼叫 port.open()** —— esptool 的 connect() 會開，
   * 而且 ESPLoader 內部還會自己 disconnect → connect 來換 baud rate。
   * 我們先開的話就會撞 "The port is already open"。
   *
   * @param {typeof import('../vendor/esptool-js.bundle.js').ESPLoader} ESPLoader
   * @param {{baudrate?: number, terminal?: object, trace?: boolean}} [options]
   */
  createLoader(ESPLoader, options = {}) {
    if (this._loader) return this._loader;
    this._transport = new Transport(this.port, Boolean(options.trace));
    this._loader = new ESPLoader({
      transport: this._transport,
      baudrate: options.baudrate ?? 921600,
      terminal: options.terminal ?? { clean() {}, writeLine() {}, write() {} },
      debugLogging: false,
    });
    return this._loader;
  }

  get loader() {
    return this._loader;
  }

  /**
   * 收尾。**一定要呼叫，而且要放在 finally 裡。**
   *
   * `Transport.disconnect()` 會取消 reader、等 unlock、關掉埠。
   * 少了這一步，這個 origin 之後就再也開不起這個埠（`The port is already open`）。
   */
  async release() {
    if (this._released) return;
    this._released = true;
    const transport = this._transport;
    this._transport = null;
    this._loader = null;

    if (transport) {
      try {
        await transport.disconnect();
      } catch (error) {
        console.warn('[device] transport.disconnect 失敗（仍繼續釋放）', error);
      }
      try {
        await transport.waitForUnlock?.(1500);
      } catch (error) {
        console.warn('[device] waitForUnlock 逾時', error);
      }
    } else {
      // 沒有 Transport（例如診斷失敗就中斷了）—— 直接關埠
      try {
        if (this.port.readable || this.port.writable) await this.port.close();
      } catch {
        /* 已經關了 */
      }
    }
    this.state = DeviceState.IDLE;
    this.emit({ type: 'released' });
  }

  // ── 認出這是什麼裝置 ────────────────────────────────────────────────

  /**
   * 嘗試用 esptool 連線並讀出晶片資訊。
   *
   * **失敗是正常的** —— 裝置可能正在跑 MicroPython 而不是在 bootloader。
   * 呼叫端要能處理 `ok: false`，並接著跑 `diagnose.js` 的診斷。
   *
   * @param {{resetMode?: string, baudrate?: number}} [options]
   */
  async probe(ESPLoader, options = {}) {
    this.state = DeviceState.CONNECTING;
    this.emit({ type: 'state', state: this.state });
    try {
      const loader = this.createLoader(ESPLoader, {
        baudrate: options.baudrate,
        terminal: this._terminal(),
      });
      const chip = await loader.main(options.resetMode ?? 'default_reset');
      this.chip = chip;
      this.state = DeviceState.READY;
      this.log('ok', `偵測到 ${chip}`);
      // chip_id 在 ESP32-S3 上不存在，esptool 會退回讀 MAC
      try {
        const mac = await loader.chip?.getMac?.();
        if (mac) this.mac = String(mac).toLowerCase();
      } catch {
        /* 不是每個晶片都支援，失敗不影響 */
      }
      this.emit({ type: 'state', state: this.state, chip });
      return { ok: true, chip };
    } catch (error) {
      this.state = DeviceState.ERROR;
      const explained = explainOpenFailure(error, this.described.label);
      this.failure = { title: explained.title, detail: String(error?.message || error) };
      this.log('error', String(error?.message || error));
      this.emit({ type: 'state', state: this.state, error });
      return { ok: false, error };
    }
  }

  /** esptool 的輸出接到這個裝置自己的日誌。**不要吞掉** —— 那是唯一的診斷資訊。 */
  _terminal() {
    return {
      clean: () => {},
      writeLine: (line) => this.log('info', String(line)),
      write: (chunk) => this.log('info', String(chunk).replace(/\n+$/, '')),
    };
  }

  toJSON() {
    return {
      id: this.id,
      usbId: this.usbId,
      label: this.label,
      state: this.state,
      chip: this.chip,
      name: this.name,
      mac: this.mac,
      identity: this.identity,
      progress: this.progress,
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   裝置登記表
   ──────────────────────────────────────────────────────────────────────
   目前 UI 只用一個，但介面是清單。多裝置時 UI 改成遍歷這個清單即可。
   ══════════════════════════════════════════════════════════════════════ */
export class DeviceRegistry {
  constructor() {
    /** @type {DeviceSession[]} */
    this.devices = [];
    this._listeners = new Set();
  }

  get size() {
    return this.devices.length;
  }

  /** 目前作用中的裝置（UI 只有一個時就是它）。 */
  get active() {
    return this.devices[0] ?? null;
  }

  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[registry] 事件處理器丟出錯誤', error);
      }
    }
  }

  /**
   * 加入一個裝置。**同一個 SerialPort 不會被加入兩次** —— 重複加入會導致
   * 兩個 session 搶同一個埠，那是 "already open" 的經典成因。
   */
  add(described) {
    const existing = this.devices.find((device) => device.port === described.port);
    if (existing) {
      console.warn('[registry] 這個埠已經在登記表裡了，回傳現有的 session');
      return existing;
    }
    const device = new DeviceSession(described);
    device.on((event) => this._notify(event));
    this.devices.push(device);
    this._notify({ type: 'added', deviceId: device.id, device: device.toJSON() });
    return device;
  }

  remove(deviceId) {
    const index = this.devices.findIndex((device) => device.id === deviceId);
    if (index === -1) return null;
    const [device] = this.devices.splice(index, 1);
    this._notify({ type: 'removed', deviceId: device.id });
    return device;
  }

  byId(deviceId) {
    return this.devices.find((device) => device.id === deviceId) ?? null;
  }

  /** 全部釋放。頁面卸載與「緊急釋放」按鈕用。 */
  async releaseAll() {
    const all = [...this.devices];
    this.devices = [];
    for (const device of all) {
      try {
        await device.release();
      } catch (error) {
        console.warn('[registry] 釋放裝置失敗', error);
      }
    }
    this._notify({ type: 'cleared' });
    return all.length;
  }
}
