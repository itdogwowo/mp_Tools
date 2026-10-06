#!/usr/bin/env node
/**
 * 未定義識別碼檢查器 —— 給 `web/index.html` 的 module script。
 *
 *     node tools/check-undefined.mjs          # 檢查
 *     node tools/check-undefined.mjs --verbose
 *
 * ══ 為什麼需要這個 ═══════════════════════════════════════════════════════
 *
 * 這個 session 裡，「程式碼參照了不存在的東西」已經發生**十次**：
 *
 *   $("#conn-label")        那個 DOM id 不存在
 *   S.caps                  那個狀態欄位沒定義
 *   setBusy()               函式不存在
 *   renderProgress()        函式不存在
 *   row()                   定義在別的函式裡面（作用域）
 *   RELEASE                 忘了 import
 *   startChart()            刪掉圖表引擎時忘了改呼叫點
 *   …
 *
 * **它們的症狀全部一樣：console 乾淨、畫面沒反應。**
 * 因為多半發生在 async 函式裡，變成未處理的 promise rejection。
 *
 * `node --check` 抓不到（語法正確），啟動自我檢查也抓不到
 * （那只驗 DOM id 與狀態欄位）。所以要專門掃一次。
 *
 * ══ 它怎麼做 ═══════════════════════════════════════════════════════════
 *
 * 1. 從 module script 收集「有定義的名字」：import / function / const / let /
 *    class，以及 function 的參數
 * 2. 找出所有「被呼叫的裸識別碼」（`foo(`）與「被取屬性的裸識別碼」（`foo.bar`）
 * 3. 扣掉 JS 內建、瀏覽器 API、關鍵字
 * 4. 剩下的就是嫌疑犯
 *
 * 這是**啟發式**，不是編譯器。寧可漏報也不要誤報 —— 誤報會讓人開始忽略它。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "web", "index.html");

/** JS 內建與語法關鍵字。這些不是「未定義」。 */
const BUILTINS = new Set([
  // 關鍵字與運算子
  "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "return", "function", "class", "new", "typeof", "instanceof", "in", "of", "delete",
  "void", "yield", "await", "async", "try", "catch", "finally", "throw", "with", "debugger",
  "this", "super", "import", "export", "from", "as", "let", "const", "var", "true", "false", "null",
  // 內建函式／物件
  "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
  "ReferenceError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "Intl", "Atomics", "SharedArrayBuffer", "ArrayBuffer", "DataView", "Uint8Array",
  "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array",
  "Float64Array", "BigUint64Array", "BigInt64Array", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "Headers",
  "Request", "Response", "AbortController", "AbortSignal", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "EventTarget", "MessageChannel", "MessagePort",
  "Worker", "WebSocket", "structuredClone", "queueMicrotask", "requestAnimationFrame",
  "cancelAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "eval", "atob", "btoa", "fetch", "alert", "confirm", "prompt",
  "Symbol", "globalThis", "Infinity", "NaN", "undefined",
  // 瀏覽器／DOM
  "window", "document", "navigator", "location", "history", "screen", "console",
  "localStorage", "sessionStorage", "indexedDB", "crypto", "performance", "devicePixelRatio",
  "Image", "Audio", "Option", "Path2D", "OffscreenCanvas", "CSS", "HTMLElement",
  "Node", "Element", "DocumentFragment", "DOMParser", "XMLSerializer", "MutationObserver",
  "IntersectionObserver", "ResizeObserver", "getComputedStyle", "matchMedia",
  "addEventListener", "removeEventListener", "dispatchEvent", "getSelection",
]);

/** 取得 module script 的內容。 */
function extractModuleScript(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("找不到 <script type=\"module\"> —— HTML 結構變了嗎？");
  return match[1];
}

