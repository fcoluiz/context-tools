// Optional, explicit maintenance boundaries. Names are exact outline labels, not fuzzy
// semantic guesses. Unsupported or ambiguous declarations fall back to whole-file review.
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parserForExt } from '../outline.mjs';
import { lerTexto, capabilityForExtension } from './roots.mjs';

export function documentDependencies(metadata, fingerprint, cache = null) {
  if (!metadata.reviewDependencies) return { declared: false };
  let declarations;
  try { declarations = JSON.parse(metadata.reviewDependencies); } catch { return { declared: true, valid: false, reason: 'invalid-dependency-metadata' }; }
  if (!Array.isArray(declarations) || !declarations.length || declarations.length > 120) return { declared: true, valid: false, reason: 'invalid-dependency-metadata' };
  const current = {};
  const represented = new Set();
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.source !== 'string' || !Array.isArray(declaration.symbols) || !declaration.symbols.length) return { declared: true, valid: false, reason: 'invalid-dependency-metadata' };
    const key = Object.keys(fingerprint.sources).find((key) => key.replace(/^\.\//, '') === declaration.source.replace(/^\.\//, ''));
    if (!key || !capabilityForExtension(extname(fingerprint.sourcePaths[key]))?.crossFile) return { declared: true, valid: false, reason: 'unsupported-dependency' };
    const path = fingerprint.sourcePaths[key];
    cache && (cache.dependencies ||= new Map());
    let parsed = cache?.dependencies.get(path);
    if (!parsed) {
      const text = lerTexto(path);
      if (text === null) return { declared: true, valid: false, reason: 'source-unavailable' };
      const lines = text.split(/\r?\n/);
      const symbols = parserForExt(extname(path))(lines);
      parsed = { lines, symbols };
      cache?.dependencies.set(path, parsed);
    }
    for (const label of declaration.symbols) {
      const matches = parsed.symbols.filter((symbol) => symbol.name === label);
      if (typeof label !== 'string' || matches.length !== 1) return { declared: true, valid: false, reason: 'ambiguous-dependency' };
      const symbol = matches[0];
      const index = parsed.symbols.indexOf(symbol);
      const next = parsed.symbols.slice(index + 1).find((item) => item.depth <= symbol.depth);
      const text = parsed.lines.slice(symbol.line - 1, next ? next.line - 1 : parsed.lines.length).join('\n');
      current[`${key}#${label}`] = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    }
    represented.add(key);
  }
  // Every referenced source must be explicitly represented. Partial declarations never hide
  // changes to an undeclared dependency or a newly added source reference.
  if (represented.size !== Object.keys(fingerprint.sources).length) return { declared: true, valid: false, reason: 'incomplete-dependency-scope' };
  let reviewed;
  try { reviewed = JSON.parse(metadata.dependencyFingerprints || '{}'); } catch { reviewed = {}; }
  const complete = reviewed && typeof reviewed === 'object' && !Array.isArray(reviewed)
    && Object.keys(reviewed).length === Object.keys(current).length
    && Object.entries(current).every(([key, value]) => reviewed[key] === value);
  return { declared: true, valid: true, complete: Boolean(complete), current, declarations };
}
