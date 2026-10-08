// Sugere seções de revisão somente quando o próprio Markdown liga uma fonte à seção.
// Ausência de correspondência nunca suprime um aviso de documentação desatualizada.

function normalizar(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function basename(value) {
  return normalizar(value).split('/').filter(Boolean).at(-1) || '';
}

function pathCandidates(source) {
  const path = normalizar(source).replace(/^\.\//, '');
  return [...new Set([path, path.replace(/^.*?\//, '')])].filter(Boolean);
}

function sourceMentioned(text, source) {
  const haystack = normalizar(text);
  return pathCandidates(source).some((candidate) => haystack.includes(candidate));
}

function basenameMentioned(text, source) {
  const name = basename(source);
  if (!name || name.length < 4) return false;
  // Delimitadores impedem que foo.sql seja inferido a partir de myfoo.sql.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(text);
}

function sectionsOf(markdown) {
  const lines = String(markdown || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections = [];
  const stack = [];
  let inFrontmatter = lines[0]?.trim() === '---';
  let firstLine = true;
  let fence = null;

  for (const line of lines) {
    if (inFrontmatter) {
      if (!firstLine && line.trim() === '---') inFrontmatter = false;
      firstLine = false;
      continue;
    }
    firstLine = false;

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const section = { level, title: heading[2].trim(), text: heading[2].trim() };
      sections.push(section);
      stack.push(section);
    } else if (stack.length) {
      stack.at(-1).text += `\n${line}`;
    }
  }
  return sections;
}

/** Return up to `limit` headings whose own text names one of the changed source files. */
export function markdownSectionsForSources(markdown, sources, limit = 3) {
  const sections = sectionsOf(markdown);
  const paths = [...new Set((sources || []).map((source) => String(source || '')).filter(Boolean))];
  const matches = new Set();

  for (const source of paths) {
    const exact = sections.filter((section) => sourceMentioned(section.text, source));
    if (exact.length) {
      for (const section of exact) matches.add(section);
      continue;
    }
    // Basename-only references are useful only when they point to one section. If duplicated,
    // avoid guessing which area the author meant.
    const byName = sections.filter((section) => basenameMentioned(section.text, source));
    if (byName.length === 1) matches.add(byName[0]);
  }

  return [...matches].slice(0, Math.max(0, limit)).map((section) => `${'#'.repeat(section.level)} ${section.title}`);
}
