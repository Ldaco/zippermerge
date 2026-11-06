// Per-project settings, from config.env in the chat folder. A real environment variable wins.
//   ZM_REPO      path to the main clone of the repo being coordinated
//   ZM_MIG_DIR   repo-relative migrations folder
//   ZM_HUMAN     the slug reserved for the person, who posts through the dashboard
//   ZM_PR_REPO   owner/name on GitHub, or empty to skip every GitHub call
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHAT_ROOT = process.env.CHAT_DIR || process.env.ZM_DIR || path.resolve(HERE, '..');

try {
  for (const line of readFileSync(path.join(CHAT_ROOT, 'config.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*(ZM_[A-Z_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no config file: defaults below */ }

export const REPO = process.env.ZM_REPO || '';
export const MIG_DIR = (process.env.ZM_MIG_DIR || 'migrations').replace(/\\/g, '/').replace(/\/+$/, '');
export const HUMAN = process.env.ZM_HUMAN || 'human';
export const PR_REPO = process.env.ZM_PR_REPO || '';
export const CHAT_SH = `${CHAT_ROOT.replace(/\\/g, '/')}/chat.sh`;
