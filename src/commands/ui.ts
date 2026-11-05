import type { Args } from '../types.ts';
import { context } from '../context.ts';
import { startServer } from '../server.ts';

export const options = {
  port: { type: 'string' },
};

export async function run({ values }: Args<{ port?: string }>) {
  const ctx = context();
  const { url } = await startServer(ctx, { port: values.port !== undefined ? Number(values.port) : undefined });
  console.log(`Dashboard: ${url}`);
  console.log('Agents keep working if you close this. The link holds the key for sending notes.');
}
