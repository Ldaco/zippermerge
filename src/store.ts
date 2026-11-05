import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git } from './git.ts';

/** Every worktree of a repo shares one common dir, so they all find one store. */
export function storeOf(cwd: string): string {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return join(resolve(common), 'zippermerge');
}

function rand(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function writeTemp(file: string, value: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${rand()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  return temp;
}

/** Creates the file only if it does not exist. Returns false if someone else got there first. */
export function writeExclusive(file: string, value: unknown): boolean {
  const temp = writeTemp(file, value);
  try {
    linkSync(temp, file); // atomic and exclusive, and readers never see a half-written file
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeAtomic(file: string, value: unknown): void {
  renameSync(writeTemp(file, value), file);
}

export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function listJson<T>(dir: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson<T>(join(dir, name)))
    .filter((record): record is T & {} => Boolean(record));
}

export function newId(ts = new Date().toISOString()) {
  return `${stamp(new Date(ts))}-${rand(3)}`;
}

/** One file per record, so concurrent writers can never overwrite each other. */
export function appendRecord<T extends object>(dir: string, record: T): T & { id: string; ts: string } {
  const ts = (record as { ts?: string }).ts ?? new Date().toISOString();
  const full = { id: newId(ts), ts, ...record };
  writeAtomic(join(dir, `${full.id}.json`), full);
  return full;
}
