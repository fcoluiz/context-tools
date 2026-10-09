// A especificação aberta (docs/spec/knowledge-format.md + schema) só vale se descrever o que o código
// faz. Estes testes derivam do código, em vez de repetir listas: os campos que os leitores leem
// precisam estar no schema, e o fingerprint/digest calculado "à mão" pela regra escrita na
// especificação precisa ser igual ao que a implementação produz.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localPath } from './paths.mjs';
import { fingerprintSources } from '../scripts/lib/source-fingerprints.mjs';

const ROOT = localPath('../', import.meta.url);
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const schema = JSON.parse(read('docs', 'spec', 'knowledge-format.schema.json'));
const [mapa, documento] = schema.oneOf;

test('todo campo que o leitor de documento lê está no schema', () => {
  const corpo = read('scripts', 'lib', 'documentation.mjs').match(/export function readMetadata[\s\S]*?\n}\n/)[0];
  const lidos = new Set(corpo.match(/\b[a-z]+_[a-z_]+\b/g));
  assert.ok(lidos.size >= 5, 'o extrator deste teste envelheceu');
  for (const campo of lidos) assert.ok(documento.properties[campo], `readMetadata lê "${campo}", ausente do schema`);
});

test('todo campo de mapa que o hook usa está no schema', () => {
  const fonte = read('scripts', 'context-maps.mjs');
  const usados = new Set([...fonte.matchAll(/\bm\.(area|covers|verified_[a-z]+|source_[a-z]+)\b/g)].map((m) => m[1]));
  assert.ok(usados.has('source_fingerprints') && usados.has('verified_at'), 'o extrator deste teste envelheceu');
  for (const campo of usados) assert.ok(mapa.properties[campo], `context-maps usa "${campo}", ausente do schema`);
  assert.deepEqual(mapa.required, ['area', 'covers', 'verified_at']);
});

test('fingerprint e digest pela regra escrita na especificação = os da implementação', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-spec-'));
  try {
    const crlf = join(dir, 'a.js');
    const lf = join(dir, 'b.js');
    const binario = join(dir, 'c.bin');
    writeFileSync(crlf, 'linha 1\r\nlinha 2\r\n');
    writeFileSync(lf, 'linha 1\nlinha 2\n');
    writeFileSync(binario, Buffer.from([0x00, 0x0d, 0x0a, 0x41]));
    const r = fingerprintSources([
      { path: crlf, id: 'src/a.js' }, { path: lf, id: 'src/b.js' }, { path: binario, id: 'src/c.bin' }, { path: join(dir, 'x.js'), id: 'src/x.js' },
    ]);
    const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
    // §4: CRLF vira LF antes do hash (sem NUL); com NUL, bytes crus; inexistente = "missing".
    assert.equal(r.sources['src/a.js'], `sha256:${hex(Buffer.from('linha 1\nlinha 2\n'))}`);
    assert.equal(r.sources['src/a.js'], r.sources['src/b.js'], 'o mesmo texto tem o mesmo fingerprint em qualquer SO');
    assert.equal(r.sources['src/c.bin'], `sha256:${hex(Buffer.from([0x00, 0x0d, 0x0a, 0x41]))}`);
    assert.equal(r.sources['src/x.js'], 'missing');
    // §5: digest sobre os hex sem prefixo, entradas ordenadas pelo sort padrão do JavaScript.
    const entries = Object.entries(r.sources).map(([id, v]) => [id, v === 'missing' ? 'missing' : v.slice('sha256:'.length)]).sort();
    assert.equal(r.digest, `sha256:${hex(Buffer.from(JSON.stringify({ sources: entries, markers: [] })))}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
