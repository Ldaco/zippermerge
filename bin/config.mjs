// Per-project settings, from config.env in the chat folder. A real environment variable wins.
//   ZM_REPO      path to the main clone of the repo being coordinated
//   ZM_MIG_DIR   repo-relative migrations folder
//   ZM_HUMAN     the slug reserved for the person, who posts through the dashboard
//   ZM_PR_REPO   owner/name on GitHub, or empty to skip every GitHub call
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHAT_ROOT = process.env.CHAT_DIR || process.env.ZM_DIR || path.resolve(HERE, '..');

try {
  // Match chat.sh's assignment syntax, including a UTF-8 BOM and matching quotes.
  const config = readFileSync(path.join(CHAT_ROOT, 'config.env'), 'utf8').replace(/^\uFEFF/, '');
  for (const line of config.split('\n')) {
    const m = /^[ \t\r\v\f]*(ZM_[A-Z_]+)=([^\n]*)$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    const value = m[2].replace(/^[ \t\r\v\f]+|[ \t\r\v\f]+$/g, '');
    process.env[m[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
} catch { /* no config file: defaults below */ }

const repo = process.env.ZM_REPO || '';
export const REPO = process.platform === 'win32'
  ? repo.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  : repo;
export const MIG_DIR = (process.env.ZM_MIG_DIR || 'migrations').replace(/\\/g, '/').replace(/\/+$/, '');
export const HUMAN = process.env.ZM_HUMAN || 'human';
export const PR_REPO = process.env.ZM_PR_REPO || '';
export const CHAT_SH = `${CHAT_ROOT.replace(/\\/g, '/')}/chat.sh`;

export function repoPathKey(p) {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    // Git may report the long name for an 8.3 alias or the target of a junction.
    try { resolved = realpathSync.native(resolved); } catch { /* use the lexical path if unavailable */ }
  }
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
