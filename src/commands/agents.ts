import type { Agent } from '../types.ts';
import { join } from 'node:path';
import { context } from '../context.ts';
import { listJson } from '../store.ts';

export async function run() {
  const ctx = context();
  for (const agent of listJson<Agent>(join(ctx.store, 'agents'))) {
    const scope = agent.owns.length ? `  owns ${agent.owns.join(', ')}` : '';
    console.log(`${agent.name}  ${agent.role}${scope}  ${agent.worktree}`);
  }
}
