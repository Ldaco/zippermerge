#!/usr/bin/env node
// zippermerge commit guard (see CLAUDE.md in this folder).
//   node guard.mjs check [--slug S] [--cwd DIR]
//   node guard.mjs hook        (Claude Code PreToolUse: JSON on stdin)
// Read-only. Fails open on any internal error.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_ROOT, CHAT_SH, HUMAN, MIG_DIR, REPO } from './config.mjs';

const run = promisify(execFile);
const msysToWin = (p) => p.replace(/^\/([a-zA-Z])(\/|$)/, (_m, d, s) => `${d.toUpperCase()}:${s || '/'}`);
const CHAT_DIR = msysToWin(CHAT_ROOT);
const REPO_COMMON = process.env.ZM_REPO_COMMON || (REPO ? `${REPO}/.git` : '');
const MIG_RE = new RegExp(`^${MIG_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{3})_.+\\.sql$`);

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function readGit(dir, [command, ...args], options, overrides) {
  try {
    // Policy paths are relative to the repository root, even from a subdirectory.
    if (command === 'ls-tree' && !args.includes('--full-tree')) args.unshift('--full-tree');
    const env = { ...process.env };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const { stdout } = await run('git', ['-C', dir, ...options, command, ...args], {
      env, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readField(file, key) {
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith(`${key}: `)) return line.slice(key.length + 2).trim();
    }
  } catch { /* ignore */ }
  return null;
}

// ---- command parsing (hook mode) ----
const compoundKeywords = new Set(['!', 'if', 'then', 'elif', 'else', 'fi']);
const shellPrefixes = new Set(['while', 'until', 'do']);
const unknownExpansion = '\0';

function commandSubstitution(source, start) {
  if (source[start] === '`') {
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '`') {
        const { segments } = tokenize(source.slice(start + 1, i));
        return { end: i + 1, commands: [segments], output: segments };
      }
    }
    return;
  }
  if (!source.startsWith('$(', start)) return;
  if (!source.startsWith('$((', start)) {
    const { end, segments } = tokenize(source, start + 2, true);
    if (end) return { end, commands: [segments], output: segments };
    return;
  }
  // Arithmetic delimiters are punctuation, while nested substitutions use the shell lexer.
  const commands = [];
  let depth = 2;
  let quote;
  for (let i = start + 3; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote !== "'" && (source.startsWith('$(', i) || c === '`')) {
      const nested = commandSubstitution(source, i);
      if (nested) { commands.push(...nested.commands); i = nested.end - 1; continue; }
    }
    if (c === quote) quote = undefined;
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (!quote && c === '(') depth++;
    else if (!quote && c === ')' && --depth === 0) return { end: i + 1, commands };
  }
}

