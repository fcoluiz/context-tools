#!/usr/bin/env node
// Shell edits opt into attribution by declaring their targets. No shell guessing, encoding
// conversion, dependency installation, or extra model call is performed by this wrapper.
import { spawnSync } from 'node:child_process';
import { isMain, resolveRoot } from './lib/roots.mjs';
import { safeEditTarget } from './lib/session-write-journal.mjs';

export function editManifest(root, files) {
  if (!files.length || files.length > 2000 || files.some((file) => !safeEditTarget(root, file))) throw new Error('edit targets must belong to the project or declared extraRepos');
  return Buffer.from(JSON.stringify({ version: 1, files: [...new Set(files)] })).toString('base64url');
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'manifest') {
    const files = args.slice(1).filter((arg) => arg.startsWith('--file=')).map((arg) => arg.slice(7));
    if (files.length !== args.length - 1) throw new Error('usage: tracked-edit.mjs manifest --file=path [--file=path]');
    console.log(editManifest(resolveRoot(), files));
    return;
  }
  const separator = args.indexOf('--');
  const marker = args.find((arg) => arg.startsWith('--context-tools-edit='));
  if (!marker || separator !== 1 || args.length <= separator + 1) throw new Error('usage: tracked-edit.mjs --context-tools-edit=TOKEN -- executable [arguments]');
  const value = JSON.parse(Buffer.from(marker.slice('--context-tools-edit='.length), 'base64url').toString('utf8'));
  if (value.version !== 1 || !Array.isArray(value.files) || editManifest(resolveRoot(), value.files) !== marker.slice('--context-tools-edit='.length)) throw new Error('invalid edit manifest');
  const child = spawnSync(args[separator + 1], args.slice(separator + 2), { stdio: 'inherit', shell: false });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(`tracked-edit: ${error.message}`); process.exitCode = 1; }
}
