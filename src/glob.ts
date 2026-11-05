import { UserError } from './errors.ts';

/** Globs only, with limits, so a bad pattern can never hang a hook or the dashboard. */
export function globToRegex(glob: string): RegExp {
  if (glob.length > 200 || (glob.match(/\*/g) ?? []).length > 8) {
    throw new UserError(`Pattern too long or too many wildcards: ${glob}`);
  }
  let source = '';
  const text = glob.replace(/\\/g, '/').replace(/\/$/, '/**');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '*' && text[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (text[i + 1] === '/') i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegex(glob).test(path));
}