function shellExpansion(source, start) {
  const command = commandSubstitution(source, start);
  if (command) return command;
  if (source[start] !== '$') return;
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\d+|[*@#])\}|([A-Za-z_][A-Za-z0-9_]*|[0-9*@#]))/.exec(source.slice(start));
  if (variable) return { end: start + variable[0].length, name: variable[1] || variable[2] };
  const other = /^\$(?:\{[^}]*\}|[0-9*@#?!$-])/.exec(source.slice(start));
  if (other) return { end: start + other[0].length };
}

function readHereDocument(source, start, { delimiter, stripTabs, quoted }) {
  const body = [];
  let offset = start;
  let joined = '';
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const end = newline < 0 ? source.length : newline;
    let line = source.slice(offset, end).replace(/\r$/, '');
    offset = newline < 0 ? end : end + 1;
    if (stripTabs) line = line.replace(/^\t+/, '');
    joined += line;
    if (!quoted && newline >= 0 && (line.match(/\\+$/)?.[0].length % 2 === 1)) {
      joined = joined.slice(0, -1);
      continue;
    }
    if (joined === delimiter) return { body: body.join('\n'), offset };
    body.push(joined);
    joined = '';
  }
  if (joined) body.push(joined);
  return { body: body.join('\n'), offset };
}

const redirectionOperators = ['<<<', '<<-', '<<', '<&', '<>', '&>>', '&>', '>&', '>>', '>|', '<', '>'];
const continuationOperators = ['&&', '||', '|', '|&'];

function tokenize(source, start = 0, untilClose = false) {
  const segments = [];
  const pendingDocuments = [];
  let words = [];
  let redirections = [];
  let redirect;
  let text = '';
  let assignment;
  let expansions = [];
  let started = false;
  let quoted = false;
  let quote;
  let parens = 0;
  const pushWord = () => {
    if (!started) return;
    const word = { text, expansions, quoted, assignment };
    if (redirect) {
      redirect.word = word;
      redirections.push(redirect);
      if (redirect.op === '<<' || redirect.op === '<<-') {
        pendingDocuments.push(redirect);
      }
      redirect = undefined;
    } else if (!quoted && !words.length && compoundKeywords.has(text)) {
      segments.push(text);
    } else {
      words.push(word);
    }
    text = '';
    assignment = undefined;
    expansions = [];
    started = false;
    quoted = false;
  };
  const pushCommand = () => {
    pushWord();
    if (words.length || redirections.length) segments.push({ words, redirections });
    words = [];
    redirections = [];
  };
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\\' && quote !== "'") {
      if (next === '\n') { i++; continue; }
      if (next === '\r' && source[i + 2] === '\n') { i += 2; continue; }
      if (next && (!quote || /[\\"$`]/.test(next))) {
        text += next;
        i++;
        started = true;
        quoted = true;
        continue;
      }
    }
    if (c === quote) { quote = undefined; continue; }
    if (!quote && (c === '"' || c === "'")) { quote = c; quoted = true; started = true; continue; }
    if (quote !== "'" && (c === '$' || c === '`')) {
      const expansion = shellExpansion(source, i);
      if (expansion) {
        const raw = source.slice(i, expansion.end);
        expansions.push({ ...expansion, at: text.length, length: raw.length });
        text += raw;
        i = expansion.end - 1;
        started = true;
        continue;
      }
    }
    if (quote) { text += c; continue; }
    if (c === '#' && !started) {
      const newline = source.indexOf('\n', i);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }
    if (c === '\n') {
      pushCommand();
      if (!continuationOperators.includes(segments.at(-1))) segments.push(c);
      let offset = i + 1;
      for (const document of pendingDocuments) {
        const result = readHereDocument(source, offset, {
          delimiter: document.word.text, stripTabs: document.op === '<<-', quoted: document.word.quoted,
        });
        document.body = result.body;
        offset = result.offset;
      }
      pendingDocuments.length = 0;
      i = offset - 1;
      continue;
    }
    if (/\s/.test(c)) { pushWord(); continue; }
    const op = /[<>&]/.test(c) && redirectionOperators.find((operator) => source.startsWith(operator, i));
    if (op) {
      const explicit = started && !quoted && !redirect && /^\d+$/.test(text);
      const fd = explicit ? Number(text) : Number(op[0] !== '<');
      if (explicit) { text = ''; started = false; }
      pushWord();
      redirect = { op, fd };
      i += op.length - 1;
      continue;
    }
    const beforeGroup = words.every((word) => !word.quoted && shellPrefixes.has(word.text))
      || (words.length === 2 && words[0].text === 'function');
    const brace = (c === '{' || c === '}') && !started && beforeGroup
      && (!next || /[\s;&|()<>]/.test(next));
    if (brace || /[();&|]/.test(c)) {
      const operator = continuationOperators.find((candidate) => source.startsWith(candidate, i)) || c;
      pushCommand();
      if (c === '(') parens++;
      if (c === ')' && untilClose && parens-- === 0) return { segments, end: i + 1 };
      segments.push(operator);
      i += operator.length - 1;
      continue;
    }
    if (c === '=' && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) assignment = text;
    text += c;
    started = true;
  }
  pushCommand();
  return { segments };
}

function groupCommands(segments) {
  let i = 0;
  const addRedirections = (node) => {
    const next = segments[i];
    if (next?.words?.length === 0) node.redirections = segments[i++].redirections;
    return node;
  };
  function readGroup(opener) {
    const body = read([opener === '(' ? ')' : '}']);
    i++;
    return addRedirections({ body, subshell: opener === '(' });
  }
  function readIf() {
    const branches = [];
    let otherwise;
    while (i < segments.length) {
      const condition = read(['then']);
      if (segments[i++] !== 'then') break;
      branches.push({ condition, body: read(['elif', 'else', 'fi']) });
      const end = segments[i++];
      if (end === 'elif') continue;
      if (end === 'else') { otherwise = read(['fi']); i++; }
      break;
    }
    return addRedirections({ branches, otherwise });
  }
  function read(ends = []) {
    const nodes = [];
    while (i < segments.length && !ends.includes(segments[i])) {
      const segment = segments[i++];
      if (segment === '(' || segment === '{') {
        nodes.push(readGroup(segment));
        continue;
      }
      if (segment === 'if') {
        nodes.push(readIf());
        continue;
      }
      if (typeof segment === 'object') {
        const { words } = segment;
        const keyword = words.length === 2 && !words[0].quoted && words[0].text === 'function';
        const name = words[keyword ? 1 : 0];
        let next = i;
        if (segments[next] === '(' && segments[next + 1] === ')') next += 2;
        if ((keyword || (words.length === 1 && next !== i)) && name && !name.quoted && /^[^/$=\s]+$/.test(name.text)) {
          while (segments[next] === '\n') next++;
          const opener = segments[next];
          if (opener === '{' || opener === '(') {
            i = next + 1;
            nodes.push({ ...readGroup(opener), name: name.text });
            continue;
          }
        }
      }
      nodes.push(segment);
    }
    return nodes;
  }
  return read();
}

const wrapperOptions = new Map([
  ['env', {
    shortFlags: 'iv', shortValues: 'aCSu', dash: true, assignments: true,
    longFlags: ['ignore-environment', 'debug', 'list-signal-handling'],
    longOptional: ['block-signal', 'default-signal', 'ignore-signal'],
    longValues: ['argv0', 'chdir', 'split-string', 'unset'],
  }],
  ['sudo', {
    shortFlags: 'ABbEHkNnPSs', shortValues: 'aCcDgprTtu', assignments: true,
    longFlags: ['askpass', 'bell', 'background', 'set-home', 'reset-timestamp', 'no-update',
      'non-interactive', 'preserve-groups', 'stdin', 'shell'],
    longOptional: ['preserve-env'],
    longValues: ['auth-type', 'close-from', 'login-class', 'chdir', 'group',
      'prompt', 'role', 'command-timeout', 'type', 'user'],
  }],
  ['command', { shortFlags: 'p' }],
  ['nohup', {}],
  ['nice', { shortValues: 'n', longValues: ['adjustment'], numeric: true }],
  ['time', {
    shortFlags: 'apqv', shortValues: 'fo',
    longFlags: ['append', 'portability', 'quiet', 'verbose'], longValues: ['format', 'output'],
  }],
  ['doas', { shortFlags: 'ns', shortValues: 'au' }],
  ['xargs', {
    shortFlags: '0oprtx', shortValues: 'adEILnPs', shortOptional: 'eil',
    longFlags: ['exit', 'interactive', 'no-run-if-empty', 'null', 'open-tty', 'verbose'],
    longOptional: ['eof', 'max-lines', 'replace'],
    longValues: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'],
  }],
  ['timeout', {
    shortFlags: 'v', shortValues: 'ks', operands: 1,
    longFlags: ['foreground', 'preserve-status', 'verbose'], longValues: ['kill-after', 'signal'],
  }],
  ['stdbuf', { shortValues: 'ioe', longValues: ['input', 'output', 'error'] }],
  ['setsid', { shortFlags: 'cfw', longFlags: ['ctty', 'fork', 'wait'] }],
]);

const shellOptions = {
  shortFlags: 'abcefhiklmnprstuvxBEHPTD', shortValues: 'oO', plus: true, shortAttached: false,
  longFlags: ['debugger', 'login', 'noediting', 'noprofile', 'norc', 'posix', 'restricted', 'stdin', 'verbose'],
  longValues: ['init-file', 'rcfile'],
};
const gitSelectors = ['git-dir', 'work-tree', 'namespace'];
const gitOptions = {
  shortFlags: 'pP', shortValues: 'Cc', cluster: false, terminator: false,
  longFlags: ['paginate', 'no-pager', 'bare', 'no-replace-objects', 'no-lazy-fetch', 'no-optional-locks',
    'no-advice', 'literal-pathspecs', 'glob-pathspecs', 'noglob-pathspecs', 'icase-pathspecs'],
  longValues: [...gitSelectors, 'config-env'], longOptional: ['exec-path'],
};

function optionKind(spec, name, long) {
  if (long ? spec.longFlags?.includes(name) : spec.shortFlags?.includes(name)) return 'flag';
  if (long ? spec.longValues?.includes(name) : spec.shortValues?.includes(name)) return 'value';
  if (long ? spec.longOptional?.includes(name) : spec.shortOptional?.includes(name)) return 'optional';
}

// Keep option operands out of the program position. A callback can supply replacement argv (env -S).
function readOptions(args, start, spec, apply) {
  let index = start;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      if (spec.terminator === false) return null;
      index++;
      if (spec.dash && args[index] === '-') { apply({ name: 'i', enabled: true }); index++; }
      return { args, index };
    }
    if (arg === '-' && spec.dash) {
      apply({ name: 'i', enabled: true });
      return { args, index: index + 1 };
    }
    if (spec.numeric && /^-\d+$/.test(arg)) { index++; continue; }
    if (arg.length < 2 || (arg[0] !== '-' && !(spec.plus && arg[0] === '+'))) break;
    index++;

    const long = arg.startsWith('--');
    const equals = long ? arg.indexOf('=') : -1;
    const flags = long ? [arg.slice(2, equals < 0 ? undefined : equals)] : [...arg.slice(1)];
    if (spec.cluster === false && flags.length !== 1) return null;
    for (const [position, name] of flags.entries()) {
      const kind = optionKind(spec, name, long);
      if (!kind || (kind === 'flag' && equals >= 0)) return null;
      let value;
      if (kind !== 'flag') {
        const attached = long ? (equals < 0 ? undefined : arg.slice(equals + 1))
          : (spec.shortAttached !== false && position + 1 < flags.length ? flags.slice(position + 1).join('') : undefined);
        value = attached ?? (kind === 'value' ? args[index++] : undefined);
        if (kind === 'value' && value === undefined) return null;
      }
      const next = apply({ name, value, enabled: arg[0] !== '+' });
      if (next === false) return null;
      if (next) { args = [...next, ...args.slice(index)]; index = 0; break; }
      if (kind !== 'flag' && spec.shortAttached !== false) break;
    }
  }
  return { args, index };
}

