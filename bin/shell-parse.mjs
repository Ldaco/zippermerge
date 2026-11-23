import path from 'node:path';

// Static Bash command analysis for hooks. Nothing in the input is executed.
// Keep lexical words and redirections separate from command resolution and shell state.

const compoundKeywords = new Set([
  '!', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'select', 'do', 'done', 'case', 'esac',
]);
const unknownExpansion = '\0';
const maxDepth = 64;
const parsedShell = Symbol('parsed shell');

function markIncomplete(status, reason) {
  status.incomplete ??= reason;
}

function sourceSpan(origin, start, end) {
  return typeof origin === 'number' ? { start: origin + start, end: origin + end } : origin;
}

function commandSubstitution(source, start, depth, origin, status) {
  const process = source.startsWith('<(', start) || source.startsWith('>(', start);
  if (source[start] !== '`' && !process && !source.startsWith('$(', start)) return;
  const incomplete = (reason) => {
    markIncomplete(status, reason);
    return { end: source.length, commands: [] };
  };
  if (depth >= maxDepth) return incomplete('shell substitution nesting limit exceeded');
  if (source[start] === '`') {
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '`') {
        const at = typeof origin === 'number' ? origin + start + 1 : origin;
        const { segments } = tokenize(source.slice(start + 1, i), status, 0, false, depth + 1, at);
        return { end: i + 1, commands: [segments], output: segments };
      }
    }
    return incomplete('unterminated command substitution');
  }
  if (!source.startsWith('$((', start)) {
    const { end, segments } = tokenize(source, status, start + 2, true, depth + 1, origin);
    if (end) return { end, commands: [segments], output: process ? undefined : segments };
    return incomplete(process ? 'unterminated process substitution' : 'unterminated command substitution');
  }
  // Arithmetic delimiters are punctuation, while nested substitutions use the shell lexer.
  const commands = [];
  let parentheses = 2;
  let quote;
  for (let i = start + 3; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote !== "'" && (source.startsWith('$(', i) || c === '`')) {
      const nested = commandSubstitution(source, i, depth + 1, origin, status);
      if (nested) { commands.push(...nested.commands); i = nested.end - 1; continue; }
    }
    if (c === quote) quote = undefined;
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (!quote && c === '(') parentheses++;
    else if (!quote && c === ')' && --parentheses === 0) return { end: i + 1, commands };
  }
  return incomplete('unterminated arithmetic expansion');
}

