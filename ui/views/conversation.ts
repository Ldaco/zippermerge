import type { Board, BoardMessage, Receipt } from '../../src/types.ts';
import type { View } from '../dom.ts';
import { age, agentChip, chip, clock, h } from '../dom.ts';

let filter: string | null = null;

function receiptChip(name: string, receipt: Receipt, human: string): HTMLElement | null {
  if (name === human) return null; // the human reads this here, so a receipt would mean nothing
  if (receipt.acked) return chip(`${name}: acknowledged`, 'ok');
  if (receipt.delivered) return chip(`${name}: delivered`);
  return chip(`${name}: not read yet`, 'open');
}

function message(board: Board, m: BoardMessage): HTMLElement {
  const receipts = m.recipients.map((name) => receiptChip(name, m.receipts[name]!, board.human)).filter(Boolean);
  let state: HTMLElement | null = null;
  if (m.kind === 'ask') state = m.answeredBy ? chip('answered', 'ok') : chip('open', 'open');
  return h('div', { class: m.re ? 'msg child' : 'msg' },
    h('div', { class: 'meta' },
      agentChip(board, m.from),
      h('span', { class: 'age' }, 'to'),
      m.to.map((name, i) => [i ? ', ' : '', name === 'all' ? 'all' : agentChip(board, name)]),
      chip(m.kind),
      state,
      m.via === 'dashboard' ? chip('from the dashboard') : null,
      h('span', { class: 'age', title: m.ts }, clock(m.ts)),
    ),
    h('div', { class: 'body' }, m.body),
    receipts.length ? h('div', { class: 'receipts' }, receipts) : null,
  );
}

function threads(messages: BoardMessage[]): BoardMessage[][] {
  const groups = new Map<string, BoardMessage[]>();
  for (const m of messages) {
    if (!groups.has(m.thread)) groups.set(m.thread, []);
    groups.get(m.thread)!.push(m);
  }
  return [...groups.values()].sort((a, b) => (a.at(-1)!.ts < b.at(-1)!.ts ? 1 : -1));
}

function matrix(board: Board): HTMLElement | null {
  const names = board.agents.map((a) => a.name);
  if (!names.length) return null;
  const count = (from: string, to: string) => {
    const sent = board.messages.filter((m) => m.from === from && m.recipients.includes(to));
    return { sent: sent.length, heard: sent.filter((m) => m.receipts[to]?.delivered).length };
  };
  return h('table', { class: 'matrix' },
    h('thead', null, h('tr', null, h('th', { title: 'from, down the side. to, along the top' }, ''), names.map((n) => h('th', null, agentChip(board, n))))),
    h('tbody', null, names.map((from) => h('tr', null,
      h('th', null, agentChip(board, from)),
      names.map((to) => {
        if (from === to) return h('td', { class: 'none' }, '');
        const { sent, heard } = count(from, to);
        return h('td', { class: sent ? '' : 'none', title: `${to} has received ${heard} of ${sent} from ${from}` }, sent ? `${heard}/${sent}` : '0');
      }),
    ))),
  );
}

export default {
  id: 'conversation',
  title: 'Conversation',
  order: 1,
  render(root, board) {
    const names = [...board.agents.map((a) => a.name), board.human];
    const shown = filter
      ? board.messages.filter((m) => m.from === filter || m.recipients.includes(filter!))
      : board.messages;
    const open = board.messages.filter((m) => m.kind === 'ask' && !m.answeredBy);
    const rerender = (value: string | null) => () => {
      filter = value;
      this.render(root, board);
    };
    root.replaceChildren(
      h('div', { class: 'convo' },
        h('div', null,
          h('div', { class: 'filters' },
            h('button', { type: 'button', class: filter ? '' : 'on', onclick: rerender(null) }, 'Everyone'),
            names.map((name) => h('button', { type: 'button', class: filter === name ? 'on' : '', onclick: rerender(name) }, name)),
          ),
          shown.length
            ? threads(shown).map((group) => h('div', { class: 'card thread' }, group.map((m) => message(board, m))))
            : h('div', { class: 'empty' }, 'No messages yet. They appear here as soon as an agent sends one.'),
        ),
        h('div', null,
          h('div', { class: 'card' },
            h('h3', null, 'Waiting on someone'),
            open.length
              ? open.map((m) => h('div', { class: 'wait' },
                  agentChip(board, m.from), ' waiting on ', m.to.map((n, i) => [i ? ', ' : '', n === 'all' ? 'all' : agentChip(board, n)]), ' ', age(m.ts, ''),
                  h('div', { class: 'age' }, m.body.slice(0, 120)),
                ))
              : h('div', { class: 'age' }, 'Every ask has a reply.'),
          ),
          h('div', { class: 'card' },
            h('h3', null, 'Who has heard whom'),
            matrix(board) ?? h('div', { class: 'age' }, 'No agents have joined.'),
          ),
        ),
      ),
    );
  },
} satisfies View;