/**
 * 剝掉字串與註解，只留下程式碼。
 *
 * ══ 為什麼一定要做 ═════════════════════════════════════════════════════
 *
 * 第一版沒剝，結果 31 個「嫌疑犯」裡有 28 個是誤報：
 *
 *     micropython.org        ← 在字串裡
 *     rgb(47 224 168 / .45)  ← 在 CSS 字串裡
 *     docs/WEB-ARCHITECTURE  ← 在註解裡
 *     .js  .md  v1  v0       ← 檔案名與版本號
 *
 * **誤報比漏報更糟** —— 一份充滿噪音的報告會讓人開始忽略它，
 * 然後真正的問題就跟著被忽略。
 *
 * ══ 關鍵：template literal 的 `${}` 裡面是**真的程式碼** ═══════════════
 *
 * `body.innerHTML = \`...${esc(b.chip)}...\`` —— `esc` 是真的要被呼叫的。
 * 所以剝字串時要**保留** `${}` 的內容，否則會漏掉最常見的那一類錯誤
 * （在 template 裡呼叫了不存在的函式）。
 */
export function stripStringsAndComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;

  /** 遞迴處理 template literal：字面內容丟掉，${} 內容保留。 */
  function readTemplate() {
    // 進入時 i 指向反引號
    i++; // 跳過 `
    let inner = "";
    while (i < n) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        return inner;
      }
      if (ch === "$" && code[i + 1] === "{") {
        i += 2;
        let depth = 1;
        let expr = "";
        while (i < n && depth > 0) {
          if (code[i] === "{") depth++;
          else if (code[i] === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          expr += code[i];
          i++;
        }
        // 巢狀的 template 也要處理
        inner += " " + stripStringsAndComments(expr) + " ";
        continue;
      }
      i++;
    }
    return inner;
  }

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // 行註解
    if (ch === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    // 區塊註解
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 字串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""'; // 留一個空字串佔位，避免把前後 token 黏起來
      continue;
    }
    // template literal
    if (ch === "`") {
      out += " " + readTemplate() + " ";
      continue;
    }
    // 正規表達式字面值：`/.../ flags`。用前一個非空白字元判斷是不是除法。
    if (ch === "/") {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      const prev = j >= 0 ? out[j] : "";
      const looksLikeRegex = !/[\w$)\]]/.test(prev);
      if (looksLikeRegex) {
        i++;
        while (i < n) {
          if (code[i] === "\\") {
            i += 2;
            continue;
          }
          if (code[i] === "/") {
            i++;
            while (i < n && /[a-z]/i.test(code[i])) i++;
            break;
          }
          if (code[i] === "\n") break; // 沒收尾，當成除法
          i++;
        }
        out += " ";
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * 收集有定義的名字。
 *
 * ⚠️ 陷阱：`let cmdSel = 0, cmdHits = COMMANDS;` —— **一行宣告兩個名字**。
 * 第一版只抓緊接在關鍵字後的那個，於是 `cmdHits` 被誤報成未定義。
 * 所以 `const|let|var` 要拿**整行**去切逗號，不能只抓第一個識別碼。
 */
export function collectDeclared(code) {
  const names = new Set();

  const add = (raw) => {
    const name = String(raw ?? "").trim().replace(/^\.\.\./, "").split(/[\s={[:]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  };

  // import { a, b as c } from "…"
  for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(",")) add(part.trim().split(/\s+as\s+/).pop());
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) add(m[1]);

  // function / class
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/(?:^|\n)[ \t]*class\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);

  // const / let / var —— 抓整行到分號，再切逗號（處理 `let a = 0, b = 1;`）
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:const|let|var)\s+([^;\n]+)/g)) {
    const decl = m[1];
    for (const dm of decl.matchAll(/\{([^}]*)\}/g)) {
      for (const part of dm[1].split(",")) add(part.trim().split(":").pop());
    }
    for (const dm of decl.matchAll(/\[([^\]]*)\]/g)) {
      for (const part of dm[1].split(",")) add(part);
    }
    // 一般宣告：只取 `=` 之前、且必須是乾淨的識別碼 ——
    // 否則 `x = foo(a, b)` 裡的 a、b 會被誤認為被宣告。
    for (const part of decl.split(",")) {
      const lhs = part.split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(lhs)) names.add(lhs);
    }
  }

  // catch (e)
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);

  // 函式參數：(...) => 或 (...) {
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) add(part);
  }
  // 單一參數箭頭：x => …
  for (const m of code.matchAll(/(?:^|[(,=\s])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);

  return names;
}

/**
 * 找出**被使用**的裸識別碼。
 *
 * ══ 只查「被呼叫」與「被取屬性」是不夠的 ═══════════════════════════════
 *
 * 第一版只抓 `foo(` 與 `foo.bar` 這兩種形狀，於是漏掉了：
 *
 *     ${selected && selected.chip === "esp8266" ? … : …}
 *       ↑ `selected` 是裸識別碼，既沒被呼叫也沒取屬性
 *
 * 那讓「選項」這一步整個拋 `ReferenceError`，而檢查器回報「✓ 沒有問題」。
 *
 * 所以改成**抓所有裸識別碼**，再用嚴格的規則過濾。
 * 過濾要嚴 —— 誤報會讓整份報告失去可信度，比漏報更糟。
 */
export function collectUsed(code) {
  const used = new Map(); // name → [行號]

  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const note = (name, index) => {
    if (!used.has(name)) used.set(name, []);
    used.get(name).push(lineOf(index));
  };

  // 0. **整條 import 語句跳過。**
  //
  //    `import { foo, bar as baz } from "./x.js";`
  //      · `bar` 是模組裡的**原名**，不是本檔案的識別碼 → 不該報
  //      · `baz` 是本地綁定名 → 由 collectDeclared 處理，也不需要報
  //
  //    所以整句當一個單位跳過最乾淨。用「同一行內、往前找得到 import」判斷。
  const importSpans = [];
  for (const match of code.matchAll(/(?:^|\n)[ \t]*import\b[^\n]*/g)) {
    importSpans.push([match.index, match.index + match[0].length]);
  }
  const inImport = (index) => importSpans.some(([a, b]) => index >= a && index < b);

  // 1. 呼叫：`name(` —— 前面不能是 `.`（那會是 method）
  for (const match of code.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (inImport(match.index)) continue;
    note(match[1], match.index);
  }

  // 2. 取屬性：`name.`
  for (const match of code.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\./g)) {
    if (inImport(match.index)) continue;
    note(match[1], match.index);
  }

  // 3. 裸識別碼 —— 第一版缺的這一塊。
  //    只抓「像變數」的位置，避免把物件字面值的 key、標籤之類的算進來。
  for (const match of code.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)(?![\w$'"`])/g)) {
    if (inImport(match.index)) continue;
    const name = match[1];
    const index = match.index;
    const before = code.slice(Math.max(0, index - 28), index);
    const after = code.slice(index + name.length);

    // 物件字面值的 key 或三元運算子的分支：後面緊接 `:`
    if (/^\s*:/.test(after)) continue;
    // 宣告／關鍵字之後的名字不是「使用」
    if (/(?:const|let|var|function|class|new|typeof|instanceof|in|of|return\s+await)\s+$/.test(before)) continue;
    // 物件解構的 key：`{ name }` / `{ name, … }` / `{ name }`
    if (/\{\s*$/.test(before) && /^\s*[,}\]]/.test(after)) continue;
    // 參數列裡的名字（`(a, b)`）由 collectDeclared 處理
    if (/[(,]\s*$/.test(before) && /^\s*[,)]/.test(after)) continue;
    // 純屬性名（`.name`）—— 前面是點
    if (/\.\s*$/.test(before)) continue;
    // 字串標籤、HTML 屬性名之類（前後都是引號）—— 剝字串時已處理，這裡保險
    if (/["'`]\s*$/.test(before)) continue;

    // ── 解構與 import 的「右值／原名」不是可疑的裸識別碼 ────────────────
    //
    //     const { x, y } = obj;          ← obj 是右值（原本被誤報）
    //     const [p, q] = arr;            ← arr 同上
    //     import { bar as baz } from …;  ← bar 是原名（baz 才是綁定）
    //
    // 這些**是**「被讀取的值」，但它們出現在宣告語句裡，幾乎不可能是打錯字。
    // 真正要抓的是「用了某個名字卻沒宣告」，那由下面的 template 與賦值規則涵蓋。
    if (/\bas\s+$/.test(before)) continue;
    // 在同一個 `{…}` 或 `[…]` 群組裡，且前面有 `=`（也就是 `… } = obj` 的 obj）
    const groupStart = Math.max(
      code.lastIndexOf("{", index),
      code.lastIndexOf("[", index),
      code.lastIndexOf("(", index),
    );
    if (groupStart >= 0) {
      const group = code.slice(groupStart, index);
      // 這個群組已經閉合了（`}= …`），代表我們在宣告的右值上
      if (/^[\[{(][\s\S]*[\]})]\s*=\s*$/.test(group)) continue;
    }

    note(name, index);
  }

  // 4. template literal 的 `${…}` 與賦值右側的裸識別碼。
  //
  //    **這是真實 bug 出現的地方**：`${selected && selected.chip === "x" ? … : …}`
  //    的 `selected` 既沒被呼叫、沒被取屬性、也不匹配上面任何一個位置樣式，
  //    所以第一版完全漏掉它。
  //
  //    這條規則刻意放寬：只要名字出現在 `${…}` 裡、或在 `=` 的右側、
  //    或緊接 `.` 取屬性、或單獨作為三元的分支，就記一筆。
  //    collectDeclared 那邊會把「真的有宣告」的扣掉，所以放寬是安全的。
  for (const match of code.matchAll(/\$\{([^}]*)\}/g)) {
    const expression = match[1];
    const base = match.index;
    for (const inner of expression.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)(?![\w$'"`])/g)) {
      const name = inner[1];
      const beforeInner = expression.slice(Math.max(0, inner.index - 20), inner.index);
      // 屬性名（`a.b` 的 b）與物件 key（`{ a: 1 }` 的 a）不算
      if (/\.\s*$/.test(beforeInner)) continue;
      const afterInner = expression.slice(inner.index + name.length);
      if (/^\s*:/.test(afterInner)) continue;
      note(name, base + inner.index);
    }
  }

  return used;
}

/** 把可疑的名字過濾一遍。 */
export function findSuspects(rawCode) {
  // **先剝掉字串與註解**，否則報告會被檔案名、CSS 顏色、URL 之類的噪音淹沒。
  // template literal 的 `${}` 會被保留（那是真的程式碼）。
  const code = stripStringsAndComments(rawCode);
  const declared = collectDeclared(code);
  const used = collectUsed(code);
  const suspects = [];

  for (const [name, lines] of used) {
    if (declared.has(name)) continue;
    if (BUILTINS.has(name)) continue;
    // 全大寫的常數可能是刻意用 globalThis 或 CSS 變數，先跳過
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(name) && !declared.has(name)) {
      // 但 import 進來的常數也在 declared 裡，所以走到這裡代表真的沒定義
    }
    suspects.push({ name, lines: [...new Set(lines)].slice(0, 5), count: lines.length });
  }

  return suspects.sort((a, b) => b.count - a.count);
}

/* ── 主程式 ───────────────────────────────────────────────────────────
 *
 * 只有**直接執行**時才跑。被 `import()` 時（自我測試）只匯出函式，
 * 不執行任何東西 —— 否則測試會跟著跑一次檢查然後 process.exit。
 */
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;

if (isMain) main();

function main() {
  const verbose = process.argv.includes("--verbose");
  const html = readFileSync(target, "utf8");
  const code = extractModuleScript(html);
  const suspects = findSuspects(code);

  if (verbose) {
    console.log(`檔案        ${target}`);
    console.log(`script      ${code.length} bytes, ${code.split("\n").length} 行`);
    console.log(`已定義名字  ${collectDeclared(stripStringsAndComments(code)).size} 個`);
    console.log();
  }

  if (suspects.length === 0) {
    console.log("✓ 沒有未定義的識別碼");
    process.exit(0);
  }

  console.error(`✗ 找到 ${suspects.length} 個可能未定義的識別碼\n`);
  for (const { name, lines, count } of suspects) {
    console.error(`  ${name.padEnd(24)} 用了 ${String(count).padStart(3)} 次   行 ${lines.join(", ")}`);
  }
  console.error(`
這些會在執行時拋 ReferenceError。若在 async 函式裡，會變成未處理的
promise rejection —— **console 乾淨、畫面沒反應**，最難查的那一種。

如果其中有誤報（例如真的是全域），把它加進 tools/check-undefined.mjs 的
BUILTINS 清單，並在旁邊寫為什麼。
`);
  process.exit(1);
}
