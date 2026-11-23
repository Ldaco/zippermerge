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

function git(cwd, args, allowMissing = false) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd, env: gitEnv, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch (error) {
    // A repo with no origin can use its common directory. A failed lookup
    // must not choose a different lock key from a successful lookup.
    return allowMissing && error.status === 1 ? '' : null;
  }
}

function repositoryAt(cwd) {
  const paths = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [top, common] = paths?.split(/\r?\n/) || [];
  if (!top || !common) return null;
  const origin = git(cwd, ['config', '--get', 'remote.origin.url'], true);
  if (origin === null) return null;
  const identity = githubIdentity(origin) || pathIdentity(canonicalPath(common, cwd));
  return { top: canonicalPath(top, cwd), identity };
}

export function fullTestScope(dir) {
  const cwd = canonicalPath(dir);
  const repo = repositoryAt(cwd);
  if (!repo) return null;

  // The configured GitHub identity works even when the configured clone's
  // Windows path is inaccessible from a WSL checkout of the same project.
  let legacyIdentity = REPO && githubIdentity(`https://github.com/${PR_REPO}`);
  if (REPO && !legacyIdentity) {
    const configured = path.relative(cwd, REPO) ? repositoryAt(REPO) : repo;
    if (!configured) return null;
    legacyIdentity = configured.identity;
  }
  const { identity, top } = repo;
  const github = identity.startsWith('github:');
  const label = (github ? identity.slice('github:'.length) : top).replace(/[\r\n]/g, ' ');
  // The configured repository owns the original slot, including any lock
  // held when this version is installed and its existing release history.
  const name = identity === legacyIdentity
    ? 'full-test-suite'
    : `full-test-suite-${createHash('sha256').update(identity).digest('hex')}`;
  return { name, label, top, quickTests: identity === 'github:ldaco/zippermerge' };
}

async function waitForChange(file, milliseconds) {
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
    timer = setTimeout(done, Math.min(milliseconds, 5000));
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

function windowsParent(pid) {
  // Git Bash reports PPID=1 for a native launcher such as an agent or Node.
  // Query the native Bash process once to retain the actual launcher's PID.
  if (process.platform !== 'win32' || !/^[1-9]\d*$/.test(pid)) return null;
  const parent = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}").ParentProcessId`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  return /^[1-9]\d*$/.test(parent) ? parent : null;
}

if (process.argv[1] && !path.relative(
  canonicalPath(process.argv[1]), canonicalPath(fileURLToPath(import.meta.url)),
)) {
  const [command, value, limit] = process.argv.slice(2);
  if (command === 'scope') {
    const scope = fullTestScope(value);
    if (scope) process.stdout.write(`${scope.name}\n${scope.label}\n`);
    else process.exitCode = 1;
  } else if (command === 'wait') {
    await waitForChange(value, Number(limit));
  } else if (command === 'windows-parent') {
    try {
      const parent = windowsParent(value);
      if (parent) process.stdout.write(parent);
      else process.exitCode = 1;
    } catch {
      process.exitCode = 1;
    }
  } else if (command === 'windows-alive') {
    try {
      process.kill(Number(value), 0);
    } catch (error) {
      // EPERM still means the process exists.
      if (error.code !== 'EPERM') process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }
}
