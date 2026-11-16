// Bugs injected into node-semver for the outcome benchmark's fix cases, and the check of each fix.
//   node semver-bugs.mjs inject <id>   (setup: run in the copy before the agent starts)
//   node semver-bugs.mjs check <id>    (check: run in the copy after the agent finishes)
// Each injection must match exactly once, so a moved upstream line fails loudly instead of
// silently producing a case without a bug.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BUGS = {
  'max-satisfying': {
    file: 'ranges/max-satisfying.js',
    find: /maxSV\.compare\(v\) === -1/,
    replace: 'maxSV.compare(v) === 1',
  },
  'caret-zero-minor': {
    file: 'classes/range.js',
    find: /(debug\('no pr'\)\s*)if \(M === '0'\) \{/,
    replace: "$1if (M === '0' && m === '0') {",
  },
  'inc-patch-prerelease': {
    file: 'classes/semver.js',
    find: /(case 'patch':[\s\S]*?)if \(this\.prerelease\.length === 0\) \{/,
    replace: '$1if (this.prerelease.length >= 0) {',
  },
  // Casos "difíceis" (A/B da delegação): a causa fica num módulo interno que várias funções usam,
  // longe do sintoma relatado; remendar só a função citada no relato não passa no check.
  // Numeric prerelease identifiers compared as text: rc.10 sorts before rc.9.
  'prerelease-numeric-order': {
    file: 'internal/identifiers.js',
    find: /return a === b \? 0 : a < b \? -1 : 1/,
    replace: 'return a === b ? 0 : `${a}` < `${b}` ? -1 : 1',
  },
  // Options reduced to `loose`: includePrerelease is silently dropped everywhere.
  'options-include-prerelease': {
    file: 'internal/parse-options.js',
    find: / {2}return options(?=\r?\n\})/,
    replace: '  return { loose: !!options.loose }',
  },
};

const CHECKS = {
  'max-satisfying': (s) => [
    [s.maxSatisfying(['1.2.3', '1.2.4', '1.3.0'], '^1.2.0'), '1.3.0'],
    [s.maxSatisfying(['1.2.3', '1.2.4'], '~1.2.0'), '1.2.4'],
    [s.maxSatisfying(['2.0.0', '1.9.9'], '^1.0.0'), '1.9.9'],
    [s.minSatisfying(['1.2.3', '1.2.4'], '^1.2.0'), '1.2.3'],
  ],
  'caret-zero-minor': (s) => [
    [s.satisfies('0.3.0', '^0.2.3'), false],
    [s.satisfies('0.2.9', '^0.2.3'), true],
    [s.satisfies('0.0.4', '^0.0.3'), false],
    [s.satisfies('1.9.0', '^1.2.3'), true],
    [s.satisfies('0.2.3-beta.1', '^0.2.3-beta.0'), true],
    [s.validRange('^0.2.3'), '>=0.2.3 <0.3.0-0'],
  ],
  'inc-patch-prerelease': (s) => [
    [s.inc('1.2.0-5', 'patch'), '1.2.0'],
    [s.inc('1.2.0', 'patch'), '1.2.1'],
    [s.inc('1.2.3-beta.1', 'patch'), '1.2.3'],
    [s.inc('1.2.3', 'minor'), '1.3.0'],
    [s.inc('1.2.3-0', 'prerelease'), '1.2.3-1'],
  ],
  'prerelease-numeric-order': (s) => [
    [s.gt('1.0.0-rc.10', '1.0.0-rc.9'), true],
    [s.sort(['1.0.0-rc.10', '1.0.0-rc.9', '1.0.0-rc.2']).join(), '1.0.0-rc.2,1.0.0-rc.9,1.0.0-rc.10'],
    [s.compare('1.0.0-alpha.2', '1.0.0-alpha.10'), -1],
    [s.maxSatisfying(['1.0.0-beta.9', '1.0.0-beta.10'], '>=1.0.0-beta.0'), '1.0.0-beta.10'],
    [s.compare('1.0.0-alpha', '1.0.0-alpha.1'), -1],
    [s.compare('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1],
    [s.compare('1.0.0-beta', '1.0.0-alpha'), 1],
    [s.inc('1.0.0-rc.9', 'prerelease'), '1.0.0-rc.10'],
  ],
  'options-include-prerelease': (s) => [
    [s.satisfies('1.3.0-beta.1', '^1.2.0', { includePrerelease: true }), true],
    [s.satisfies('1.3.0-beta.1', '^1.2.0'), false],
    [s.maxSatisfying(['1.2.0', '1.3.0-beta.1'], '^1.2.0', { includePrerelease: true }), '1.3.0-beta.1'],
    [new s.Range('^1.2.0', { includePrerelease: true }).test('1.3.0-beta.1'), true],
    [s.intersects('^1.2.0', '1.3.0-beta.1', { includePrerelease: true }), true],
    [s.valid('=1.2.3', true), '1.2.3'],
    [s.valid('=1.2.3', { loose: true }), '1.2.3'],
    [s.valid('=1.2.3'), null],
  ],
};

const [mode, id] = process.argv.slice(2);
if (!BUGS[id]) { console.error(`unknown bug: ${id}`); process.exit(2); }
if (mode === 'inject') {
  const bug = BUGS[id];
  const text = readFileSync(bug.file, 'utf8');
  const global = new RegExp(bug.find.source, 'g');
  const n = (text.match(global) || []).length;
  if (n !== 1) { console.error(`${id}: anchor matched ${n} times in ${bug.file}`); process.exit(1); }
  writeFileSync(bug.file, text.replace(bug.find, bug.replace));
} else if (mode === 'check') {
  const require = createRequire(join(process.cwd(), 'index.js'));
  let semver;
  try { semver = require('./index.js'); } catch (e) { console.error(`cannot load: ${e.message}`); process.exit(1); }
  const fails = CHECKS[id](semver).filter(([got, want]) => got !== want);
  for (const [got, want] of fails) console.error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  process.exit(fails.length ? 1 : 0);
} else { console.error('mode: inject | check'); process.exit(2); }
