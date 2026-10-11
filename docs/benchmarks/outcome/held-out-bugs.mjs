// Bugs injected into two repositories the plugin was never tuned on (js-yaml 4.1.0, commander.js
// v15.0.0), for the independent validation round, and the check of each fix.
//   node held-out-bugs.mjs inject <id>   (setup: run in the copy before the agent starts)
//   node held-out-bugs.mjs check <id>    (check: run in the copy after the agent finishes)
// The cases were written before running the plugin on either repository. Each injection must match
// exactly once, so a moved upstream line fails loudly instead of producing a case without a bug.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BUGS = {
  // `<<: *base` stops bringing in the base mapping's keys.
  'yaml-merge-keys': {
    file: 'lib/loader.js',
    find: /if \(!_hasOwnProperty\.call\(destination, key\)\) \{/,
    replace: 'if (_hasOwnProperty.call(destination, key)) {',
  },
  // `|-` keeps the final line break and `|+` strips it: the two chomping indicators swapped.
  'yaml-block-chomping': {
    file: 'lib/loader.js',
    find: /chomping = \(ch === 0x2B\/\* \+ \*\/\) \? CHOMPING_KEEP : CHOMPING_STRIP;/,
    replace: 'chomping = (ch === 0x2B/* + */) ? CHOMPING_STRIP : CHOMPING_KEEP;',
  },
  // `--port=8080` arrives as "=8080".
  'commander-long-equals': {
    file: 'lib/command.js',
    find: /this\.emit\(`option:\$\{option\.name\(\)\}`, arg\.slice\(index \+ 1\)\);/,
    replace: 'this.emit(`option:${option.name()}`, arg.slice(index));',
  },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CHECKS = {
  'yaml-merge-keys': (y) => [
    [y.load('base: &b {a: 1, b: 2}\nx:\n  <<: *b\n  c: 3\n').x, { a: 1, b: 2, c: 3 }],
    [y.load('base: &b {a: 1, b: 2}\nx:\n  <<: *b\n  b: 9\n').x, { a: 1, b: 9 }],
    [y.load('p: &p {a: 1}\nq: &q {a: 2, z: 0}\nx:\n  <<: [*p, *q]\n').x, { a: 1, z: 0 }],
    [y.load('a: 1\nb: 2\n'), { a: 1, b: 2 }],
  ],
  'yaml-block-chomping': (y) => [
    [y.load('s: |-\n  text\n\n').s, 'text'],
    [y.load('s: |+\n  text\n\n').s, 'text\n\n'],
    [y.load('s: |\n  text\n\n').s, 'text\n'],
    [y.load('s: >-\n  a\n  b\n').s, 'a b'],
    [y.load('s: >+\n  a\n\n').s, 'a\n\n'],
  ],
  'commander-long-equals': (c) => {
    const parse = (args, setup) => {
      const program = new c.Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
      setup(program);
      program.parse(args, { from: 'user' });
      return program.opts();
    };
    return [
      [parse(['--port=8080'], (p) => p.option('--port <n>')), { port: '8080' }],
      [parse(['--port', '8080'], (p) => p.option('--port <n>')), { port: '8080' }],
      [parse(['--name=a=b'], (p) => p.option('--name <v>')), { name: 'a=b' }],
      [parse(['--color=red'], (p) => p.option('--color [c]')), { color: 'red' }],
      [parse(['-p8080'], (p) => p.option('-p, --port <n>')), { port: '8080' }],
    ];
  },
};

const [mode, id] = process.argv.slice(2);
if (!BUGS[id]) { console.error(`unknown bug: ${id}`); process.exit(2); }
if (mode === 'inject') {
  const bug = BUGS[id];
  const text = readFileSync(bug.file, 'utf8');
  const n = (text.match(new RegExp(bug.find.source, 'g')) || []).length;
  if (n !== 1) { console.error(`${id}: anchor matched ${n} times in ${bug.file}`); process.exit(1); }
  writeFileSync(bug.file, text.replace(bug.find, bug.replace));
} else if (mode === 'check') {
  const require = createRequire(join(process.cwd(), 'index.js'));
  let lib;
  try { lib = require('./index.js'); } catch (e) { console.error(`cannot load: ${e.message}`); process.exit(1); }
  let results;
  try { results = CHECKS[id](lib); } catch (e) { console.error(`check threw: ${e.message}`); process.exit(1); }
  const fails = results.filter(([got, want]) => !same(got, want));
  for (const [got, want] of fails) console.error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  process.exit(fails.length ? 1 : 0);
} else { console.error('mode: inject | check'); process.exit(2); }
