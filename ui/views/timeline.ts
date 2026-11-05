import type { ZmEvent } from '../../src/types.ts';
import type { View } from '../dom.ts';
import { clock, colorFor, duration, h, s } from '../dom.ts';

const LANE = 86;
const LEFT = 118;
const TOP = 26;
let picked: string | null = null;

const EVENT_LABEL: Record<string, string> = {
  joined: 'joined',
  claim: 'claimed a migration',
  release: 'released a claim',
  blocked: 'commit blocked',
  drift: 'outside scope',
  wait: 'waiting for lock',
  reserve: 'reserved files',
  unreserve: 'released files',
  'lock-expired': 'took an expired lock',
};
const EVENT_COLOR: Record<string, string> = { blocked: '#b3312a', drift: '#96640a', wait: '#96640a', claim: '#3d8a5f' };

function spans(events: ZmEvent[], openName: string, closeName: string, key: 'resource'): (ZmEvent & { end: string | null })[] {
  const open = new Map<string, ZmEvent>();
  const out: (ZmEvent & { end: string | null })[] = [];
  for (const e of events) {
    const id = `${e.agent}:${e[key]}`;
    if (e.type === openName) open.set(id, e);
    if (e.type === closeName && open.has(id)) {
      out.push({ ...open.get(id)!, end: e.ts });
      open.delete(id);
    }
  }
  for (const e of open.values()) out.push({ ...e, end: null });
  return out;
}

