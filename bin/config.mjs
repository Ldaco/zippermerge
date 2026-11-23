// Per-project settings, from config.env in the chat folder. A real environment variable wins.
//   ZM_REPO      path to the main clone of the repo being coordinated
//   ZM_MIG_DIR   repo-relative migrations folder
//   ZM_HUMAN     the slug reserved for the person, who posts through the dashboard
//   ZM_PR_REPO   owner/name on GitHub, or empty to skip every GitHub call
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonicalPath(value, base = '.') {
  if (process.platform !== 'win32') return path.resolve(base, value);

  const windowsPath = (p) => p.replace(/^\/([a-z])(?:\/|$)/i, (_, drive) => `${drive.toUpperCase()}:/`);
  const resolved = path.resolve(windowsPath(base), windowsPath(value));
  let ancestor = resolved;
  // Edit hooks also receive new files. Resolve aliases in the existing prefix
  // while keeping the spelling of any components that have not been created.
  while (true) {
    try {
      return path.join(realpathSync.native(ancestor), path.relative(ancestor, resolved));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return resolved;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      ancestor = parent;
    }
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHAT_ROOT = canonicalPath(process.env.CHAT_DIR || process.env.ZM_DIR || path.join(HERE, '..'));

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
export const REPO = repo && canonicalPath(repo);
const common = process.env.ZM_REPO_COMMON || (REPO ? path.join(REPO, '.git') : '');
export const REPO_COMMON = common && canonicalPath(common);
export const MIG_DIR = (process.env.ZM_MIG_DIR || 'migrations').replace(/\\/g, '/').replace(/\/+$/, '');
export const HUMAN = process.env.ZM_HUMAN || 'human';
export const PR_REPO = process.env.ZM_PR_REPO || '';
export const CHAT_SH = `${CHAT_ROOT.replace(/\\/g, '/')}/chat.sh`;
