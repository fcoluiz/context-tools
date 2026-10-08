import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safe, statePath, stateDir } from './roots.mjs';

/**
 * Apply a one-time navigation hint to an existing project instruction file.
 *
 * Host-specific wrappers provide the target file, markers, block text, and config flags. The
 * write/marker/idempotency rules stay here so Claude and Codex cannot drift apart.
 *
 * The file is decoded and encoded again in its original format. A project instruction file is
 * configuration/documentation, not disposable cache: appending a hint must not silently turn
 * Windows-1252, UTF-8-with-BOM, or UTF-16 into another encoding.
 */
export function aplicarMdHint(root, cfg, options) {
  const {
    targetFile,
    markerStart,
    stateFile,
    block,
    disabledBy = [],
  } = options;

  if (disabledBy.some((key) => cfg[key] === false)) return null;

  const marker = statePath(root, stateFile);
  if (existsSync(marker)) return null;

  const caminho = join(root, targetFile);
  if (!existsSync(caminho)) {
    marcarFeito(root, marker);
    return null;
  }

  const documento = lerDocumento(caminho);
  if (documento === null) return null;
  const { text: atual } = documento;

  if (atual.includes(markerStart)) {
    marcarFeito(root, marker);
    return 'already';
  }

  const bloco = typeof block === 'function' ? block(atual) : block;
  if (typeof bloco !== 'string' || !bloco) return null;

  const newline = /\r\n/.test(atual) ? '\r\n' : /\r/.test(atual) ? '\r' : '\n';
  const separador = /(?:\r\n|\r|\n){2,}$/.test(atual)
    ? ''
    : /(?:\r\n|\r|\n)$/.test(atual) ? newline : `${newline}${newline}`;
  const textoDoBloco = bloco.replace(/\r\n|\r|\n/g, newline);
  const novo = `${atual}${separador}${textoDoBloco}`;
  const ok = gravarDocumento(caminho, documento, novo);
  if (!ok) return null;

  marcarFeito(root, marker);
  return 'added';
}

/** Lê um arquivo de instrução sem impor UTF-8 ao projeto. */
export function lerTextoHint(root, targetFile) {
  const documento = lerDocumento(join(root, targetFile));
  return documento ? documento.text : null;
}

export function lerDocumento(caminho) {
  const bytes = safe(() => readFileSync(caminho), null);
  if (!bytes) return null;

  try {
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf8', bom: bytes.subarray(0, 3) };
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: bytes.subarray(0, 2) };
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { text: decodeUtf16Be(bytes.subarray(2)), encoding: 'utf16be', bom: bytes.subarray(0, 2) };
    }

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text, encoding: 'utf8', bom: Buffer.alloc(0) };
    } catch {
      return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: Buffer.alloc(0) };
    }
  } catch {
    return null;
  }
}

export function codificarDocumento(documento, texto) {
  const corpo = documento.encoding === 'utf8'
    ? Buffer.from(texto, 'utf8')
    : documento.encoding === 'utf16le'
      ? Buffer.from(texto, 'utf16le')
      : documento.encoding === 'utf16be'
        ? encodeUtf16Be(texto)
        : encodeWindows1252(texto);
  return Buffer.concat([documento.bom, corpo]);
}

function gravarDocumento(caminho, documento, texto) {
  return safe(() => {
    writeFileSync(caminho, codificarDocumento(documento, texto));
    return true;
  }, false);
}

function decodeUtf16Be(bytes) {
  const le = Buffer.alloc(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    le[i] = bytes[i + 1];
    le[i + 1] = bytes[i];
  }
  return le.toString('utf16le');
}

function encodeUtf16Be(text) {
  const le = Buffer.from(text, 'utf16le');
  for (let i = 0; i + 1 < le.length; i += 2) {
    const byte = le[i];
    le[i] = le[i + 1];
    le[i + 1] = byte;
  }
  return le;
}

// The hint text uses Latin characters. Keep the encoder dependency-free while covering the
// Windows-1252 code points that are not equal to their Unicode byte value.
const CP1252_SPECIAL = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F],
]);

function encodeWindows1252(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code <= 0xFF && !(code >= 0x80 && code <= 0x9F)) bytes.push(code);
    else if (CP1252_SPECIAL.has(code)) bytes.push(CP1252_SPECIAL.get(code));
    else throw new Error(`unsupported Windows-1252 character U+${code.toString(16)}`);
  }
  return Buffer.from(bytes);
}

function marcarFeito(root, marker) {
  safe(() => {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(marker, '');
  }, null);
}