function shellExpansion(source, start, depth, origin, status) {
  const command = commandSubstitution(source, start, depth, origin, status);
  if (command) return command;
  if (source[start] !== '$') return;
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\d+|[*@#])\}|([A-Za-z_][A-Za-z0-9_]*|[0-9*@#]))/.exec(source.slice(start));
  if (variable) return { end: start + variable[0].length, name: variable[1] || variable[2] };
  const fallback = /^\$\{([A-Za-z_]\w*|\d+)(:?)-(.*?)\}/s.exec(source.slice(start));
  if (fallback) return { end: start + fallback[0].length, name: fallback[1], empty: !!fallback[2], fallback: fallback[3] };
  const other = /^\$(?:\{[^}]*\}|[0-9*@#?!$-])/.exec(source.slice(start));
  if (other) return { end: start + other[0].length };
  if (source.startsWith('${', start)) {
    markIncomplete(status, 'unterminated parameter expansion');
    return { end: source.length };
  }
}

function readHereDocument(source, start, { delimiter, stripTabs, quoted }) {
  const body = [];
  let offset = start;
  let joined = '';
  let lineStart = start;
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
    if (joined === delimiter) return { body: body.join('\n'), offset, end: lineStart, closed: true };
    body.push(joined);
    joined = '';
    lineStart = offset;
  }
  if (joined) body.push(joined);
  return { body: body.join('\n'), offset, end: offset };
}

const redirectionOperators = ['<<<', '<<-', '<<', '<&', '<>', '&>>', '&>', '>&', '>>', '>|', '<', '>'];
const continuationOperators = ['&&', '||', '|&', '|'];
const caseOperators = [';;&', ';;', ';&'];
const compoundOperators = [...continuationOperators, ...caseOperators];
const escapes = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

function decodeAnsiC(text) {
  return text.replace(/\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|([0-7]{1,3})|c([?-~])|([\s\S]))/g,
    (raw, hex, short, long, octal, control, character) => {
      if (character) return escapes[character] ?? (/^['"\\?]$/.test(character) ? character : raw);
      const code = control === '?' ? 127 : control ? control.toUpperCase().charCodeAt(0) & 31
        : octal ? parseInt(octal, 8) & 255 : parseInt(hex ?? short ?? long, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function tokenize(source, status, start = 0, untilClose = false, depth = 0, origin = 0) {
  const segments = [];
  const pendingDocuments = [];
  const cases = [];
  let words = [];
  let redirections = [];
  let redirect;
  let text = '';
  let assignment;
  let expansions = [];
  let started = false;
  let quoted = false;
  let quotedRanges = [];
  let explicitQuote = false;
  let quote;
  let parens = 0;
  let wordStart;
  const appendQuoted = (value) => {
    if (!value) return;
    const start = text.length;
    text += value;
    if (quotedRanges.at(-1)?.[1] === start) quotedRanges.at(-1)[1] = text.length;
    else quotedRanges.push([start, text.length]);
  };
  const pushWord = (end) => {
    if (!started) return;
    const word = {
      text, expansions, quoted, quotedRanges, explicitQuote, assignment,
      raw: source.slice(wordStart, end), ...sourceSpan(origin, wordStart, end),
    };
    const pattern = cases.at(-1)?.pattern;
    if (redirect) {
      redirect.word = word;
      redirections.push(redirect);
      if (redirect.op === '<<' || redirect.op === '<<-') {
        pendingDocuments.push(redirect);
      }
      redirect = undefined;
    } else if (!quoted && text === 'in' && cases.at(-1)?.header && words.length === 1) {
      segments.push({ words, redirections }, 'case-in');
      words = [];
      redirections = [];
      cases.at(-1).header = false;
      cases.at(-1).pattern = true;
    } else if (!quoted && !words.length && compoundKeywords.has(text) && (!pattern || text === 'esac')) {
      if (text === 'case') cases.push({ header: true });
      if (text === 'esac') cases.pop();
      segments.push(text);
    } else {
      words.push(word);
    }
    text = '';
    assignment = undefined;
    expansions = [];
    started = false;
    quoted = false;
    quotedRanges = [];
    explicitQuote = false;
  };
  const pushCommand = (end) => {
    pushWord(end);
    if (redirect) {
      markIncomplete(status, 'missing redirection operand');
      redirect = undefined;
    }
    if (words.length || redirections.length) segments.push({ words, redirections });
    words = [];
    redirections = [];
  };
  const finish = () => {
    if (pendingDocuments.length) markIncomplete(status, 'unterminated here-document');
    if (continuationOperators.includes(segments.at(-1))) {
      markIncomplete(status, 'missing command after shell operator');
    }
  };
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (!started) wordStart = i;
    if (c === '\\' && quote !== "'") {
      if (next === '\n') { i++; continue; }
      if (next === '\r' && source[i + 2] === '\n') { i += 2; continue; }
      if (next && (!quote || /[\\"$`]/.test(next))) {
        // Hook input on Windows can contain native paths supplied by the client.
        const nativePath = !quote && /^[\w.:~-]$/.test(next)
          && /^(?:[a-z]:\\|[^\s\\]+\\[^\s\\]+\\)/i.test(source.slice(wordStart));
        appendQuoted(nativePath ? '\\' + next : next);
        i++;
        started = true;
        quoted = true;
        continue;
      }
      if (!next) markIncomplete(status, 'unterminated shell escape');
    }
    if (c === quote) { quote = undefined; continue; }
    if (!quote && c === '$' && next === "'") {
      const ansi = /^\$'((?:\\[\s\S]|[^'\\])*)'/.exec(source.slice(i));
      if (ansi) {
        appendQuoted(decodeAnsiC(ansi[1]));
        i += ansi[0].length - 1;
        quoted = explicitQuote = started = true;
        continue;
      }
    }
    if (!quote && (c === '"' || c === "'" || (c === '$' && next === '"'))) {
      quote = c === '$' ? source[++i] : c;
      quoted = explicitQuote = started = true;
      continue;
    }
    const process = !quote && (c === '<' || c === '>') && next === '(';
    if (quote !== "'" && (c === '$' || c === '`' || process)) {
      const expansion = shellExpansion(source, i, depth, origin, status);
      if (expansion) {
        const raw = source.slice(i, expansion.end);
        expansions.push({ ...expansion, at: text.length, length: raw.length, split: !quote && !process });
        text += raw;
        i = expansion.end - 1;
        started = true;
        continue;
      }
    }
    if (quote) { appendQuoted(c); continue; }
    const caseArm = cases.at(-1);
    if (caseArm?.pattern) {
      const startsExtension = c === '(' && /[?*+@!]$/.test(text) && quotedRanges.at(-1)?.[1] !== text.length;
      if (startsExtension || (caseArm.extensionDepth && /[()|]/.test(c))) {
        if (c === '(') caseArm.extensionDepth = (caseArm.extensionDepth ?? 0) + 1;
        if (c === ')') caseArm.extensionDepth--;
        text += c;
        continue;
      }
    }
    if (c === '#' && !started) {
      const newline = /[\r\n]/.exec(source.slice(i));
      if (!newline) break;
      i += newline.index - 1;
      continue;
    }
    if (c === '\n' || (c === '\r' && next !== '\n')) {
      if (cases.at(-1)?.header) {
        pushWord(i);
        if (words.length === 1) continue;
      }
      pushCommand(i);
      if (!continuationOperators.includes(segments.at(-1))) segments.push('\n');
      let offset = i + 1;
      for (const document of pendingDocuments) {
        const result = readHereDocument(source, offset, {
          delimiter: document.word.text, stripTabs: document.op === '<<-', quoted: document.word.quoted,
        });
        document.body = result.body;
        document.origin = { ...sourceSpan(origin, offset, result.end), cover: true };
        if (!result.closed) markIncomplete(status, 'unterminated here-document');
        offset = result.offset;
      }
      pendingDocuments.length = 0;
      i = offset - 1;
      continue;
    }
    if (/[ \t\r]/.test(c)) { pushWord(i); continue; }
    const op = /[<>&]/.test(c) && redirectionOperators.find((operator) => source.startsWith(operator, i));
    if (op) {
      const explicit = started && !quoted && !redirect && /^\d+$/.test(text);
      const fd = explicit ? Number(text) : Number(op[0] !== '<');
      if (explicit) { text = ''; started = false; }
      pushWord(i);
      if (redirect) markIncomplete(status, 'missing redirection operand');
      redirect = { op, fd };
      i += op.length - 1;
      continue;
    }
    const beforeGroup = words.every((word) => !word.quoted && /^(?:time|-p)$/.test(word.text))
      || (words.length === 2 && words[0].text === 'function');
    const brace = (c === '{' || c === '}') && !started && beforeGroup
      && (!next || /[\s;&|()<>]/.test(next));
    if (brace || /[();&|]/.test(c)) {
      const operator = compoundOperators.find((candidate) => source.startsWith(candidate, i)) || c;
      pushCommand(i);
      const arm = cases.at(-1);
      if (arm?.pattern && c === '(') continue;
      if (arm?.pattern && c === ')') {
        arm.pattern = false;
        segments.push('case-arm');
        continue;
      } else if (c === '(') parens++;
      else if (c === ')' && untilClose && parens-- === 0) {
        finish();
        return { segments, end: i + 1 };
      }
      if (arm && caseOperators.includes(operator)) arm.pattern = true;
      segments.push(operator);
      i += operator.length - 1;
      continue;
    }
    if (c === '=' && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) assignment = text;
    text += c;
    started = true;
  }
  if (quote) markIncomplete(status, 'unterminated shell quote');
  pushCommand(source.length);
  finish();
  return { segments };
}

function groupCommands(segments, status) {
  let i = 0;
  function consume(closer, reason) {
    if (segments[i] === closer) { i++; return true; }
    markIncomplete(status, reason);
    return false;
  }
  const addRedirections = (node) => {
    const next = segments[i];
    if (next?.words?.length === 0) node.redirections = segments[i++].redirections;
    return node;
  };
  function readGroup(opener, depth) {
    const closer = opener === '(' ? ')' : '}';
    const body = read([closer], depth);
    consume(closer, 'unterminated shell group');
    return addRedirections({ body, subshell: opener === '(' });
  }
  function readIf(depth) {
    const branches = [];
    let otherwise;
    while (i < segments.length) {
      const condition = read(['then'], depth);
      if (!consume('then', 'unterminated if condition')) return { branches };
      branches.push({ condition, body: read(['elif', 'else', 'fi'], depth) });
      if (segments[i] === 'elif') {
        i++;
        if (i === segments.length) markIncomplete(status, 'unterminated elif condition');
        continue;
      }
      if (segments[i] === 'else') { i++; otherwise = read(['fi'], depth); }
      consume('fi', 'unterminated if statement');
      break;
    }
    if (!branches.length) markIncomplete(status, 'unterminated if statement');
    return addRedirections({ branches, otherwise });
  }
  function readLoop(loop, depth) {
    const condition = read(['do'], depth);
    if (!consume('do', 'unterminated shell loop')) return { body: [] };
    const body = read(['done'], depth);
    consume('done', 'unterminated shell loop');
    return addRedirections({ loop, condition, body });
  }
  function readCase(depth) {
    const subject = segments[i++]?.words?.[0];
    if (!consume('case-in', 'unterminated case header')) return { body: [] };
    const arms = [];
    while (i < segments.length) {
      while (segments[i] === '\n') i++;
      if (i === segments.length || segments[i] === 'esac') break;
      const pattern = read(['case-arm', 'esac'], depth);
      if (!consume('case-arm', 'unterminated case arm')) break;
      const body = read([...caseOperators, 'esac'], depth);
      const end = segments[i];
      if (caseOperators.includes(end)) i++;
      arms.push({ pattern: pattern.flatMap((node) => node.words ?? []), body, end });
    }
    consume('esac', 'unterminated case statement');
    return addRedirections({ subject, arms });
  }
  function read(ends = [], depth = 0) {
    if (depth >= maxDepth) {
      markIncomplete(status, 'shell group nesting limit exceeded');
      i = segments.length;
      return [];
    }
    const nodes = [];
    while (i < segments.length && !ends.includes(segments[i])) {
      const segment = segments[i++];
      if (segment === '(' || segment === '{') {
        nodes.push(readGroup(segment, depth + 1));
        continue;
      }
      if (segment === 'if') {
        nodes.push(readIf(depth + 1));
        continue;
      }
      if (segment === 'case') {
        nodes.push(readCase(depth + 1));
        continue;
      }
      if (/^(?:while|until|for|select)$/.test(segment)) {
        nodes.push(readLoop(segment, depth + 1));
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
            nodes.push({ ...readGroup(opener, depth + 1), name: name.text });
            continue;
          }
          markIncomplete(status, 'unterminated shell function definition');
        }
      }
      nodes.push(segment);
    }
    return nodes;
  }
  return read();
}

export function parseShell(source) {
  if (source?.[parsedShell]) return source;
  const text = String(source);
  const status = { incomplete: null };
  const { segments } = tokenize(text, status);
  const nodes = groupCommands(segments, status);
  return { [parsedShell]: true, text, segments, nodes, incomplete: status.incomplete };
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
  ['builtin', {}],
  ['exec', { shortFlags: 'cl', shortValues: 'a' }],
  ['cross-env', { assignments: true }],
  ['cross-env-shell', { assignments: true }],
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
const shellBuiltins = new Set([
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen',
  'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec',
  'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let',
  'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly',
  'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);
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
function readOptions(args, start, spec, apply, status) {
  let index = start;
  let expansions = 0;
  while (index < args.length) {
    const optionIndex = index;
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
      let valueIndex = optionIndex;
      if (kind !== 'flag') {
        const attached = long ? (equals < 0 ? undefined : arg.slice(equals + 1))
          : (spec.shortAttached !== false && position + 1 < flags.length ? flags.slice(position + 1).join('') : undefined);
        if (attached === undefined && kind === 'value') valueIndex = index;
        value = attached ?? (kind === 'value' ? args[index++] : undefined);
        if (kind === 'value' && value === undefined) return null;
      }
      const next = apply({ name, value, valueIndex, nextIndex: index, enabled: arg[0] !== '+' });
      if (next === false) return null;
      if (next) {
        if (++expansions > maxDepth) {
          markIncomplete(status, 'shell wrapper expansion limit exceeded');
          return null;
        }
        args = [...next, ...args.slice(index)];
        index = 0;
        break;
      }
      if (kind !== 'flag' && spec.shortAttached !== false) break;
    }
  }
  return { args, index };
}

export const executableName = (token = '') => path.win32.basename(token).replace(/\.(?:exe|cmd|bat)$/i, '');
export const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
export const PACKAGE_OPTIONS = /^(?:--filter|-F|--workspace|-w|--prefix|--cwd|--dir|-C)$/;
const directRunners = /^(vitest|jest|playwright|turbo|tsc)$/;
const execOptions = /^(?:--package|-p|--cache|--registry|--prefix|--userconfig)$/;
const gitEnvironment = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];
function lookupEnv(env, name) {
  if (env.values.has(name)) return env.values.get(name);
  return Object.hasOwn(env.base, name) ? env.base[name] : undefined;
}

export function firstOperand(args, index, valueFlags) {
  for (; index < args.length && args[index].startsWith('-'); index++) {
    if (args[index] === '--') return index + 1;
    if (valueFlags.test(args[index])) index++;
  }
  return index;
}

function expansionValue(expansion, lookup, output) {
  if (!expansion.name) return expansion.output ? output(expansion.output) ?? unknownExpansion : unknownExpansion;
  const value = lookup(expansion.name);
  if (value === undefined || (value === '' && expansion.empty)) return expansion.fallback ?? '';
  return value;
}

function expandWord(word, lookup, output) {
  let result = '';
  let offset = 0;
  for (const expansion of word.expansions) {
    result += word.text.slice(offset, expansion.at);
    const value = expansionValue(expansion, lookup, output);
    result += Array.isArray(value) ? value.join(' ') : value;
    offset = expansion.at + expansion.length;
  }
  return result + word.text.slice(offset);
}

function expandWords(words, lookup, output, assignmentOperands = false) {
  return words.flatMap((word) => {
    if (!word.expansions.length) return [{ word, value: word.text }];
    if (assignmentOperands && /^[A-Za-z_]\w*=/.test(word.text)) {
      return [{ word, value: expandWord(word, lookup, output) }];
    }
    const fields = [];
    let field = '';
    let offset = 0;
    for (const expansion of word.expansions) {
      field += word.text.slice(offset, expansion.at);
      offset = expansion.at + expansion.length;
      const value = expansionValue(expansion, lookup, output);
      const ifs = lookup('IFS');
      const split = expansion.split && ifs !== '';
      const parts = Array.isArray(value) && !split ? value
        : split && ifs !== undefined && ifs !== ' \t\n' ? [unknownExpansion]
          : split ? (Array.isArray(value) ? value.join(' ') : value).split(/[ \t\n]+/) : [value];
      if (parts.length) field += parts[0];
      for (const part of parts.slice(1)) {
        if (field || !split) fields.push(field);
        field = part;
      }
    }
    field += word.text.slice(offset);
    const onlyEmptyAt = word.expansions.length === 1 && word.expansions[0].name === '@'
      && word.expansions[0].length === word.text.length;
    if (field || (word.explicitQuote && !onlyEmptyAt)) fields.push(field);
    return fields.map((value) => ({ word, value }));
  });
}

function literalOutput(segments, lookup, functions, depth = 0) {
  // A literal output command can supply script input without running any shell code.
  const [node, ...rest] = segments?.filter((segment) => segment !== '\n' && segment !== ';') ?? [];
  if (!node?.words || node.redirections.length || rest.length || depth >= maxDepth) return;
  const output = (nested) => literalOutput(nested, lookup, functions, depth + 1)?.replace(/\n+$/, '');
  let [program, ...argv] = expandWords(node.words, lookup, output).map(({ value }) => value);
  if (program === 'builtin' || program === 'command') {
    if (program === 'command' && argv[0] === '-p') argv.shift();
    [program, ...argv] = argv;
  }
  else if (functions.has(program)) return;
  if (argv.some((arg) => arg.includes(unknownExpansion))) return;
  if (program === 'echo' && !argv[0]?.startsWith('-') && argv.every((arg) => !arg.includes('\\'))) {
    return argv.join(' ') + '\n';
  }
  if (program !== 'printf') return;
  const [format, ...values] = argv[0] === '--' ? argv.slice(1) : argv;
  if (!format || format.startsWith('-')) return;
  let result = '';
  let index = 0;
  let previous;
  let supported = true;
  do {
    previous = index;
    result += format.replace(/\\(.)|%(.)|%$/gs, (sequence, escape, formatCode) => {
      if (escape) return decodeAnsiC(sequence);
      if (formatCode === 's') return values[index++] ?? '';
      if (formatCode === 'b') return decodeAnsiC(values[index++] ?? '');
      if (formatCode === '%') return '%';
      supported = false;
      return '';
    });
  } while (supported && index > previous && index < values.length);
  if (supported) return result;
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

function changeDirectory(dir, target, settings) {
  if (!target || target.startsWith('~') || target.includes(unknownExpansion)) return { dir, status: undefined };
  const next = settings.resolvePath(target, dir);
  if (!settings.isDirectory) return { dir: next, status: true };
  const status = settings.isDirectory(next);
  return { dir: status ? next : dir, status };
}

function readInvocation(words, lookup, dir, inherited, output, settings, functions, status) {
  const assigned = new Map();
  let start = 0;
  while (words[start]?.assignment) {
    const word = words[start++];
    assigned.set(word.assignment, expandWord(word, (name) => (
      assigned.has(name) ? assigned.get(name) : lookup(name)
    ), output).slice(word.assignment.length + 1));
  }
  const builtin = words[start]?.text;
  let expanded = expandWords(words.slice(start), lookup, output, /^(?:command|builtin|env|export|declare|local)$/.test(builtin));
  let tokens = expanded.map(({ value }) => value);
  let cwd = dir;
  let environment = { ...inherited, values: new Map([...inherited.values, ...assigned]) };
  let external = false;
  let bypassFunctions = false;
  let wrapper;
  let requireBuiltin = false;
  let keepInputs = false;
  let replaceShell = false;
  let setup;
  let i = 0;
  while (i < tokens.length) {
    const prefix = tokens[i];
    if (requireBuiltin && !shellBuiltins.has(prefix)) return null;
    requireBuiltin = false;
    const name = wrapper?.assignments && /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(prefix)?.[1];
    if (name) {
      environment.values.set(name, prefix.slice(name.length + 1));
      i++;
      continue;
    }
    const word = expanded[i]?.word;
    const literal = word && !word.quoted && word.text === prefix;
    const program = executableName(prefix);
    if (!external && !bypassFunctions && functions.has(prefix)) break;
    if (/^(?:npx|pnpx|bunx)$/.test(program)) {
      i = firstOperand(tokens, i + 1, execOptions);
      external = true;
      continue;
    }
    if (PACKAGE_MANAGERS.test(program)) {
      const operand = firstOperand(tokens, i + 1, PACKAGE_OPTIONS);
      const sub = tokens[operand] ?? '';
      if ((/^(npm|pnpm)$/.test(program) && /^(exec|dlx)$/.test(sub)) || (program === 'bun' && sub === 'x')) {
        i = firstOperand(tokens, operand + 1, execOptions);
        external = true;
        continue;
      }
      if (program !== 'npm' && directRunners.test(executableName(sub))) {
        i = operand;
        external = true;
        continue;
      }
    }
    const spec = wrapperOptions.get(program);
    if (!spec) break;
    if (/^(?:command|builtin|exec)$/.test(program) && (external || prefix !== program)) break;
    const unset = [];
    let clean = false;
    let target;
    let replaced = false;
    const parsed = readOptions(tokens, i + 1, spec, ({ name, value, valueIndex, nextIndex }) => {
      if (name === 'chdir' || (program === 'env' && name === 'C') || (program === 'sudo' && name === 'D')) target = value;
      if (program !== 'env') return;
      if (name === 'i' || name === 'ignore-environment') clean = true;
      if (name === 'u' || name === 'unset') unset.push(value);
      if (name === 'S' || name === 'split-string') {
        const split = splitEnvString(value, (key) => lookupEnv(environment, key));
        if (!split) return false;
        const word = { ...expanded[valueIndex].word, cover: true };
        expanded = [...split.map((value) => ({ word, value })), ...expanded.slice(nextIndex)];
        replaced = true;
        return split;
      }
    }, status);
    if (!parsed) return null;
    const reservedTime = !external && !bypassFunctions && literal && prefix === 'time';
    const builtinCommand = !external && /^(?:command|builtin|exec)$/.test(prefix);
    requireBuiltin = prefix === 'builtin';
    if (prefix === 'exec' && builtinCommand) {
      keepInputs = parsed.index === parsed.args.length;
      replaceShell = !keepInputs;
    }
    external ||= !reservedTime && !builtinCommand;
    bypassFunctions ||= builtinCommand;
    tokens = parsed.args;
    i = parsed.index + (spec.operands ?? 0);
    wrapper = spec;
    if (target !== undefined) {
      const next = changeDirectory(cwd, target, settings);
      cwd = next.dir;
      if (next.status === false) setup = false;
    }
    if (replaced && !tokens[i]) break;
    if (clean) environment = { base: {}, values: new Map() };
    for (const name of unset) environment.values.set(name, undefined);
  }
  const args = expanded.slice(i).map(({ value, word }) => ({ value, ...word }));
  return { args, cwd, environment, assigned, external, bypassFunctions, wrapper, keepInputs, replaceShell, setup };
}

export function gitSubcommand(args, apply = () => {}) {
  const parsed = readOptions(args, 0, gitOptions, (option) => (
    option.name === 'exec-path' && option.value === undefined ? false : apply(option)
  ));
  return parsed?.args[parsed.index];
}

function gitCommitTarget({ args, cwd, environment }, resolvePath) {
  const options = [];
  const gitEnv = {};
  for (const name of gitEnvironment) {
    const value = lookupEnv(environment, name);
    gitEnv[name] = value && !value.includes(unknownExpansion) ? value : undefined;
  }
  const selectors = {};
  const subcommand = gitSubcommand(args.map(({ value }) => value), ({ name, value }) => {
    if (name === 'C' && value && !value.includes(unknownExpansion)) cwd = resolvePath(value, cwd);
    if (gitSelectors.includes(name) && !value.includes(unknownExpansion)) selectors[name] = value;
    if (name === 'bare' || name === 'no-replace-objects' || name === 'no-lazy-fetch') options.push('--' + name);
  });
  if (subcommand !== 'commit') return;
  return { cwd, options, gitEnv, selectors,
    gitDir: selectors['git-dir'] ?? gitEnv.GIT_DIR, workTree: selectors['work-tree'] ?? gitEnv.GIT_WORK_TREE };
}

const shellSetOptions = new Set([
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand',
  'history', 'ignoreeof', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify',
  'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace',
]);
const shellShoptOptions = new Set([
  'assoc_expand_once', 'autocd', 'bash_source_fullpath', 'cdable_vars', 'cdspell', 'checkhash',
  'checkjobs', 'checkwinsize', 'cmdhist', 'compat31', 'compat32', 'compat40', 'compat41', 'compat42',
  'compat43', 'compat44', 'complete_fullquote', 'direxpand', 'dirspell', 'dotglob', 'execfail',
  'expand_aliases', 'extdebug', 'extglob', 'extquote', 'failglob', 'force_fignore', 'globasciiranges',
  'globskipdots', 'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify', 'hostcomplete',
  'huponexit', 'inherit_errexit', 'interactive_comments', 'lastpipe', 'lithist', 'localvar_inherit',
  'localvar_unset', 'login_shell', 'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch',
  'noexpand_translation', 'nullglob', 'patsub_replacement', 'progcomp', 'progcomp_alias', 'promptvars',
  'restricted_shell', 'shift_verbose', 'sourcepath', 'varredir_close', 'xpg_echo',
]);

function hereDocumentWord(source, origin, status) {
  let text = '';
  const expansions = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && /[\\$`]/.test(source[i + 1] ?? '')) { text += source[++i]; continue; }
    const expansion = c === '$' || c === '`' ? shellExpansion(source, i, 0, origin, status) : undefined;
    if (!expansion) { text += c; continue; }
    const raw = source.slice(i, expansion.end);
    expansions.push({ ...expansion, at: text.length, length: raw.length });
    text += raw;
    i = expansion.end - 1;
  }
  return { text, expansions };
}

function shellScript(args, inputs, includeInactive) {
  let stdin = false;
  let commandString = false;
  let noexec = false;
  let dumpStrings = false;
  const values = args.map(({ value }) => value);
  const parsed = readOptions(values, 1, shellOptions, ({ name, value, enabled }) => {
    // A rejected invocation may still contain credentials in its script text.
    if (!includeInactive && name === 'o' && !shellSetOptions.has(value)) return false;
    if (!includeInactive && name === 'O' && !shellShoptOptions.has(value)) return false;
    if (name === 'c') commandString = enabled;
    if (name === 's' || name === 'stdin') stdin = enabled;
    if (name === 'n' || (name === 'o' && value === 'noexec')) noexec = enabled;
    if (name === 'D') dumpStrings = enabled;
  });
  if (!parsed || (!includeInactive && (noexec || dumpStrings))) return null;
  const operands = values.slice(parsed.index);
  if (commandString) {
    const positionals = operands.length > 1 ? operands.slice(1) : [values[0]];
    const word = args[parsed.index];
    return { script: word && { text: word.value, origin: cover(word) }, positionals };
  }
  if (stdin || operands.length === 0 || operands[0] === '-') {
    const positionals = operands[0] === '-' ? operands.slice(1) : operands;
    return { script: inputs.get(0), positionals: [values[0], ...positionals], fromStdin: true };
  }
  return { file: args[parsed.index], args: args.slice(parsed.index + 1) };
}

function cover({ start, end }) {
  return { start, end, cover: true };
}

function shellValue({ dir, positionals, locals, environment }, name) {
  if (name === 'PWD') return dir;
  if (name === '@') return positionals.slice(1);
  if (name === '*') return positionals.slice(1).join(' ');
  if (name === '#') return String(positionals.length - 1);
  if (/^\d+$/.test(name)) return positionals[Number(name)];
  return locals.has(name) ? locals.get(name) : lookupEnv(environment, name);
}

function assignShell(state, assignments, mode) {
  if (!assignments.size) return state;
  const locals = new Map(state.locals);
  const environment = { ...state.environment, values: new Map(state.environment.values) };
  for (const [name, value] of assignments) {
    if (mode === 'unset' || mode === 'unexport') {
      if (mode === 'unset') locals.delete(name);
      else locals.set(name, value);
      environment.values.set(name, undefined);
    } else if (mode === 'export' || lookupEnv(environment, name) !== undefined) {
      locals.delete(name);
      environment.values.set(name, value);
    } else {
      locals.set(name, value);
    }
  }
  return { ...state, locals, environment };
}

function withShellCall(state, { assigned, environment }, positionals, execute) {
  const bound = { ...state, positionals };
  if (assigned.size) {
    bound.environment = environment;
    bound.locals = new Map(state.locals);
    for (const name of assigned.keys()) bound.locals.delete(name);
  }
  return execute(bound).map((outcome) => {
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
  return states.filter(({ dir, status, functions, environment, locals, positionals, inputs, match, stop }) => {
    const key = JSON.stringify([dir, status, id(functions), id(environment), id(locals), id(positionals), id(inputs), match, stop]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function patternCharacters(word, lookup, output) {
  const characters = [];
  let offset = 0;
  let range = 0;
  function append(end) {
    while (offset < end) {
      while (word.quotedRanges[range]?.[1] <= offset) range++;
      const char = String.fromCodePoint(word.text.codePointAt(offset));
      characters.push({ char, literal: word.quotedRanges[range]?.[0] <= offset });
      offset += char.length;
    }
  }
  for (const expansion of word.expansions) {
    append(expansion.at);
    const expanded = expansionValue(expansion, lookup, output);
    const text = Array.isArray(expanded) ? expanded.join(' ') : expanded;
    if (text.includes(unknownExpansion)) return;
    for (const char of text) characters.push({ char, literal: !expansion.split });
    offset = expansion.at + expansion.length;
  }
  append(word.text.length);
  return characters;
}

function patternOperator(characters, index, operator) {
  return characters[index]?.char === operator && !characters[index].literal;
}

function readBracketPattern(characters, opening) {
  let start = opening + 1;
  const negate = patternOperator(characters, start, '!') || patternOperator(characters, start, '^');
  if (negate) start++;
  let end = start;
  if (patternOperator(characters, end, ']')) end++;
  while (end < characters.length && !patternOperator(characters, end, ']')) {
    // POSIX character classes, collating symbols, and equivalence classes depend on locale.
    if (patternOperator(characters, end, '[') && /[:.=]/.test(characters[end + 1]?.char ?? '')) return undefined;
    end++;
  }
  if (end === characters.length) return null;
  const ranges = [];
  for (let i = start; i < end; i++) {
    const first = characters[i].char;
    if (i + 2 < end && patternOperator(characters, i + 1, '-')) {
      const last = characters[i + 2].char;
      if (first > last || /[^\x00-\x7f]/.test(first + last)) return undefined;
      ranges.push([first, last]);
      i += 2;
    } else {
      ranges.push([first, first]);
    }
  }
  return { end, matches: (char) => negate !== ranges.some(([first, last]) => first <= char && char <= last) };
}

const patternStar = Symbol('case wildcard');

function staticPattern(pattern, value, lookup, output) {
  const characters = patternCharacters(pattern, lookup, output);
  if (!characters) return undefined;
  const tokens = [];
  for (let i = 0; i < characters.length; i++) {
    const { char, literal } = characters[i];
    if (!literal && /[?*+@!]/.test(char) && patternOperator(characters, i + 1, '(')) return undefined;
    if (!literal && char === '*') tokens.push(patternStar);
    else if (!literal && char === '?') tokens.push(() => true);
    else if (!literal && char === '[') {
      const bracket = readBracketPattern(characters, i);
      if (bracket === undefined) return undefined;
      if (bracket) {
        tokens.push(bracket.matches);
        i = bracket.end;
      } else {
        tokens.push((input) => char === input);
      }
    } else {
      tokens.push((input) => char === input);
    }
  }

  const subject = [...value];
  let input = 0;
  let at = 0;
  let star = -1;
  let consumed = 0;
  while (input < subject.length) {
    const token = tokens[at];
    if (token === patternStar) {
      star = at++;
      consumed = input;
    } else if (token?.(subject[input])) {
      at++;
      input++;
    } else if (star >= 0) {
      at = star + 1;
      input = ++consumed;
    } else {
      return false;
    }
  }
  while (tokens[at] === patternStar) at++;
  return at === tokens.length;
}

// Inspect possible execution paths. An unknown return status keeps both branches.
// Each path keeps its own shell state and its first observed policy match.
function analyze(source, {
  cwd = process.cwd(),
  environment = Object.create(null),
  resolvePath = (value, base) => path.resolve(base, value),
  isDirectory,
  canRedirect,
  select,
  includeInactive = false,
} = {}) {
  const settings = { resolvePath, isDirectory };
  const commands = [];
  const activeFunctions = new Set();
  const { text, nodes, incomplete } = parseShell(source);
  let remainingSteps = Math.min(250_000, Math.max(4096, text.length * 24));
  const status = { incomplete };
  const freshShell = (dir, positionals, env, inputs = new Map(), match) => ({
    dir, positionals, environment: env, inputs, functions: new Map(), locals: new Map(), status: undefined, match,
  });
  const scan = (script, state, depth) => {
    if (depth >= maxDepth) {
      markIncomplete(status, 'nested shell analysis limit exceeded');
      return [state];
    }
    const { segments } = tokenize(script.text, status, 0, false, 0, script.origin);
    return walkList(groupCommands(segments, status), [state], depth + 1);
  };

  function narrow(states) {
    const unique = uniqueStates(states);
    if (unique.length > 256) {
      markIncomplete(status, 'shell analysis branch limit exceeded');
      return unique.slice(0, 256);
    }
    return unique;
  }

  function scanExpansions(word, state, depth) {
    if (depth >= maxDepth) {
      markIncomplete(status, 'shell expansion analysis limit exceeded');
      return [state];
    }
    let results = [state];
    for (const { commands: nested } of word.expansions) {
      for (const segments of nested ?? []) {
        const nodes = groupCommands(segments, status);
        results = narrow(results.flatMap((context) => walkList(nodes, [context], depth + 1)
          .map(({ match }) => ({ ...context, match }))));
      }
    }
    return results;
  }

  function redirectStatus(op, value, dir) {
    if (op === '<<<') return true;
    if (op === '<&' || op === '>&') return /^(?:\d+-?|-)$/.test(value) ? true : undefined;
    if (value === '/dev/null') return true;
    if (!canRedirect || value.includes(unknownExpansion)) return undefined;
    return canRedirect(resolvePath(value, dir), op);
  }

  function applyRedirections(redirections, state, depth) {
    let states = [{ state, setup: true }];
    for (const redirect of redirections ?? []) {
      states = states.flatMap(({ state: context, setup }) => {
        if (setup === false) return [{ state: context, setup }];
        const { op, fd, body, word, origin } = redirect;
        const lookup = (name) => shellValue(context, name);
        const output = (nodes) => literalOutput(nodes, lookup, context.functions)?.replace(/\n+$/, '');
        const document = op === '<<' || op === '<<-';
        const target = document ? (!word.quoted && body ? hereDocumentWord(body, origin, status) : undefined) : word;
        const expanded = target ? scanExpansions(target, context, depth) : [context];
        return expanded.map((next) => {
          const inputs = new Map(next.inputs);
          const value = target ? expandWord(target, lookup, output) : body;
          let input;
          let success = true;
          if (document || op === '<<<') input = { text: value ?? '', origin: document ? origin : cover(word) };
          else if ((op === '<&' || op === '>&') && /^\d+-?$/.test(value)) {
            const fd = parseInt(value, 10);
            input = inputs.get(fd);
            if (value.endsWith('-')) inputs.delete(fd);
          } else {
            success = redirectStatus(op, value, next.dir);
          }
          inputs.set(fd, input);
          if (op === '&>' || op === '&>>') inputs.delete(2);
          return { state: { ...next, inputs }, setup: success === true ? setup : success };
        });
      });
    }
    return states;
  }

  function selectStatus(states, wanted) {
    return states.filter((state) => !state.stop && (includeInactive || state.status === wanted || state.status === undefined))
      .map((state) => ({ ...state, status: wanted }));
  }

  function walkList(nodes, states, depth) {
    for (const [list, separator] of splitCommands(nodes, [';', '\n', '&'])) {
      const stopped = states.filter((state) => state.stop);
      const activeStates = states.filter((state) => !state.stop);
      if (!activeStates.length || remainingSteps <= 0) break;
      const runList = (initial) => {
        let outcomes = initial;
        let condition;
        for (const [pipeline, operator] of splitCommands(list, ['&&', '||'])) {
          const wanted = condition === '&&';
          const next = condition ? [...outcomes.filter((state) => state.stop), ...selectStatus(outcomes, !wanted)] : [];
          const active = condition ? selectStatus(outcomes, wanted) : outcomes;
          for (const state of active) next.push(...walkPipeline(pipeline, state, depth));
          outcomes = narrow(next);
          condition = operator;
        }
        return outcomes;
      };
      const outcomes = separator === '&' ? activeStates.flatMap((state) => runList([state])
        .map(({ match }) => ({ ...state, match, status: true }))) : runList(activeStates);
      states = narrow([...stopped, ...outcomes]);
    }
    return states;
  }

  function walkPipeline(nodes, state, depth) {
    let start = 0;
    while (nodes[start] === '!') start++;
    const stages = [...splitCommands(nodes.slice(start), ['|', '|&'])];
    let outcomes = [state];
    let input;
    for (const [index, [stage]] of stages.entries()) {
      const inputs = index === 0 ? state.inputs : new Map(state.inputs).set(0, input);
      const base = { ...state, inputs };
      if (index > 0) outcomes = outcomes.map(({ match }) => ({ ...base, match }));
      for (const node of stage) {
        outcomes = narrow(outcomes.flatMap((current) => current.stop ? [current] : walkCommand(node, current, depth)));
      }
      const lookup = (name) => shellValue(base, name);
      const output = literalOutput(stage, lookup, state.functions);
      const words = stage[0]?.words;
      input = output !== undefined && words?.length ? {
        text: output,
        origin: cover({ start: words[0].start, end: words.at(-1).end }),
      } : undefined;
    }
    return outcomes.map((outcome) => {
      const { status, match } = outcome;
      return { ...(stages.length > 1 ? state : outcome), match, status: start % 2 && status !== undefined ? !status : status };
    });
  }

  function walkIf(node, state, depth) {
    let remaining = [state];
    const outcomes = [];
    for (const { condition, body } of node.branches) {
      const statuses = walkList(condition, remaining, depth);
      outcomes.push(...statuses.filter(({ stop }) => stop));
      outcomes.push(...walkList(body, selectStatus(statuses, true), depth));
      remaining = selectStatus(statuses, false);
    }
    return outcomes.concat(node.otherwise ? walkList(node.otherwise, remaining, depth)
      : remaining.map((result) => ({ ...result, status: true })));
  }

  function walkCase(node, state, depth) {
    if (!node.subject) return [state];
    const lookup = (name) => shellValue(state, name);
    const output = (nodes) => literalOutput(nodes, lookup, state.functions)?.replace(/\n+$/, '');
    const subject = expandWord(node.subject, lookup, output);
    const outcomes = [];
    let pending = [{ ...state, status: true }];
    let fallthrough = [];
    for (const { pattern, body, end } of node.arms) {
      const active = fallthrough;
      fallthrough = [];
      const next = [];
      for (const candidate of pending) {
        const valueOf = (name) => shellValue(candidate, name);
        const unknownSubject = subject.includes(unknownExpansion);
        const matches = unknownSubject ? [] : pattern.map((word) => staticPattern(word, subject, valueOf, output));
        const matched = matches.includes(true);
        if (includeInactive || matched || unknownSubject || matches.includes(undefined)) active.push(candidate);
        if (includeInactive || !matched) next.push(candidate);
      }
      for (const outcome of walkList(body, active, depth)) {
        if (!outcome.stop && end === ';&') fallthrough.push(outcome);
        else if (!outcome.stop && end === ';;&') next.push(outcome);
        else outcomes.push(outcome);
      }
      pending = narrow(next);
    }
    return narrow([...outcomes, ...pending, ...fallthrough]);
  }

  function walkLoop(node, state, depth) {
    if (node.loop === 'for' || node.loop === 'select') {
      // The iteration values may depend on expansions or the filesystem.
      return [state, ...walkList(node.body, [state], depth)];
    }
    const statuses = walkList(node.condition, [state], depth);
    const enter = node.loop === 'while';
    return [
      ...statuses.filter(({ stop }) => stop),
      ...selectStatus(statuses, !enter),
      ...walkList(node.body, selectStatus(statuses, enter), depth),
    ];
  }

  function walkCommand(node, state, depth) {
    if (typeof node === 'string') return [state];
    if (--remainingSteps <= 0) {
      markIncomplete(status, 'shell analysis step limit exceeded');
      return [state];
    }
    if (node.name) {
      const functions = new Map(state.functions).set(node.name, node);
      if (includeInactive) walkList(node.body, [{ ...state, functions }], depth);
      return [{ ...state, functions, status: true }];
    }

    let contexts = [state];
    for (const word of node.words ?? (node.subject ? [node.subject] : [])) {
      contexts = narrow(contexts.flatMap((context) => scanExpansions(word, context, depth)));
    }
    return contexts.flatMap((context) => applyRedirections(node.redirections, context, depth)
      .flatMap(({ state: redirected, setup }) => {
        const failed = { ...context, match: redirected.match, status: false };
        if (setup === false && !includeInactive) return [failed];
        let outcomes;
        if (node.branches) outcomes = walkIf(node, redirected, depth);
        else if (node.arms) outcomes = walkCase(node, redirected, depth);
        else if (node.loop) outcomes = walkLoop(node, redirected, depth);
        else if (node.body) outcomes = walkList(node.body, [redirected], depth);
        else outcomes = runSimple(node.words, redirected, depth, context.inputs);
        if (node.subshell) outcomes = outcomes.map(({ status, match }) => ({ ...state, status, match }));
        else if (node.body || node.branches || node.arms) {
          if (node.redirections?.length) outcomes = outcomes.map((outcome) => ({ ...outcome, inputs: context.inputs }));
        }
        return setup === undefined && !includeInactive ? [...outcomes, failed] : outcomes;
      }));
  }

  function runSimple(words, state, depth, priorInputs) {
    const lookup = (name) => shellValue(state, name);
    const output = (nodes) => literalOutput(nodes, lookup, state.functions)?.replace(/\n+$/, '');
    const invocation = readInvocation(words, lookup, state.dir, state.environment, output, settings, state.functions, status);
    const complete = (status, result = state) => [{
      ...result, status, inputs: invocation?.keepInputs ? result.inputs : priorInputs,
    }];
    if (!invocation) return complete(undefined);
    const { args, cwd, environment, assigned, external, bypassFunctions, wrapper, setup } = invocation;
    if (setup === false && !includeInactive) return complete(false);
    if (!args.length) return complete(true, wrapper ? state : assignShell(state, assigned));
    const [program, ...operands] = args;
    const tool = executableName(program.value);
    if (!external && !bypassFunctions && state.functions.has(program.value)) {
      const definition = state.functions.get(program.value);
      if (activeFunctions.has(definition) || depth >= maxDepth) {
        markIncomplete(status, 'shell function analysis limit exceeded');
        return complete(undefined);
      }
      activeFunctions.add(definition);
      try {
        const positionals = [state.positionals[0], ...operands.map(({ value }) => value)];
        return withShellCall(state, invocation, positionals, (bound) => (
          walkCommand({ ...definition, name: undefined }, bound, depth + 1)
        )).map((result) => ({
          ...result,
          stop: result.stop === 'return' ? undefined : result.stop,
          inputs: words.length && priorInputs !== state.inputs ? priorInputs : result.inputs,
        }));
      } finally {
        activeFunctions.delete(definition);
      }
    }

    const script = /^(?:bash|sh|dash|ksh|zsh)$/.test(tool) ? shellScript(args, state.inputs, includeInactive) : undefined;
    const event = { tool, args: script?.file ? script.args : operands, cwd, environment, script: script?.file };
    commands.push(event);
    if (select && !state.match) state = { ...state, match: select(event) ?? undefined };
    if (!external && program.value === 'cd') {
      const target = operands[0]?.value === '--' ? operands[1]?.value : operands[0]?.value;
      const { dir, status } = changeDirectory(cwd, target, settings);
      return complete(status, { ...state, dir });
    }
    if (!external && /^(?:export|unset)$/.test(program.value)) {
      const bindings = new Map();
      const mode = program.value === 'export' && operands[0]?.value === '-n' ? 'unexport' : program.value;
      for (const { value } of operands) {
        const binding = /^([A-Za-z_]\w*)(?:=(.*))?$/s.exec(value);
        if (binding) bindings.set(binding[1], binding[2] ?? lookup(binding[1]));
      }
      return complete(true, assignShell(state, bindings, mode));
    }
    if (!external && program.value === 'eval' && operands.length) {
      const script = { text: operands.map(({ value }) => value).join(' '),
        origin: cover({ start: operands[0].start, end: operands.at(-1).end }) };
      return withShellCall(state, invocation, state.positionals, (bound) => scan(script, bound, depth));
    }
    if (!external && /^(?:exit|return)$/.test(program.value) && !includeInactive) {
      const status = operands[0] ? Number(operands[0].value) % 256 === 0 : state.status;
      return complete(status, { ...state, stop: program.value });
    }
    if (program.value === 'true' || program.value === ':') return complete(true);
    if (program.value === 'false') return complete(false);
    const stop = invocation.replaceShell && !includeInactive ? 'exit' : undefined;
    if (script?.script?.text && !script.script.text.includes(unknownExpansion)) {
      const inputs = script.fromStdin ? new Map(state.inputs).set(0, undefined) : state.inputs;
      return scan(script.script, freshShell(cwd, script.positionals, environment, inputs, state.match), depth)
        .map(({ status, match }) => ({ ...state, status, match, stop, inputs: priorInputs }));
    }
    return complete(undefined, { ...state, stop });
  }

  const initial = freshShell(cwd, ['bash'], { base: environment, values: new Map() });
  const states = walkList(nodes, [initial], 1);
  return { commands, states, incomplete: status.incomplete };
}

// Return each resolved command and its argument values and original source spans.
// The same command may occur on several possible execution paths.
export function shellCommands(source, options) {
  return analyze(source, options).commands;
}

export function firstShellMatch(source, select, options) {
  const { states, incomplete } = analyze(source, { ...options, select });
  const [first] = states;
  if (incomplete || !first?.match) return null;
  const expected = JSON.stringify(first.match);
  return states.every(({ match }) => JSON.stringify(match) === expected) ? first.match : null;
}

export function findGitCommits(source, options) {
  const resolvePath = options?.resolvePath ?? ((value, base) => path.resolve(base, value));
  const { commands, incomplete } = analyze(source, options);
  const targets = commands.filter(({ tool }) => tool === 'git')
    .map((command) => gitCommitTarget(command, resolvePath)).filter(Boolean);
  return { targets, incomplete };
}

export function* shellWords(source) {
  function* words(segments) {
    for (const node of segments) {
      if (typeof node === 'string') continue;
      for (const word of [...node.words, ...node.redirections.map(({ word }) => word)]) {
        yield word;
        for (const expansion of word.expansions) {
          for (const nested of expansion.commands ?? []) yield* words(nested);
        }
      }
    }
  }
  yield* words(parseShell(source).segments);
}
