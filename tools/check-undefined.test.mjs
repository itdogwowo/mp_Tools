/**
 * `check-undefined.mjs` 的自我測試。
 *
 *     node tools/check-undefined.test.mjs
 *
 * ══ 為什麼檢查器本身需要測試 ═══════════════════════════════════════════
 *
 * 一個壞掉的檢查器會回報「✓ 沒有未定義的識別碼」—— 那比沒有檢查器更糟，
 * 因為它會讓人以為已經驗過了。
 *
 * 所以這裡**故意餵它會壞的程式碼**，確認它真的抓得到。
 * 每一條測資都對應這個專案真的發生過的一次錯誤。
 *
 * ══ 怎麼測一個 Node 腳本 ═══════════════════════════════════════════════
 *
 * 這個檢查器目前把邏輯寫在檔案裡直接執行。用子程序測最直接，
 * 但**子程序在受限環境下會被擋掉**（實測 `EPERM spawn`）。
 * 所以改成：用 `import()` 載入它的函式。為此把可測的函式 export 出去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// 只 import 函式，不執行主程式（main 有 import.meta 判斷）
const mod = await import('./check-undefined.mjs');
const { stripStringsAndComments, collectDeclared, collectUsed, findSuspects } = mod;

/** 把「可疑的名字」抽出來，方便斷言。 */
const suspectsOf = (code) => findSuspects(code).map((s) => s.name);

// ── 真的抓得到（每一條都是這個專案發生過的錯）─────────────────────────

test('★ 抓得到「呼叫不存在的函式」（startChart / drawChart / setBusy）', () => {
  // 刪掉圖表引擎時漏了呼叫點 —— 實際發生過
  assert.deepEqual(suspectsOf('function render() { if (x) drawChart(); }'), ['drawChart']);
  assert.deepEqual(suspectsOf('const a = 1;\nstartChart();'), ['startChart']);
  assert.deepEqual(suspectsOf('async function f() { setBusy(true); }'), ['setBusy']);
});

test('★ 抓得到「用不存在的常數」（RELEASE）', () => {
  // 忘了 import RELEASE —— 實際發生過，而且弄壞了整個燒錄頁
  const code = 'function renderFlash() { return RELEASE.version; }';
  assert.deepEqual(suspectsOf(code), ['RELEASE']);
});

test('★ 抓得到「完全沒有宣告」的名字（真實的 row bug）', () => {
  // 實際發生過：portPanel() 用了 renderDeviceView() 裡的區域變數 `row`。
  // 當時 renderDeviceView 的 `row` 也已經被改成模組層級的 dlRow，
  // 所以 `row` 在全檔案裡**完全沒有宣告** —— 這一類抓得到。
  //
  // ⚠️ 但**純粹的作用域錯誤抓不到**：如果 `row` 在某個函式裡有宣告、
  //    卻在另一個函式裡使用，這個檢查器不會發現（它不做作用域分析）。
  //    見下面那條測試。要抓那一類需要真正的 parser（例如 acorn）。
  const code = `
    function portPanel() {
      return row("x", "y");
    }
  `;
  assert.deepEqual(suspectsOf(code), ['row']);
});

test('⚠️ 已知限制：純作用域錯誤抓不到（不做作用域分析）', () => {
  // 這是**刻意的取捨**，不是 bug —— 記錄下來免得有人誤以為這個檢查器萬能。
  // 要抓這一類，需要真正的 AST parser 加作用域鏈，那超出「零依賴靜態檢查」的範圍。
  // 這個案例的實際防線是：**共用的東西就放模組層級**（已寫進 web/index.html 註解）。
  const code = `
    function renderDeviceView() {
      const row = (a, b) => a + b;
      return row(1, 2);
    }
    function portPanel() {
      return row("x", "y");   // 應該要被抓到，但目前抓不到
    }
  `;
  assert.deepEqual(suspectsOf(code), [], '目前的行為：抓不到（已知限制）');
});

test('抓得到 template literal 裡面呼叫的未定義函式', () => {
  // 最常見的一類：`${esc(x)}` 而 esc 不存在
  const code = 'function r() { return `<div>${escThing(x)}</div>`; }';
  assert.ok(suspectsOf(code).includes('escThing'), 'template 裡的呼叫也要檢查');
});

// ── 不該誤報（每一條都是第一版的噪音）─────────────────────────────────

