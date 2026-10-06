/**
 * 燒錄策略 —— 兩種路徑，同一個介面。
 *
 * ══ 為什麼要有策略層 ═══════════════════════════════════════════════════
 *
 * `.bin` 與 `.uf2` 的燒錄方式**在每一個層面都不一樣**：
 *
 *   |            | .bin / esptool            | .uf2 / 拖放               |
 *   |------------|---------------------------|---------------------------|
 *   | 通訊        | Web Serial（獨佔埠）       | 檔案系統（磁碟）           |
 *   | 需要驅動    | 原生 USB 不用，橋接晶片要   | **完全不用**               |
 *   | 進 bootloader | esptool 自己試（常常失敗）| 使用者按 BOOT 插 USB       |
 *   | 可回報進度  | 可以（位元組層級）         | 不行（拖放一次寫完）       |
 *   | 失敗訊息    | esptool 的（要翻譯）       | 幾乎沒有（板子就不開機）   |
 *   | 適用晶片    | 全部 ESP                  | 原生 USB：S2/S3/C3/C6、RP2040/2350 |
 *
 * 兩條路的介面差這麼多，硬塞進一個函式會變成一團 if。
 * 所以：**各自一個 strategy，共用同一組事件**，UI 只認事件不認策略。
 *
 * ══ 事件契約（兩個策略都必須遵守）══════════════════════════════════════
 *
 *   { type: 'phase',   phase }                     階段改變
 *   { type: 'log',     level, message }            日誌
 *   { type: 'progress', percent, written, total }  進度（uf2 只有 0 與 100）
 *   { type: 'done',    ... }                       成功
 *   { type: 'failed',  title, detail, advice[] }   失敗（**一定要給 advice**）
 */

export { runEsptoolFlash, EsptoolStrategy } from './esptool.js';
export { prepareUf2, Uf2Strategy, espBootselAdvice, UF2_DRIVE_HINT } from './uf2-strategy.js';
export { parseUf2, checkUf2AgainstBoard, UF2_FAMILIES } from './uf2.js';

/**
 * 依檔案型別挑策略。UI 不需要自己判斷。
 * @param {string} filename
 * @param {{boardMode?: string}} [context]
 */
export function pickStrategy(filename, context = {}) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.uf2')) return 'uf2';
  if (lower.endsWith('.bin')) return 'esptool';
  // 認不出來時看板子支援哪一種
  return context.boardMode === 'uf2' ? 'uf2' : 'esptool';
}
