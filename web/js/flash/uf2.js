/**
 * UF2 檔案的解析與驗證。
 *
 * ══ 為什麼要驗證 ═══════════════════════════════════════════════════════
 * 拖放 `.uf2` 到 BOOTSEL 磁碟的流程**沒有任何安全網**：
 *   · 拖錯檔案（例如把 Pico 的 uf2 拖進 ESP32-S3）→ 板子直接不開機
 *   · 檔案沒下載完就被拖進去 → 同樣不開機
 *   · 使用者以為拖了其實沒拖成功 → 板子停在 BOOTSEL，看起來像壞了
 *
 * 所以我們在**拖進去之前**先解析檔案，把這三件事擋掉。
 *
 * ══ UF2 格式 ══════════════════════════════════════════════════════════
 * 每個 block 固定 512 bytes，前 32 bytes 是檔頭（全部 little-endian）：
 *
 *   0x00  magicStart0   0x0A324655  ("UF2\n")
 *   0x04  magicStart1   0x9E5D5157
 *   0x08  flags
 *   0x0C  targetAddr    這個 block 要寫到哪個位址
 *   0x10  payloadSize   資料長度（通常 256）
 *   0x14  blockNo       第幾個 block
 *   0x18  numBlocks     總共幾個
 *   0x1C  fileSize / familyID
 *   0x20  data[476]     （payloadSize 之後是 padding）
 *   0x1FC magicEnd      0x0AB16F30
 *
 * `familyID` 是**判斷這顆 uf2 是不是給對晶片**的關鍵：
 * 每個晶片家族有自己的 ID，Pico 的 uf2 拖進 ESP32-S3 會被 bootloader 拒絕
 * —— 但拒絕的方式是「什麼都不說，板子不開機」。
 */

export const UF2_BLOCK_SIZE = 512;

/** 檔頭裡的固定魔數。 */
export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;

/**
 * 晶片家族的 UF2 family ID。
 * 來源：各專案的 UF2 定義（microsoft/uf2 的 utils/uf2families.json）。
 * **只收我們目錄裡真的會用到的**，沒把握的不猜。
 */
export const UF2_FAMILIES = {
  0xe48bff56: { id: 'rp2040', label: 'RP2040', boards: ['rp2040-pico'] },
  0xe48bff57: { id: 'rp2350-arm-s', label: 'RP2350 (Arm Secure)', boards: ['rp2350-pico2'] },
  0xe48bff58: { id: 'rp2350-riscv', label: 'RP2350 (RISC-V)', boards: ['rp2350-pico2'] },
  0xe48bff59: { id: 'rp2350-arm-ns', label: 'RP2350 (Arm Non-secure)', boards: ['rp2350-pico2'] },
  // Espressif 的 uf2 家族（ESP32-S3 / S2 等原生 USB 的晶片）
  0x1c5f21b0: { id: 'esp32s3', label: 'ESP32-S3', boards: ['esp32s3-generic'] },
  0x2e5f21b0: { id: 'esp32s2', label: 'ESP32-S2', boards: [] },
  0x3e5f21b0: { id: 'esp32c3', label: 'ESP32-C3', boards: ['esp32c3-generic'] },
  0x4e5f21b0: { id: 'esp32c6', label: 'ESP32-C6', boards: ['esp32c6-generic'] },
};

/** 讀 32-bit little-endian。 */
function u32(view, offset) {
  return view.getUint32(offset, true);
}

/**
 * 解析並驗證一個 UF2 檔。
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{
 *   ok: boolean,
 *   problems: string[],
 *   warnings: string[],
 *   blocks: number,
 *   payloadBytes: number,
 *   familyId: number|null,
 *   family: {id: string, label: string, boards: string[]} | null,
 *   targetRange: {start: number, end: number} | null,
 *   truncated: boolean,
 * }}
 */
