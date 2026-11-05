import type { Agent, AttentionItem, Board, BoardAgent, BoardError, BoardMessage, BoardMigrations, Claim, ClaimState, ConflictPair, Ctx, Untested, ZmEvent } from './types.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sweep } from './conflicts.ts';
import type { EffectiveHead } from './conflicts.ts';
import { baseRef } from './context.ts';
import { git, runGit } from './git.ts';
import { loadLocks } from './locks.ts';
import { addressedTo, loadMessages, receipts } from './messages.ts';
import { loadClaims, migrationsAt } from './migrations.ts';
import { loadReservations } from './reservations.ts';
import { listJson } from './store.ts';

const MINUTE = 60 * 1000;
const ACTIVE_WINDOW = 5 * MINUTE;
const ASK_OVERDUE = 15 * MINUTE;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function buildMessages(ctx: Ctx, agents: Agent[]): BoardMessage[] {
  const names = agents.map((a) => a.name);
  const messages = loadMessages(ctx);
  const replies = messages.filter((m) => m.kind === 'reply');
  return messages.map((message) => {
    const recipients = [...names, ctx.config.human].filter((name) => addressedTo(message, name));
    const full: BoardMessage = { ...message, recipients, receipts: receipts(ctx, message, recipients) };
    if (message.kind === 'ask') {
      // Only a reply pointing at this ask closes it. An unrelated later post does not.
      const reply = replies.find((r) => r.re === message.id);
      full.answeredBy = reply?.id ?? null;
      full.answeredAt = reply?.ts ?? null;
    }
    return full;
  });
}

function migrationFacts(ctx: Ctx, agents: Agent[], heads: Map<string, EffectiveHead>, claims: Claim[], baseSha: string): BoardMigrations {
  const result: BoardMigrations = { collisions: [], claims: [] };
  if (!ctx.config.migrations) return result;
  const onBase = migrationsAt(ctx, baseSha);
  const byNumber = new Map(onBase.map((m) => [m.number, m.file]));
  const baseFiles = new Set(onBase.map((m) => m.file));

  result.claims = claims.map((claim) => {
    let state: ClaimState = 'held';
    if (baseFiles.has(claim.file)) state = 'landed';
    else if (byNumber.has(claim.number)) state = 'collision';
    return { ...claim, state };
  });

  // Read what is really on each branch. This also catches a commit made with --no-verify.
  const held = new Map<number, { agent: string; file: string }>();
  for (const agent of agents) {
    const head = heads.get(agent.name);
    if (!head) continue;
    for (const migration of migrationsAt(ctx, head.sha)) {
      if (baseFiles.has(migration.file)) continue;
      if (byNumber.has(migration.number)) {
        result.collisions.push({
          number: migration.number,
          who: [agent.name],
          detail: `${agent.name}'s ${migration.file} and ${ctx.config.base}'s ${byNumber.get(migration.number)} both use ${migration.number}`,
        });
      }
      const other = held.get(migration.number);
      if (other && other.file !== migration.file) {
        result.collisions.push({
          number: migration.number,
          who: [other.agent, agent.name],
          detail: `${other.agent}'s ${other.file} and ${agent.name}'s ${migration.file} both use ${migration.number}`,
        });
      }
      if (!other) held.set(migration.number, { agent: agent.name, file: migration.file });
    }
  }
  return result;
}

