import { fileURLToPath } from 'node:url';

/** Converte URLs de módulo em caminhos nativos, inclusive no Windows. */
export function localPath(relativeUrl, baseUrl = import.meta.url) {
  return fileURLToPath(new URL(relativeUrl, baseUrl));
}
