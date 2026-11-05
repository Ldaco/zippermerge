import { buildBoard } from '../board.ts';
import { context } from '../context.ts';

export async function run() {
  const board = buildBoard(context());
  console.log(`${board.counts.red} red, ${board.counts.amber} amber. ${board.base} at ${board.baseSha?.slice(0, 8) ?? 'unknown'}.`);
  for (const agent of board.agents) console.log(`  ${agent.name}: ${agent.state}${agent.holding ? `, holding ${agent.holding}` : ''}`);
  for (const item of board.attention) console.log(`${item.sev.toUpperCase()} ${item.title}: ${item.detail}`);
}
