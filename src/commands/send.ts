import type { Args } from '../types.ts';
import { context, requireAgent } from '../context.ts';
import { sendMessage } from '../messages.ts';

export const options = {
  to: { type: 'string' },
  kind: { type: 'string' },
};

export async function run({ values, positionals }: Args<{ to?: string; kind?: string }>) {
  const ctx = context();
  const from = requireAgent(ctx);
  const message = sendMessage(ctx, {
    from,
    to: values.to?.split(',').map((name) => name.trim()).filter(Boolean),
    kind: values.kind ?? 'note',
    body: positionals.join(' '),
  });
  console.log(message.id);
}