const commandName = (token) => path.win32.basename(token).toLowerCase().replace(/\.exe$/, '');
const gitEnvironment = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];
const lookupEnv = (env, name) => env.values.has(name) ? env.values.get(name) : env.inherit ? process.env[name] : undefined;

function expandWord(word, lookup) {
  let result = '';
  let offset = 0;
  for (const expansion of word.expansions) {
    result += word.text.slice(offset, expansion.at);
    const value = expansion.name ? lookup(expansion.name) : literalOutput(expansion.output, lookup);
    result += Array.isArray(value) ? value.join(' ') : value ?? unknownExpansion;
    offset = expansion.at + expansion.length;
  }
  return result + word.text.slice(offset);
}

function expandWords(words, lookup) {
  return words.flatMap((word) => {
    const [expansion] = word.expansions;
    if (word.expansions.length === 1 && expansion.name === '@' && expansion.length === word.text.length) {
      const values = lookup('@');
      if (Array.isArray(values)) return values.map((value) => ({ word, value }));
    }
    return [{ word, value: expandWord(word, lookup) }];
  });
}

function literalOutput(segments, lookup) {
  // A literal output command can supply script input without running any shell code.
  const [node, ...rest] = segments?.filter((segment) => segment !== '\n' && segment !== ';') ?? [];
  if (!node?.words || node.redirections.length || rest.length) return;
  const [program, ...argv] = expandWords(node.words, lookup).map(({ value }) => value);
  if (argv.some((arg) => arg.includes(unknownExpansion))) return;
  if (program === 'echo' && !argv[0]?.startsWith('-') && argv.every((arg) => !arg.includes('\\'))) {
    return argv.join(' ');
  }
  if (program !== 'printf') return;
  const [format, ...values] = argv[0] === '--' ? argv.slice(1) : argv;
  if (!format || format.startsWith('-')) return;
  const escapes = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  let result = '';
  let index = 0;
  let previous;
  let supported = true;
  do {
    previous = index;
    result += format.replace(/\\(.)|%(.)|%$/gs, (sequence, escape, formatCode) => {
      if (escape) return escapes[escape] ?? sequence;
      if (formatCode === 's') return values[index++] ?? '';
      if (formatCode === '%') return '%';
      supported = false;
      return '';
    });
  } while (supported && index > previous && index < values.length);
  if (supported) return result.replace(/\n+$/, '');
}