export default {
  id: 'timeline',
  title: 'Timeline',
  order: 2,
  render(root, board) {
    const lanes = [...board.agents.map((a) => a.name), board.human];
    const laneY = (name: string) => TOP + lanes.indexOf(name) * LANE + LANE / 2;
    const times = [...board.messages.map((m) => m.ts), ...board.events.map((e) => e.ts)].map(Date.parse);
    if (!times.length) {
      root.replaceChildren(h('div', { class: 'empty' }, 'Nothing has happened yet.'));
      return;
    }
    const start = Math.min(...times);
    const end = Math.max(Date.now(), start + 60000);
    const width = Math.max(root.clientWidth - 32, 760);
    const height = TOP + lanes.length * LANE + 10;
    const x = (ts: string) => LEFT + ((Date.parse(ts) - start) / (end - start)) * (width - LEFT - 16);

    const inspector = h('div', { class: 'card inspector' }, h('span', { class: 'age' }, 'Click a mark to read it.'));
    const show = (node: Node) => inspector.replaceChildren(node);
    const pick = (id: string, node: () => Node) => ({
      'data-pick': id,
      onclick: () => {
        picked = id;
        show(node());
      },
    });

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Timeline of agent messages and work' });

    for (let i = 0; i <= 6; i += 1) {
      const t = start + ((end - start) * i) / 6;
      const px = LEFT + (i / 6) * (width - LEFT - 16);
      svg.append(s('line', { x1: px, x2: px, y1: 20, y2: height, stroke: '#ece9e1' }));
      svg.append(s('text', { x: px, y: 15, 'text-anchor': i === 6 ? 'end' : 'middle', 'font-size': 10, fill: '#5d6370' }, clock(new Date(t).toISOString())));
    }

    for (const name of lanes) {
      const y = laneY(name);
      svg.append(s('line', { x1: LEFT, x2: width - 16, y1: y, y2: y, stroke: '#e0dcd2' }));
      svg.append(s('text', { x: 12, y: y + 4, 'font-size': 13, 'font-weight': 700, fill: colorFor(board, name) }, name));
    }

    // Lock holds and heavy runs as bars, so a wait is visible at a glance.
    for (const span of spans(board.events, 'lock', 'unlock', 'resource')) {
      if (!span.agent || !lanes.includes(span.agent)) continue;
      const x1 = x(span.ts);
      const x2 = span.end ? x(span.end) : x(new Date(end).toISOString());
      svg.append(s('rect', {
        x: x1, y: laneY(span.agent) + 12, width: Math.max(x2 - x1, 3), height: 9, rx: 2, fill: colorFor(board, span.agent), opacity: .35,
        ...pick(`lock:${span.id}`, () => h('div', null, h('strong', null, `${span.agent} held ${span.resource}`), h('div', { class: 'age' }, `${clock(span.ts)} to ${span.end ? clock(span.end) : 'now'}`), span.why ? h('div', { class: 'mono' }, span.why) : null)),
      }, s('title', null, `${span.agent} held ${span.resource}`)));
    }

    for (const e of board.events) {
      const label = EVENT_LABEL[e.type];
      if (!label || !e.agent || !lanes.includes(e.agent)) continue;
      const px = x(e.ts);
      const y = laneY(e.agent);
      const detail = () => h('div', null,
        h('strong', null, `${e.agent}: ${label}`),
        h('div', { class: 'age' }, clock(e.ts)),
        e.number ? h('div', null, `Migration ${e.number} ${e.file ?? ''}`) : null,
        e.reasons ? e.reasons.map((r) => h('div', null, r)) : null,
        e.files ? h('div', null, e.files.join(', ')) : null,
        e.glob ? h('div', { class: 'mono' }, e.glob) : null,
        e.holder ? h('div', null, `Held by ${e.holder}`) : null,
      );
      svg.append(s('rect', { x: px - 2, y: y + 12, width: 4, height: 9, fill: EVENT_COLOR[e.type] ?? '#5d6370', ...pick(`e:${e.id}`, detail) }, s('title', null, `${e.agent}: ${label}`)));
    }

    // Every addressed message draws an arc to each person it went to.
    for (const m of board.messages) {
      const from = x(m.ts);
      const fromY = laneY(m.from);
      if (!lanes.includes(m.from)) continue;
      const open = m.kind === 'ask' && !m.answeredBy;
      const color = m.kind === 'reply' ? '#2c7a4f' : open ? '#96640a' : '#6a4bb0';
      for (const to of m.recipients) {
        if (!lanes.includes(to)) continue;
        const toY = laneY(to);
        const bend = (fromY + toY) / 2;
        svg.append(s('path', {
          d: `M ${from} ${fromY} C ${from + 34} ${bend}, ${from + 34} ${bend}, ${from + 16} ${toY}`,
          fill: 'none', stroke: color, 'stroke-width': 1.5, opacity: .8, 'stroke-dasharray': open ? '4 3' : null,
        }));
        svg.append(s('circle', { cx: from + 16, cy: toY, r: 2.5, fill: color }));
      }
      const detail = () => h('div', null,
        h('strong', null, `${m.from} to ${m.to.join(', ')}`), ' ', h('span', { class: 'age' }, `${m.kind}, ${clock(m.ts)}`),
        h('div', { class: 'msgbody' }, m.body),
      );
      const props = { fill: color, stroke: '#fffdf9', 'stroke-width': 1.5, ...pick(`m:${m.id}`, detail) };
      svg.append(m.kind === 'ask'
        ? s('rect', { x: from - 5, y: fromY - 5, width: 10, height: 10, transform: `rotate(45 ${from} ${fromY})`, ...props }, s('title', null, m.body.slice(0, 160)))
        : s('circle', { cx: from, cy: fromY, r: 5, ...props }, s('title', null, m.body.slice(0, 160))));
    }

    const stats = board.measures;
    root.replaceChildren(
      h('div', { class: 'timeline' },
        h('div', { class: 'legend' },
          h('span', null, h('i', { style: { background: '#6a4bb0' } }), 'note or answered ask'),
          h('span', null, h('i', { style: { background: '#2c7a4f' } }), 'reply'),
          h('span', null, h('i', { style: { background: '#96640a' } }), 'open ask'),
          h('span', null, h('i', { style: { background: '#5d6370', height: '9px', width: '12px', opacity: .45 } }), 'lock held'),
          h('span', null, `Waited on locks: ${duration(stats.waitedMs)}`),
          h('span', null, `Median time to answer: ${duration(stats.medianAnswerMs)}`),
        ),
        svg,
        inspector,
      ),
    );
    // Keep what you were reading when new data arrives.
    if (picked) svg.querySelector(`[data-pick="${CSS.escape(picked)}"]`)?.dispatchEvent(new Event('click'));
  },
} satisfies View;
