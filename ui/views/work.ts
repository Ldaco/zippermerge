import type { BoardAgent, ClaimState, ZmEvent } from '../../src/types.ts';
import type { Child, View } from '../dom.ts';
import { age, agentChip, chip, clock, duration, h } from '../dom.ts';

function table(headers: string[], rows: Child[][], empty: string): HTMLElement {
  if (!rows.length) return h('div', { class: 'age' }, empty);
  return h('table', { class: 'list' },
    h('thead', null, h('tr', null, headers.map((text) => h('th', null, text)))),
    h('tbody', null, rows.map((cells) => h('tr', null, cells.map((cell) => h('td', null, cell))))),
  );
}

const STATE_CHIP: Record<BoardAgent['state'], string> = { active: 'ok', holding: 'open', quiet: '' };
const CLAIM_CHIP: Record<ClaimState, string> = { held: '', landed: 'ok', collision: 'bad', unknown: 'open' };
const FEED_SKIP = new Set(['run-start']);

function feedLine(event: ZmEvent): string {
  const parts: Record<string, string> = {
    joined: 'joined',
    claim: `claimed migration ${event.number}`,
    release: `released migration ${event.number}`,
    lock: `locked ${event.resource}`,
    unlock: `unlocked ${event.resource}`,
    wait: `waiting for ${event.resource}, held by ${event.holder}`,
    'run-end': `finished ${event.command} (exit ${event.code}), ${duration(event.durationMs)}, waited ${duration(event.waitedMs)}`,
    blocked: `commit blocked: ${event.reasons?.join(' ')}`,
    drift: `outside scope: ${event.files?.join(', ')}`,
    reserve: `reserved ${event.glob}`,
    unreserve: `released ${event.glob}`,
    'lock-expired': `took over ${event.resource} after it expired`,
  };
  return parts[event.type] ?? event.type;
}

export default {
  id: 'work',
  title: 'Work',
  order: 4,
  render(root, board) {
    const m = board.measures;
    root.replaceChildren(
      h('div', { class: 'work' },
        h('div', { class: 'card' },
          h('h3', null, 'Efficiency'),
          h('div', { class: 'stats' },
            h('div', { class: 'stat' }, h('b', null, duration(m.waitedMs)), h('span', null, 'waited on locks')),
            h('div', { class: 'stat' }, h('b', null, duration(m.ranMs)), h('span', null, `in ${m.runs} heavy runs`)),
            h('div', { class: 'stat' }, h('b', null, m.blocked), h('span', null, 'bad commits blocked')),
            h('div', { class: 'stat' }, h('b', null, board.conflicts.pairs.length), h('span', null, 'conflicts seen now')),
            h('div', { class: 'stat' }, h('b', null, m.asksOpen), h('span', null, 'asks open')),
            h('div', { class: 'stat' }, h('b', null, duration(m.medianAnswerMs)), h('span', null, 'median to answer')),
          ),
        ),
        h('div', { class: 'card' },
          h('h3', null, 'Agents'),
          table(['Agent', 'State', 'Role', 'Branch', 'Last seen'], board.agents.map((a) => [
            agentChip(board, a.name),
            [chip(a.state, STATE_CHIP[a.state]), a.holding ? ` ${a.holding}` : ''],
            [a.role, a.owns.length ? h('div', { class: 'mono age' }, a.owns.join(', ')) : null],
            [h('span', { class: 'mono' }, a.branch ?? 'detached'), a.dirty ? ' ' : '', a.dirty ? chip('uncommitted') : ''],
            age(a.last),
          ]), 'No agents have joined.'),
        ),
        h('div', { class: 'card' },
          h('h3', null, 'Conflicts'),
          table(['Between', 'Files', 'Kind'], board.conflicts.pairs.map((p) => [
            [agentChip(board, p.a), ' and ', p.kind === 'cross' ? agentChip(board, p.b) : p.b],
            h('span', { class: 'mono' }, p.files.join(', ')),
            p.kind === 'cross' ? 'agent against agent' : 'against base',
          ]), 'None found, including uncommitted edits to tracked files.'),
          board.conflicts.untested.length
            ? h('div', { class: 'age' }, `Not tested: ${board.conflicts.untested.map((u) => `${u.who} (${u.why})`).join(', ')}`)
            : null,
        ),
        h('div', { class: 'card' },
          h('h3', null, 'Migration claims'),
          table(['Number', 'Agent', 'File', 'State'], board.migrations.claims.map((c) => [
            c.number, agentChip(board, c.agent), h('span', { class: 'mono' }, c.file), chip(c.state, CLAIM_CHIP[c.state]),
          ]), 'No claims yet.'),
          board.migrations.collisions.map((c) => h('div', { class: 'item red' }, c.detail)),
        ),
        h('div', { class: 'card' },
          h('h3', null, 'Locks and reservations'),
          table(['What', 'Holder', 'Since', 'Why'], [
            ...board.locks.map((l) => [l.resource, agentChip(board, l.agent), age(l.ts), h('span', { class: 'mono' }, l.why)]),
            ...board.reservations.map((r) => [h('span', { class: 'mono' }, r.glob), agentChip(board, r.agent), age(r.ts), r.exclusive ? 'exclusive' : r.why]),
          ], 'Nothing held.'),
        ),
        h('div', { class: 'card' },
          h('h3', null, 'Machine feed'),
          h('div', { 'data-keep-scroll': 'feed', style: { 'max-height': '340px', overflow: 'auto' } },
            table(['Time', 'Agent', 'What'], board.events.filter((e) => !FEED_SKIP.has(e.type)).slice(-200).reverse().map((e) => [
              h('span', { class: 'age' }, clock(e.ts)), e.agent ? agentChip(board, e.agent) : '', feedLine(e),
            ]), 'Nothing yet.'),
          ),
        ),
      ),
    );
  },
} satisfies View;