export function parseUf2(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const problems = [];
  const warnings = [];

  if (bytes.byteLength === 0) {
    return emptyResult(['檔案是空的（下載可能沒完成）']);
  }
  if (bytes.byteLength % UF2_BLOCK_SIZE !== 0) {
    problems.push(
      `檔案大小 ${bytes.byteLength} 不是 ${UF2_BLOCK_SIZE} 的整數倍 —— ` +
        '下載可能沒完成，或這根本不是 UF2 檔。',
    );
  }
  if (bytes.byteLength < UF2_BLOCK_SIZE) {
    return emptyResult([...problems, '檔案比一個 UF2 block 還小。']);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockCount = Math.floor(bytes.byteLength / UF2_BLOCK_SIZE);

  const first = {
    magicStart0: u32(view, 0),
    magicStart1: u32(view, 4),
    flags: u32(view, 8),
    targetAddr: u32(view, 12),
    payloadSize: u32(view, 16),
    blockNo: u32(view, 20),
    numBlocks: u32(view, 24),
    familyId: u32(view, 28),
  };

  // ── 1. 魔數：確認這真的是 UF2 ────────────────────────────────────────
  if (first.magicStart0 !== UF2_MAGIC_START0 || first.magicStart1 !== UF2_MAGIC_START1) {
    return emptyResult([
      '這不是 UF2 檔（檔頭魔數不符）。',
      '常見原因：拿成了 .bin 或 .elf，或是下載到一半的檔案。',
    ]);
  }

  // ── 2. 宣告的 block 數 vs 實際大小 ───────────────────────────────────
  let truncated = false;
  if (first.numBlocks > 0 && blockCount < first.numBlocks) {
    truncated = true;
    problems.push(
      `檔案不完整：檔頭說有 ${first.numBlocks} 個 block，實際只有 ${blockCount} 個。` +
        '請重新下載。',
    );
  } else if (first.numBlocks > 0 && blockCount > first.numBlocks) {
    warnings.push(`檔案比檔頭宣告的多 ${blockCount - first.numBlocks} 個 block（通常無害）。`);
  }

  // ── 3. 逐一檢查每個 block（只抽查，避免大檔拖慢 UI）─────────────────
  const step = blockCount > 256 ? Math.ceil(blockCount / 128) : 1;
  let payloadBytes = 0;
  let minAddr = Number.POSITIVE_INFINITY;
  let maxAddr = 0;
  let familyId = first.familyId;
  const familyIds = new Set([first.familyId]);

  for (let index = 0; index < blockCount; index += step) {
    const base = index * UF2_BLOCK_SIZE;
    const magic0 = u32(view, base);
    const magic1 = u32(view, base + 4);
    const magicEnd = u32(view, base + UF2_BLOCK_SIZE - 4);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1) {
      problems.push(`第 ${index} 個 block 的檔頭魔數不對（檔案可能損毀）。`);
      break;
    }
    if (magicEnd !== UF2_MAGIC_END) {
      problems.push(`第 ${index} 個 block 的結尾魔數不對（檔案可能損毀）。`);
      break;
    }
    const payload = u32(view, base + 16);
    const addr = u32(view, base + 12);
    if (payload > 476) {
      problems.push(`第 ${index} 個 block 宣告的資料長度 ${payload} 超過上限 476。`);
      break;
    }
    payloadBytes += payload;
    minAddr = Math.min(minAddr, addr);
    maxAddr = Math.max(maxAddr, addr + payload);
    familyIds.add(u32(view, base + 28));
  }

  // ── 4. family ID 一致性 ──────────────────────────────────────────────
  if (familyIds.size > 1) {
    warnings.push(
      `檔案裡混了 ${familyIds.size} 種 family ID（通常代表這是多晶片合併檔，` +
        '或檔案被拼接過）。',
    );
  }

  // 修正抽取造成的低估
  if (step === 1) {
    // 全部檢查過了，payloadBytes 是精確值
  } else {
    // 只抽查，用平均推估
    payloadBytes = Math.round((payloadBytes / Math.ceil(blockCount / step)) * blockCount);
  }

  const family = UF2_FAMILIES[familyId] ?? null;
  if (!family) {
    warnings.push(
      `不認得的 family ID 0x${familyId.toString(16).padStart(8, '0')}。` +
        '無法確認這個檔案是給哪顆晶片 —— 拖錯會讓板子不開機。',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    blocks: blockCount,
    payloadBytes,
    familyId,
    family,
    targetRange:
      Number.isFinite(minAddr) && maxAddr > 0 ? { start: minAddr, end: maxAddr } : null,
    truncated,
  };
}

function emptyResult(problems) {
  return {
    ok: false,
    problems,
    warnings: [],
    blocks: 0,
    payloadBytes: 0,
    familyId: null,
    family: null,
    targetRange: null,
    truncated: false,
  };
}

/**
 * 這個 UF2 適不適合選定的板子？
 *
 * @param {ReturnType<typeof parseUf2>} parsed
 * @param {{id: string, label: string, chip: string}} board
 * @returns {{verdict: 'ok'|'warn'|'mismatch'|'unknown', message: string}}
 */
export function checkUf2AgainstBoard(parsed, board) {
  if (!parsed.ok) {
    return { verdict: 'mismatch', message: '檔案本身有問題，請先修好再拖進去。' };
  }
  if (!parsed.family) {
    return {
      verdict: 'unknown',
      message:
        `無法確認這個 .uf2 是給哪顆晶片（family ID 0x${parsed.familyId?.toString(16)}）。` +
        `你要燒的是 ${board.label}。**拖錯檔案會讓板子不開機。**`,
    };
  }
  if (parsed.family.boards.includes(board.id)) {
    return { verdict: 'ok', message: `檔案是給 ${parsed.family.label} 的，與 ${board.label} 相符。` };
  }
  // family 對得上晶片但目錄裡沒有對應板子項目 → 警告而非阻擋
  if (parsed.family.id.startsWith(board.chip)) {
    return {
      verdict: 'warn',
      message: `檔案標示為 ${parsed.family.label}，與 ${board.label} 的晶片相符，但目錄裡沒有對應項目。`,
    };
  }
  return {
    verdict: 'mismatch',
    message:
      `**晶片不符。** 這個 .uf2 是給 ${parsed.family.label} 的，` +
      `但你要燒的是 ${board.label}（${board.chip}）。拖進去板子會不開機。`,
  };
}