test('不該把字串裡的東西當成識別碼', () => {
  // 第一版把 `micropython.org`、`docs/WEB-ARCHITECTURE.md` 都當成未定義
  const code = `
    const url = "https://micropython.org/resources/firmware/x.bin";
    const doc = 'docs/WEB-ARCHITECTURE.md';
    const css = "rgb(47 224 168 / .45)";
  `;
  assert.deepEqual(suspectsOf(code), []);
});

test('不該把註解裡的東西當成識別碼', () => {
  const code = `
    // 見 docs/PLAN.md 與 web/mock/index.html 的 drawChart
    /* requireSomething() 是隨便寫的 */
    function real() {}
  `;
  assert.deepEqual(suspectsOf(code), []);
});

test('不該把正規表達式的內容當成識別碼', () => {
  const code = 'const re = /^[A-Za-z_$][\\w$]*/g;\nre.test("x");';
  assert.deepEqual(suspectsOf(code), []);
});

test('★ 一行宣告多個名字時，第二個之後不能被誤報', () => {
  // `let cmdSel = 0, cmdHits = COMMANDS;` —— 第一版漏了 cmdHits
  const code = 'let a = 0, b = 1, c = 2;\nconsole.log(a, b, c);';
  assert.deepEqual(suspectsOf(code), []);
});

test('解構宣告要認得', () => {
  const code = `
    const { x, y } = obj;
    const [p, q] = arr;
    let { z: renamed } = obj2;
    x; y; p; q; renamed;
  `;
  assert.deepEqual(suspectsOf(code), []);
});

test('函式參數與 catch 變數要認得', () => {
  const code = `
    function f(alpha, beta = 1) { return alpha + beta; }
    const g = (gamma) => gamma * 2;
    const h = delta => delta + 1;
    try { f(1); } catch (err) { console.log(err); }
  `;
  assert.deepEqual(suspectsOf(code), []);
});

test('JS 內建與瀏覽器 API 不該被當成未定義', () => {
  const code = `
    const t = setTimeout(() => {}, 100);
    clearTimeout(t);
    JSON.stringify({});
    Math.max(1, 2);
    document.querySelector("#x");
    navigator.serial.getPorts();
    new Uint8Array(8);
    fetch("/api/x");
    Promise.resolve();
  `;
  assert.deepEqual(suspectsOf(code), []);
});

test('import 進來的名字要認得（含 as 別名）', () => {
  const code = `
    import { foo, bar as baz } from "./x.js";
    import def from "./y.js";
    foo(); baz(); def();
  `;
  assert.deepEqual(suspectsOf(code), []);
});

// ── 剝字串的單元行為 ───────────────────────────────────────────────────

test('剝字串時保留 template 的 ${} 內容', () => {
  const stripped = stripStringsAndComments('`a ${realCode()} b`');
  assert.match(stripped, /realCode/, '${} 裡面是真的程式碼，不能剝掉');
  assert.doesNotMatch(stripped, /\ba\b/, '字面內容要剝掉');
});

test('剝字串不會把前後 token 黏起來', () => {
  // `return"x"in y` 如果直接刪掉字串會變成 `returnin y` —— 那就冒出一個假識別碼。
  // 所以留 `""` 當佔位符。不需要額外空格，有佔位符就不會黏。
  const stripped = stripStringsAndComments('return"x"in y');
  assert.match(stripped, /return""in/, '要留佔位符');
  assert.doesNotMatch(stripped, /returnin/, '不能黏成一個新識別碼');
});

test('巢狀 template 也能正確剝', () => {
  const code = 'const a = `outer ${inner(`nested ${deep()}`)} end`;';
  const suspects = suspectsOf(code);
  assert.ok(suspects.includes('inner'), '巢狀 template 裡的呼叫要抓到');
  assert.ok(suspects.includes('deep'), '更深一層也要抓到');
});

test('除法不會被誤認為正規表達式', () => {
  const stripped = stripStringsAndComments('const half = total / 2;\nconst third = total / 3;');
  assert.match(stripped, /total \/ 2/, '除法要保留');
});

// ── 整體：跑真正的 web/index.html ──────────────────────────────────────

test('★ 真實的 web/index.html 目前是乾淨的', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, '..', 'web', 'index.html'), 'utf8');
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const suspects = findSuspects(code);
  assert.deepEqual(
    suspects.map((s) => s.name),
    [],
    `web/index.html 有未定義的識別碼：${suspects.map((s) => `${s.name}(行 ${s.lines.join(",")})`).join(", ")}`,
  );
});
