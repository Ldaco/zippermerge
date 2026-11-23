import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PR_REPO, REPO, canonicalPath } from './config.mjs';

const gitEnv = { ...process.env };
// Git hooks can inherit a repository override. Scope the lock from the
// requested directory, including when --repo selects a different checkout.
for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) delete gitEnv[name];

// A GitHub repository can have several clones, including native Windows and
// WSL checkouts. Match HTTPS and SSH origins without exposing credentials.
function githubIdentity(remote) {
  let repo;
  const ssh = /^git@github\.com:(.+)$/i.exec(remote);
  if (ssh) repo = ssh[1];
  else {
    try {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      if (url.hostname !== 'github.com' && url.hostname !== 'ssh.github.com') return null;
      repo = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  repo = repo.replace(/\/$/, '').replace(/\.git$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `github:${repo.toLowerCase()}` : null;
}

function pathIdentity(value) {
  return `path:${process.platform === 'win32' ? value.toLowerCase() : value}`;
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd, env: gitEnv, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return '';
  }
}

function repositoryAt(cwd) {
  const [top, common] = git(cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir').split(/\r?\n/);
  if (!top || !common) return null;
  const identity = githubIdentity(git(cwd, 'config', '--get', 'remote.origin.url'))
    || pathIdentity(canonicalPath(common, cwd));
  return { top: canonicalPath(top, cwd), identity };
}

export function fullTestScope(dir, { fallback = false } = {}) {
  const cwd = canonicalPath(dir);
  const repo = repositoryAt(cwd);
  if (!repo && !fallback) return null;

  const configured = !REPO ? null : path.relative(cwd, REPO) ? repositoryAt(REPO) : repo;
  const legacyIdentity = REPO && (configured?.identity
    || githubIdentity(`https://github.com/${PR_REPO}`) || pathIdentity(REPO));
  const identity = repo?.identity || legacyIdentity || pathIdentity(cwd);
  const github = identity.startsWith('github:');
  const label = (github ? identity.slice('github:'.length) : repo?.top || REPO || cwd).replace(/[\r\n]/g, ' ');
  // The configured repository owns the original slot, including any lock
  // held when this version is installed and its existing release history.
  const name = identity === legacyIdentity
    ? 'full-test-suite'
    : `full-test-suite-${createHash('sha256').update(identity).digest('hex')}`;
  return { name, label, top: repo?.top, quickTests: identity === 'github:ldaco/zippermerge' };
}

async function waitForChange(file) {
  // Watch the containing directory so a rename/removal works on Windows too.
  // Recheck after subscribing, and periodically recover from dropped events
  // or a dead waiter whose OS lease closed without removing its ticket.
  await new Promise((resolve) => {
    let watcher;
    let timer;
    const done = () => {
      watcher?.close();
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, 5000);
    try {
      watcher = watch(path.dirname(file), () => {
        if (!existsSync(file)) done();
      });
      watcher.on('error', () => watcher.close());
    } catch {
      // The timeout also works on filesystems where watch is unavailable.
    }
    if (!existsSync(file)) done();
  });
}

if (process.argv[1] && !path.relative(
  canonicalPath(process.argv[1]), canonicalPath(fileURLToPath(import.meta.url)),
)) {
  const [command, value, requirement] = process.argv.slice(2);
  if (command === 'scope') {
    const scope = fullTestScope(value, { fallback: requirement !== 'required' });
    if (scope) process.stdout.write(`${scope.name}\n${scope.label}\n`);
    else process.exitCode = 1;
  } else if (command === 'wait') {
    await waitForChange(value);
  } else {
    process.exitCode = 1;
  }
}
