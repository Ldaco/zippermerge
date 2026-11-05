import type { Args } from '../types.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, identityFile, recordEvent, validName } from '../context.ts';
import { UserError } from '../errors.ts';
import { git } from '../git.ts';
import { writeAtomic } from '../store.ts';

export const options = {
  role: { type: 'string' },
  owns: { type: 'string' },
};

export async function run({ values, positionals }: Args<{ role?: string; owns?: string }>) {
  const [name] = positionals;
  const ctx = context();
  if (!validName(name)) throw new UserError('Usage: zippermerge join <name>, lowercase letters, digits and hyphens.');
  if (name === ctx.config.human) throw new UserError(`${name} is the human here. Pick another agent name.`);
  writeFileSync(identityFile(ctx.cwd), `${name}\n`);
  writeAtomic(join(ctx.store, 'agents', `${name}.json`), {
    name,
    role: values.role ?? '',
    owns: values.owns ? values.owns.split(',').map((glob) => glob.trim()).filter(Boolean) : [],
    worktree: git(['rev-parse', '--show-toplevel'], { cwd: ctx.cwd }),
    joinedAt: new Date().toISOString(),
  });
  recordEvent({ ...ctx, me: name }, 'joined', { role: values.role ?? '' });
  console.log(`Joined as ${name}.`);
}