// env -S implements its own argv grammar, including expansion inside a single argument.
function splitEnvString(source, lookup) {
  const words = [];
  let word = '';
  let started = false;
  let quote;
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const escapes = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 0; i < source.length; i++) {
    let c = source[i];
    if (c === quote) { quote = undefined; continue; }
    if (!quote && (c === '"' || c === "'")) { quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) { endWord(); continue; }
    if (!started && c === '#') break;
    if (c === '$' && quote !== "'") {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(source.slice(i));
      if (!match) return null;
      const value = lookup(match[1]);
      if (value !== undefined) { word += value; started = true; }
      i += match[0].length - 1;
      continue;
    }
    if (c === '\\' && (quote !== "'" || /[\\']/.test(source[i + 1] ?? ''))) {
      c = source[++i];
      if (c === '_' && !quote) { endWord(); continue; }
      if (c === 'c' && !quote) break;
      if (c === '_') c = ' ';
      else if (Object.hasOwn(escapes, c)) c = escapes[c];
      else if (!c || !/["#$'\\]/.test(c)) return null;
    }
    word += c;
    started = true;
  }
  if (quote) return null;
  endWord();
  return words;
}

async function changeDirectory(dir, target) {
  if (!target || target.startsWith('~') || target.includes(unknownExpansion)) return { dir, status: undefined };
  const next = path.resolve(dir, msysToWin(target));
  const info = await stat(next).catch(() => null);
  // A missing or unresolvable target keeps the last known checkout as a possible path.
  return info?.isDirectory() ? { dir: next, status: true } : { dir, status: undefined };
}

async function readInvocation(words, lookup, dir, inherited) {
  const expanded = expandWords(words, lookup);
  let tokens = expanded.map(({ value }) => value);
  let cwd = dir;
  let environment = { inherit: inherited.inherit, values: new Map(inherited.values) };
  const assigned = new Map();
  let external = false;
  let bypassFunctions = false;
  let wrapped = false;
  let assignments = true;
  let i = 0;
  while (i < tokens.length) {
    const prefix = tokens[i];
    const word = expanded[i]?.word;
    const name = wrapped ? (assignments && /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(prefix)?.[1]) : word.assignment;
    if (name) {
      const value = prefix.slice(name.length + 1);
      environment.values.set(name, value);
      if (!wrapped) assigned.set(name, value);
      i++;
      continue;
    }
    const literal = word && !word.quoted && word.text === prefix;
    if (!wrapped && literal && shellPrefixes.has(prefix)) { i++; continue; }
    const program = commandName(prefix);
    const spec = wrapperOptions.get(program);
    if (!spec) break;
    const unset = [];
    let clean = false;
    let target;
    const parsed = readOptions(tokens, i + 1, spec, ({ name, value }) => {
      if (name === 'chdir' || (program === 'env' && name === 'C') || (program === 'sudo' && name === 'D')) target = value;
      if (program !== 'env') return;
      if (name === 'i' || name === 'ignore-environment') clean = true;
      if (name === 'u' || name === 'unset') unset.push(value);
      if (name === 'S' || name === 'split-string') {
        return splitEnvString(value, (key) => lookupEnv(environment, key)) ?? false;
      }
    });
    if (!parsed) return null;
    const reservedTime = !external && !bypassFunctions && literal && prefix === 'time';
    const builtinCommand = !external && prefix === 'command';
    external ||= !reservedTime && !builtinCommand;
    bypassFunctions ||= builtinCommand;
    tokens = parsed.args;
    i = parsed.index + (spec.operands ?? 0);
    assignments = spec.assignments || reservedTime;
    wrapped = true;
    if (target !== undefined) cwd = (await changeDirectory(cwd, target)).dir;
    if (clean) environment = { inherit: false, values: new Map() };
    for (const name of unset) environment.values.set(name, undefined);
  }
  return { args: tokens.slice(i), cwd, environment, assigned, external, bypassFunctions, wrapped };
}

function gitCommitTarget(args, cwd, environment) {
  const options = [];
  const gitEnv = {};
  for (const name of gitEnvironment) {
    if (environment.inherit && !environment.values.has(name)) continue;
    const value = environment.values.get(name);
    gitEnv[name] = value === undefined || value.includes(unknownExpansion) ? undefined
      : name === 'GIT_NAMESPACE' ? value : msysToWin(value);
  }
  const parsed = readOptions(args, 1, gitOptions, ({ name, value }) => {
    if (name === 'C' && value && !value.includes(unknownExpansion)) {
      cwd = path.resolve(cwd, msysToWin(value));
    } else if (gitSelectors.includes(name) && !value.includes(unknownExpansion)) {
      options.push(`--${name}=${name === 'namespace' ? value : msysToWin(value)}`);
    } else if (name === 'bare' || name === 'no-replace-objects' || name === 'no-lazy-fetch') {
      options.push(`--${name}`);
    } else if (name === 'exec-path' && value === undefined) {
      return false;
    }
  });
  if (parsed?.args[parsed.index] === 'commit') return { cwd, options, gitEnv };
}

function hereDocumentWord(source) {
  let text = '';
  const expansions = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && /[\\$`]/.test(source[i + 1] ?? '')) { text += source[++i]; continue; }
    const expansion = c === '$' || c === '`' ? shellExpansion(source, i) : undefined;
    if (!expansion) { text += c; continue; }
    const raw = source.slice(i, expansion.end);
    expansions.push({ ...expansion, at: text.length, length: raw.length });
    text += raw;
    i = expansion.end - 1;
  }
  return { text, expansions };
}

function shellScript(args, inputs) {
  let stdin = false;
  let commandString = false;
  let noexec = false;
  let dumpStrings = false;
  const parsed = readOptions(args, 1, shellOptions, ({ name, value, enabled }) => {
    if (name === 'c') commandString = enabled;
    if (name === 's' || name === 'stdin') stdin = enabled;
    if (name === 'n' || (name === 'o' && value === 'noexec')) noexec = enabled;
    if (name === 'D') dumpStrings = enabled;
  });
  if (!parsed || noexec || dumpStrings) return;
  const operands = parsed.args.slice(parsed.index);
  if (commandString) {
    return { text: operands[0], positionals: operands.length > 1 ? operands.slice(1) : [args[0]] };
  }
  if (stdin || operands.length === 0 || operands[0] === '-') {
    const positionals = operands[0] === '-' ? operands.slice(1) : operands;
    return { text: inputs.get(0), positionals: [args[0], ...positionals], fromStdin: true };
  }
}

function shellValue({ dir, positionals, locals, environment }, name) {
  if (name === 'PWD') return dir;
  if (name === '@') return positionals.slice(1);
  if (name === '*') return positionals.slice(1).join(' ');
  if (name === '#') return String(positionals.length - 1);
  if (/^\d+$/.test(name)) return positionals[Number(name)] ?? '';
  return locals.has(name) ? locals.get(name) : lookupEnv(environment, name);
}

function assignShell(state, assignments, publish = false) {
  if (!assignments.size) return state;
  const locals = new Map(state.locals);
  const environment = { inherit: state.environment.inherit, values: new Map(state.environment.values) };
  for (const [name, value] of assignments) {
    if (publish || lookupEnv(environment, name) !== undefined) {
      locals.delete(name);
      environment.values.set(name, value);
    } else {
      locals.set(name, value);
    }
  }
  return { ...state, locals, environment };
}

async function withShellCall(state, { assigned, environment }, positionals, execute) {
  const bound = { ...state, positionals };
  if (assigned.size) {
    bound.environment = environment;
    bound.locals = new Map(state.locals);
    for (const name of assigned.keys()) bound.locals.delete(name);
  }
  const outcomes = await execute(bound);
  return outcomes.map((outcome) => {
    const result = { ...outcome, positionals: state.positionals };
    if (assigned.size) {
      result.environment = { ...outcome.environment, values: new Map(outcome.environment.values) };
      result.locals = new Map(outcome.locals);
      for (const name of assigned.keys()) {
        const restore = (map, prior) => {
          if (prior.has(name)) map.set(name, prior.get(name));
          else map.delete(name);
        };
        restore(result.environment.values, state.environment.values);
        restore(result.locals, state.locals);
      }
    }
    return result;
  });
}

function* splitCommands(nodes, separators) {
  let start = 0;
  for (const [i, node] of nodes.entries()) {
    if (!separators.includes(node)) continue;
    if (i > start) yield [nodes.slice(start, i), node];
    start = i + 1;
  }
  if (start < nodes.length) yield [nodes.slice(start), undefined];
}

function uniqueStates(states) {
  const references = new Map();
  const seen = new Set();
  const id = (ref) => {
    if (!references.has(ref)) references.set(ref, references.size);
    return references.get(ref);
  };
  return states.filter(({ dir, status, functions, environment, locals, positionals, inputs }) => {
    const key = JSON.stringify([dir, status, id(functions), id(environment), id(locals), id(positionals), id(inputs)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findCommits(source, baseDir) {
  const targets = [];
  const activeFunctions = new Set();

  const freshShell = (dir, positionals, environment, inputs = new Map()) => ({
    dir, positionals, environment, inputs, functions: new Map(), locals: new Map(), status: undefined,
  });
  const scan = (text, state) => walkList(groupCommands(tokenize(text).segments), [state]);

  async function scanExpansions(word, state) {
    for (const { commands } of word.expansions) {
      for (const segments of commands ?? []) await walkList(groupCommands(segments), [state]);
    }
  }

  async function applyRedirections(redirections, state, lookup) {
    if (!redirections?.length) return state.inputs;
    const inputs = new Map(state.inputs);
    for (const { op, fd, body, word } of redirections) {
      let script;
      if (op === '<<' || op === '<<-') {
        script = body;
        if (!word.quoted && body) {
          const document = hereDocumentWord(body);
          await scanExpansions(document, { ...state, inputs });
          script = expandWord(document, lookup);
        }
      } else {
        await scanExpansions(word, { ...state, inputs });
        const value = expandWord(word, lookup);
        if (op === '<<<') script = value;
        else if ((op === '<&' || op === '>&') && /^\d+-?$/.test(value)) {
          const source = parseInt(value, 10);
          script = inputs.get(source);
          if (value.endsWith('-')) inputs.delete(source);
        }
      }
      // Descriptor copies use the source at this point in the redirection list.
      inputs.set(fd, script);
      if (op === '&>' || op === '&>>') inputs.delete(2);
    }
    return inputs;
  }

  // Keep both execution paths for statuses that cannot be determined statically.
  function selectStatus(states, wanted) {
    return states.filter((state) => state.status === wanted || state.status === undefined)
      .map((state) => state.status === wanted ? state : { ...state, status: wanted });
  }

  async function walkList(nodes, states) {
    for (const [list, separator] of splitCommands(nodes, [';', '\n', '&'])) {
      let outcomes = states;
      let condition;
      for (const [pipeline, operator] of splitCommands(list, ['&&', '||'])) {
        const wanted = condition === '&&';
        const next = condition ? selectStatus(outcomes, !wanted) : [];
        const active = condition ? selectStatus(outcomes, wanted) : outcomes;
        for (const state of active) next.push(...await walkPipeline(pipeline, state));
        outcomes = uniqueStates(next);
        condition = operator;
      }
      // Asynchronous lists cannot set the caller's directory or variables.
      states = separator === '&' ? states.map((state) => ({ ...state, status: true })) : outcomes;
    }
    return states;
  }

  async function walkPipeline(nodes, state) {
    let start = 0;
    while (nodes[start] === '!') start++;
    const stages = [...splitCommands(nodes.slice(start), ['|', '|&'])];
    let outcomes = [state];
    for (const [index, [commands]] of stages.entries()) {
      const inputs = index === 0 || !state.inputs.has(0) ? state.inputs : new Map(state.inputs).set(0, undefined);
      outcomes = [{ ...state, inputs }];
      for (const command of commands) {
        const next = [];
        for (const outcome of outcomes) next.push(...await walkCommand(command, outcome));
        outcomes = uniqueStates(next);
      }
    }
    return outcomes.map((outcome) => {
      const { status } = outcome;
      return { ...(stages.length > 1 ? state : outcome), status: start % 2 && status !== undefined ? !status : status };
    });
  }

  async function walkIf(node, state) {
    let remaining = [state];
    const outcomes = [];
    for (const { condition, body } of node.branches) {
      const statuses = await walkList(condition, remaining);
      outcomes.push(...await walkList(body, selectStatus(statuses, true)));
      remaining = selectStatus(statuses, false);
    }
    return outcomes.concat(node.otherwise ? await walkList(node.otherwise, remaining)
      : remaining.map((result) => ({ ...result, status: true })));
  }

  async function walkCommand(node, state) {
    if (typeof node === 'string') return [state];
    if (node.name) {
      const functions = new Map(state.functions);
      functions.set(node.name, node);
      return [{ ...state, functions, status: true }];
    }

    const lookup = (name) => shellValue(state, name);
    for (const word of node.words ?? []) await scanExpansions(word, state);
    const inputs = await applyRedirections(node.redirections, state, lookup);
    const context = inputs === state.inputs ? state : { ...state, inputs };
    let outcomes;
    if (node.branches) outcomes = await walkIf(node, context);
    else if (node.body) outcomes = await walkList(node.body, [context]);
    else outcomes = await runSimple(node.words, context, lookup);
    if (node.subshell) return outcomes.map(({ status }) => ({ ...state, status }));
    return outcomes.map((outcome) => ({ ...outcome, inputs: state.inputs }));
  }

  async function runSimple(words, state, lookup) {
    const invocation = await readInvocation(words, lookup, state.dir, state.environment);
    const complete = (status, result = state) => [{ ...result, status }];
    if (!invocation) return complete(undefined);
    const { args, cwd, environment, assigned, external, bypassFunctions, wrapped } = invocation;
    if (!args.length) return complete(true, wrapped ? state : assignShell(state, assigned));
    if (!external && !bypassFunctions && state.functions.has(args[0])) {
      const definition = state.functions.get(args[0]);
      if (activeFunctions.has(definition)) return complete(undefined);
      activeFunctions.add(definition);
      const body = { ...definition, name: undefined };
      const positionals = [state.positionals[0], ...args.slice(1)];
      try {
        return await withShellCall(state, invocation, positionals, (bound) => walkCommand(body, bound));
      } finally {
        activeFunctions.delete(definition);
      }
    }
    if (!external && args[0] === 'cd') {
      const target = args[1] === '--' ? args[2] : args[1];
      const { dir, status } = await changeDirectory(cwd, target);
      return complete(status, { ...state, dir });
    }
    if (!external && args[0] === 'export') {
      const assignments = new Map();
      for (const arg of args.slice(1)) {
        const binding = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s.exec(arg);
        if (binding) assignments.set(binding[1], binding[2] ?? lookup(binding[1]));
      }
      return complete(true, assignShell(state, assignments, true));
    }
    if (!external && args[0] === 'eval') {
      return withShellCall(state, invocation, state.positionals, (bound) => scan(args.slice(1).join(' '), bound));
    }

    const program = commandName(args[0]);
    if (program === 'true' || program === ':') return complete(true);
    if (program === 'false') return complete(false);
    if (program === 'git') {
      const target = gitCommitTarget(args, cwd, environment);
      if (target) targets.push(target);
    } else if (program === 'bash' || program === 'sh') {
      const script = shellScript(args, state.inputs);
      if (script?.text) {
        // The shell consumes its input script. Its children cannot replay that stream from the start.
        const inputs = script.fromStdin ? new Map(state.inputs).set(0, undefined) : state.inputs;
        await scan(script.text, freshShell(cwd, script.positionals, environment, inputs));
      }
    }
    return complete(undefined);
  }

  await scan(source, freshShell(baseDir, ['bash'], { inherit: true, values: new Map() }));
  return targets;
}

// ---- checks ----
async function inferSlug(chatDir, folder) {
  let files;
  try { files = (await readdir(path.join(chatDir, 'status'))).filter((f) => f.endsWith('.md')); } catch { return null; }
  const esc = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, 'i');
  const hits = [];
  for (const f of files) {
    try {
      if (re.test(await readFile(path.join(chatDir, 'status', f), 'utf8'))) hits.push(f.replace(/\.md$/, ''));
    } catch { /* ignore */ }
  }
  return hits.length === 1 ? hits[0] : null;
}

async function hotFiles(chatDir, mySlug, staged) {
  const out = [];
  let files;
  try { files = (await readdir(path.join(chatDir, 'status'))).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const session = f.replace(/\.md$/, '');
    if (session === mySlug) continue;
    let text;
    try { text = await readFile(path.join(chatDir, 'status', f), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^Hot files:/.test(l));
    if (start < 0) continue;
    const section = [lines[start].replace(/^Hot files:/, '')];
    for (let k = start + 1; k < lines.length; k++) {
      if (/^[A-Za-z][A-Za-z0-9 ()\/-]*:(\s|$)/.test(lines[k])) break;
      section.push(lines[k]);
    }
    for (const file of staged) {
      const base = file.split('/').pop();
      const hit = section.find((l) => l.includes(base));
      if (hit) out.push({ level: 'WARN', msg: `${base} is in ${session}'s Hot files: ${hit.trim().slice(0, 160)}` });
    }
  }
  return out;
}

// ---- reservations ----
function globToRegExp(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

async function activeReservations(chatDir, now) {
  const out = [];
  let files;
  try { files = (await readdir(path.join(chatDir, 'reservations'))).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const file = path.join(chatDir, 'reservations', f);
    const owner = await readField(file, 'owner');
    const pattern = await readField(file, 'pattern');
    const exp = Number(await readField(file, 'expires_epoch'));
    if (!owner || !pattern || !Number.isFinite(exp) || exp * 1000 <= now) continue;
    out.push({
      owner,
      pattern,
      mode: (await readField(file, 'mode')) || 'shared',
      why: (await readField(file, 'why')) || 'no reason given',
      exp,
    });
  }
  return out;
}

const hhmmz = (epoch) => `${new Date(epoch * 1000).toISOString().slice(11, 16)}Z`;

async function reservationChecks(chatDir, mySlug, staged) {
  const out = [];
  const list = await activeReservations(chatDir, Date.now());
  for (const r of list) {
    if (mySlug && r.owner === mySlug) continue;
    let re;
    try { re = globToRegExp(r.pattern); } catch { continue; }
    for (const file of staged) {
      if (!re.test(file)) continue;
      const exclusive = r.mode === 'exclusive';
      out.push({
        level: exclusive && mySlug ? 'BLOCK' : 'WARN',
        msg: exclusive
          ? `${file} is exclusively reserved by ${r.owner} until ${hhmmz(r.exp)} (${r.why})${mySlug ? '' : '; guard could not identify this session (use --slug or ZM_SLUG)'}`
          : `${file} is reserved (shared) by ${r.owner} until ${hhmmz(r.exp)} (${r.why})`,
      });
    }
  }
  return out;
}

async function evaluate(dir, slugArg, { options = [], gitEnv = {} } = {}) {
  const git = (cwd, args) => readGit(cwd, args, options, gitEnv);
  const results = [];
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null) return { results, inScope: false };
  const commonAbs = path.resolve(dir, msysToWin(common));
  if (norm(commonAbs) !== norm(path.resolve(msysToWin(REPO_COMMON)))) return { results, inScope: false };
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  const folder = top ? path.basename(top) : path.basename(dir);

  let slug = slugArg || process.env.ZM_SLUG || null;
  if (!slug) slug = await inferSlug(CHAT_DIR, folder);

  const stagedOut = await git(dir, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  const staged = (stagedOut || '').split(/\r?\n/).filter(Boolean);

  // Rule 1: migrations
  const migs = staged.filter((f) => MIG_RE.test(f));
  if (migs.length) {
    const tree = await git(dir, ['ls-tree', '--name-only', 'origin/main', `${MIG_DIR}/`]);
    if (tree === null) {
      results.push({ level: 'WARN', msg: 'origin/main not found; skipped migration checks' });
    } else {
      const onMain = new Set(tree.split(/\r?\n/).filter(Boolean));
      let max = 0;
      for (const p of onMain) {
        const m = /^(\d+)_/.exec(p.split('/').pop());
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      for (const f of migs) {
        if (onMain.has(f)) continue;
        const num = MIG_RE.exec(f)[1];
        const n = parseInt(num, 10);
        if (n <= max) {
          results.push({ level: 'BLOCK', msg: `${f} is numbered ${num}, at or below origin/main's highest (${String(max).padStart(3, '0')}): renumber upward: chat.sh migration <slug> <name> "<ref>"` });
          continue;
        }
        const claim = path.join(CHAT_DIR, 'claims', `migration-${num}.md`);
        if (!(await exists(claim))) {
          results.push({ level: 'BLOCK', msg: `migration ${num} unclaimed: run bash ${CHAT_SH} claim-number ${slug || '<slug>'} ${num} <name> "<ref>" first` });
          continue;
        }
        const owner = (await readField(claim, 'owner')) || '?';
        if (slug) {
          if (owner !== slug) results.push({ level: 'BLOCK', msg: `migration ${num} claimed by ${owner}, not ${slug}` });
        } else {
          results.push({ level: 'WARN', msg: `migration ${num} is claimed by ${owner}; guard could not identify this session (use --slug or ZM_SLUG)` });
        }
      }
    }
  }

  // Rule 2: freeze
  const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (branch === 'main') {
    const lock = path.join(CHAT_DIR, 'locks', 'main-freeze.md');
    if (await exists(lock)) {
      const owner = (await readField(lock, 'owner')) || '?';
      if (owner !== slug) results.push({ level: 'BLOCK', msg: `main-freeze is held by ${owner}; do not commit on main` });
    }
  }

  // Rule 3: hot files
  results.push(...(await hotFiles(CHAT_DIR, slug, staged)));

  // Rule 4: file reservations held by other sessions
  results.push(...(await reservationChecks(CHAT_DIR, slug, staged)));
  return { results, inScope: true };
}

function report(results, stream) {
  for (const r of results) stream.write(`zippermerge guard: ${r.level} ${r.msg}\n`);
}

async function main() {
  const mode = process.argv[2];
  const argv = process.argv.slice(3);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  if (mode === 'check') {
    const { results } = await evaluate(path.resolve(opt('--cwd') || process.cwd()), opt('--slug'));
    report(results, process.stdout);
    process.exitCode = results.some((r) => r.level === 'BLOCK') ? 2 : 0;
    return;
  }
  if (mode === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    if (input.tool_name !== 'Bash') return;
    const cmd = input.tool_input && input.tool_input.command;
    if (typeof cmd !== 'string') return;
    const targets = await findCommits(cmd, path.resolve(msysToWin(input.cwd || process.cwd())));
    if (!targets.length) return;
    // identity/<session_id>.json is written by capture.mjs when it sees a chat.sh call
    let learned;
    try {
      const sid = typeof input.session_id === 'string' ? input.session_id : '';
      if (/^[A-Za-z0-9_-]{1,100}$/.test(sid)) {
        const j = JSON.parse(await readFile(path.join(CHAT_DIR, 'identity', `${sid}.json`), 'utf8'));
        if (typeof j.slug === 'string' && /^[a-z0-9_-]{1,24}$/.test(j.slug) && j.slug !== HUMAN) learned = j.slug;
      }
    } catch { /* no identity yet */ }
    const seen = new Set();
    const reported = new Set();
    for (const target of targets) {
      const key = JSON.stringify(target, (_key, value) => value === undefined ? null : value);
      if (seen.has(key)) continue;
      seen.add(key);
      const { results } = await evaluate(target.cwd, process.env.ZM_SLUG ? undefined : learned, target);
      report(results.filter(({ level, msg }) => {
        const line = `${level} ${msg}`;
        if (reported.has(line)) return false;
        reported.add(line);
        return true;
      }), process.stderr);
      if (results.some((r) => r.level === 'BLOCK')) process.exitCode = 2;
    }
    return;
  }
  process.stderr.write('usage: guard.mjs check [--slug S] [--cwd DIR] | guard.mjs hook\n');
}

main().catch((e) => {
  process.stderr.write(`zippermerge guard: WARN internal error, failing open: ${e && e.message ? e.message : e}\n`);
});