function buildAttention(board: Board, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (sev: AttentionItem['sev'], id: string, title: string, detail: string, who: string[] = []) => items.push({ sev, id, title, detail, who });

  for (const error of board.meta.errors) add('red', `error:${error.source}`, `Cannot read ${error.source}`, `${error.message}. Shown as unknown, not as clear.`);
  for (const c of board.migrations.collisions) add('red', `collision:${c.number}:${c.who.join('+')}`, `Migration ${c.number} collides`, c.detail, c.who);
  for (const p of board.conflicts.pairs) {
    const title = p.kind === 'cross' ? `${p.a} and ${p.b} will conflict` : `${p.a} conflicts with ${p.b}`;
    const remedy = p.kind === 'cross' ? 'Land one, then the other merges it in.' : `Merge ${p.b} into the branch.`;
    add('amber', `conflict:${p.kind}:${p.a}:${p.b}`, title, `${p.files.join(', ')}. ${remedy}`, p.kind === 'cross' ? [p.a, p.b] : [p.a]);
  }
  for (const u of board.conflicts.untested) add('amber', `untested:${u.who}`, `Not tested: ${u.who}`, u.why);
  for (const m of board.messages) {
    if (m.kind === 'ask' && !m.answeredBy && now - Date.parse(m.ts) > ASK_OVERDUE) {
      add('amber', `ask:${m.id}`, `${m.from} is waiting on ${m.to.join(', ')}`, m.body, m.to);
    }
  }
  for (const lock of board.locks) {
    if (Date.parse(lock.expiresAt) < now) add('amber', `lock:${lock.resource}`, `Lock ${lock.resource} expired`, `Held by ${lock.agent}. The next taker gets it.`, [lock.agent]);
  }
  for (const e of board.events.filter((event) => event.type === 'drift')) {
    if (now - Date.parse(e.ts) < 60 * MINUTE) add('amber', `drift:${e.id}`, `${e.agent} went outside its scope`, e.files!.join(', '), [e.agent!]);
  }
  const rank = { red: 0, amber: 1 };
  return items.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

/** The one place attention is counted. Every view shows these numbers. */
export function buildBoard(ctx: Ctx): Board {
  const now = Date.now();
  const errors: BoardError[] = [];
  const agentsRaw = listJson<Agent>(join(ctx.store, 'agents'));
  const events = listJson<ZmEvent>(join(ctx.store, 'events'));
  const lastByAgent = new Map<string, string>();
  for (const event of events) if (event.agent) lastByAgent.set(event.agent, event.ts);

  const messages = buildMessages(ctx, agentsRaw);
  for (const m of messages) {
    const seen = lastByAgent.get(m.from);
    if (!seen || seen < m.ts) lastByAgent.set(m.from, m.ts);
  }

  const locks = loadLocks(ctx);
  let baseSha: string | null = null;
  let conflicts: { pairs: ConflictPair[]; untested: Untested[] } = { pairs: [], untested: [] };
  let heads = new Map<string, EffectiveHead>();
  try {
    baseSha = git(['rev-parse', baseRef(ctx)], { cwd: ctx.cwd });
    const swept = sweep(ctx, agentsRaw, baseSha);
    conflicts = { pairs: swept.pairs, untested: swept.untested };
    heads = swept.heads;
  } catch (error) {
    errors.push({ source: 'git', message: (error as Error).message });
  }

  let migrations: BoardMigrations = { collisions: [], claims: loadClaims(ctx).map((c) => ({ ...c, state: 'unknown' as const })) };
  if (baseSha) {
    try {
      migrations = migrationFacts(ctx, agentsRaw, heads, loadClaims(ctx), baseSha);
    } catch (error) {
      errors.push({ source: 'migrations', message: (error as Error).message });
    }
  }

  const agents = agentsRaw.map((agent): BoardAgent => {
    const last = lastByAgent.get(agent.name) ?? agent.joinedAt;
    const head = heads.get(agent.name);
    const branch = runGit(['branch', '--show-current'], { cwd: agent.worktree }).out.trim() || null;
    const running = locks.find((lock) => lock.agent === agent.name);
    let state: BoardAgent['state'] = now - Date.parse(last) < ACTIVE_WINDOW ? 'active' : 'quiet';
    if (running) state = 'holding';
    return { ...agent, last, state, holding: running?.resource ?? null, branch, head: head?.head ?? null, dirty: head?.dirty ?? false };
  });

  const answerTimes = messages.filter((m) => m.answeredAt).map((m) => Date.parse(m.answeredAt!) - Date.parse(m.ts));
  const runs = events.filter((e) => e.type === 'run-end');
  const measures = {
    waitedMs: runs.reduce((sum, r) => sum + (r.waitedMs ?? 0), 0),
    ranMs: runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
    runs: runs.length,
    blocked: events.filter((e) => e.type === 'blocked').length,
    asksOpen: messages.filter((m) => m.kind === 'ask' && !m.answeredBy).length,
    asksAnswered: answerTimes.length,
    medianAnswerMs: median(answerTimes),
  };

  const board = {
    human: ctx.config.human,
    base: ctx.config.base,
    baseSha,
    agents,
    messages,
    events,
    locks,
    reservations: loadReservations(ctx),
    conflicts,
    migrations,
    measures,
    meta: { errors },
  } as Board;
  board.attention = buildAttention(board, now);
  board.counts = {
    red: board.attention.filter((i) => i.sev === 'red').length,
    amber: board.attention.filter((i) => i.sev === 'amber').length,
  };
  board.rev = createHash('sha1').update(JSON.stringify(board)).digest('hex').slice(0, 12);
  board.generatedAt = new Date(now).toISOString();
  return board;
}
