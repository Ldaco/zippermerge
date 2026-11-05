import type { Board } from '../../src/types.ts';
import type { View } from '../dom.ts';
import { agentChip, colorFor, h, s } from '../dom.ts';

const W = 900;
const H = 620;
type EdgeType = 'talk' | 'ask' | 'holds' | 'on' | 'conflict';

interface NodeData {
  state?: string;
  role?: string;
  branch?: string | null;
  file?: string;
  why?: string;
}

interface GraphNode {
  id: string;
  type: string;
  label: string;
  name?: string;
  data?: NodeData;
  bad?: boolean;
}

interface GraphEdge {
  a: string;
  b: string;
  type: EdgeType;
  count?: number;
  title: string;
}

interface Position {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const positions = new Map<string, Position>(); // survives polls so the map doesn't jump around
let selected: string | null = null;
let talkOnly = false;

function build(board: Board): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const node = (id: string, type: string, label: string, extra: Partial<GraphNode> = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label, ...extra });
    return id;
  };
  for (const a of board.agents) node(`a:${a.name}`, 'agent', a.name, { name: a.name, data: a });
  node(`a:${board.human}`, 'human', board.human, { name: board.human });

  // Talk: one edge per direction, weighted by how many messages.
  const talk = new Map<string, { from: string; to: string; count: number; open: number }>();
  for (const m of board.messages) {
    for (const to of m.recipients) {
      const key = `${m.from}>${to}`;
      if (!talk.has(key)) talk.set(key, { from: m.from, to, count: 0, open: 0 });
      const t = talk.get(key)!;
      t.count += 1;
      if (m.kind === 'ask' && !m.answeredBy) t.open += 1;
    }
  }
  for (const t of talk.values()) {
    const a = `a:${t.from}`;
    const b = `a:${t.to}`;
    if (nodes.has(a) && nodes.has(b)) edges.push({ a, b, type: t.open ? 'ask' : 'talk', count: t.count, title: `${t.from} to ${t.to}: ${t.count} messages${t.open ? `, ${t.open} open` : ''}` });
  }
  if (talkOnly) return { nodes: [...nodes.values()], edges };

  for (const claim of board.migrations.claims) {
    if (claim.state === 'landed') continue;
    const id = node(`c:${claim.number}`, 'claim', String(claim.number), { data: claim, bad: claim.state === 'collision' });
    edges.push({ a: `a:${claim.agent}`, b: id, type: 'holds', title: `${claim.agent} holds migration ${claim.number}` });
  }
  for (const lock of board.locks) {
    const id = node(`l:${lock.resource}`, 'lock', lock.resource, { data: lock });
    if (nodes.has(`a:${lock.agent}`)) edges.push({ a: `a:${lock.agent}`, b: id, type: 'holds', title: `${lock.agent} holds ${lock.resource}` });
  }
  for (const pair of board.conflicts.pairs) {
    for (const file of pair.files) {
      const short = file.split('/').pop()!;
      const id = node(`f:${file}`, 'file', short, { data: { file } });
      edges.push({ a: `a:${pair.a}`, b: id, type: 'conflict', title: `${pair.a}: conflict in ${file}` });
      if (pair.kind === 'cross') edges.push({ a: `a:${pair.b}`, b: id, type: 'conflict', title: `${pair.b}: conflict in ${file}` });
    }
  }
  for (const a of board.agents) {
    if (a.branch && !nodes.has(`b:${a.branch}`)) node(`b:${a.branch}`, 'branch', a.branch, { data: a });
    if (a.branch) edges.push({ a: `a:${a.name}`, b: `b:${a.branch}`, type: 'on', title: `${a.name} is on ${a.branch}` });
  }
  return { nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.a) && nodes.has(e.b)) };
}

/** A small force layout. It settles once per data change, and existing nodes keep their place. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): void {
  nodes.forEach((n, i) => {
    if (!positions.has(n.id)) {
      const angle = (i / nodes.length) * Math.PI * 2;
      const r = n.type === 'agent' || n.type === 'human' ? 190 : 270;
      positions.set(n.id, { x: W / 2 + Math.cos(angle) * r, y: H / 2 + Math.sin(angle) * r, vx: 0, vy: 0 });
    }
  });
  for (let step = 0; step < 220; step += 1) {
    const cool = 1 - step / 220;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = positions.get(nodes[i]!.id)!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = positions.get(nodes[j]!.id)!;
        const dx = a.x - b.x || 0.1;
        const dy = a.y - b.y || 0.1;
        const d2 = Math.max(dx * dx + dy * dy, 80);
        const f = 15000 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      a.vx += (W / 2 - a.x) * 0.004;
      a.vy += (H / 2 - a.y) * 0.006;
    }
    for (const e of edges) {
      const a = positions.get(e.a)!;
      const b = positions.get(e.b)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = e.type === 'talk' || e.type === 'ask' ? 210 : 95;
      const f = (d - rest) * 0.035;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.x = Math.min(W - 40, Math.max(40, p.x + p.vx * 0.5 * cool));
      p.y = Math.min(H - 36, Math.max(30, p.y + p.vy * 0.5 * cool));
      p.vx *= 0.6; p.vy *= 0.6;
    }
  }
}

const EDGE: Record<EdgeType, { stroke: string; width: number; dash?: string }> = {
  talk: { stroke: '#6a4bb0', width: 2 },
  ask: { stroke: '#96640a', width: 2, dash: '6 4' },
  holds: { stroke: '#8a8f99', width: 1.3 },
  on: { stroke: '#c9c4b7', width: 1 },
  conflict: { stroke: '#b3312a', width: 2.2 },
};

function shape(board: Board, n: GraphNode, p: Position, dim: unknown): SVGElement {
  const g = s('g', { 'data-id': n.id, class: dim ? 'dim' : null, transform: `translate(${p.x} ${p.y})` });
  if (n.type === 'agent' || n.type === 'human') {
    g.append(s('circle', { r: n.type === 'human' ? 17 : 24, fill: colorFor(board, n.name!) }));
    g.append(s('text', { y: n.type === 'human' ? 31 : 39, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#1d2230' }, n.label));
    if (n.data?.state === 'holding') g.append(s('circle', { r: 28, fill: 'none', stroke: '#96640a', 'stroke-dasharray': '3 3' }));
  } else if (n.type === 'claim') {
    g.append(s('rect', { x: -12, y: -12, width: 24, height: 24, rx: 3, transform: 'rotate(45)', fill: n.bad ? '#fbe9e6' : '#e4f3e9', stroke: n.bad ? '#b3312a' : '#3d8a5f' }));
    g.append(s('text', { y: 4, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#1d2230' }, n.label));
  } else if (n.type === 'lock') {
    g.append(s('rect', { x: -9, y: -9, width: 18, height: 18, rx: 3, fill: '#fbf1da', stroke: '#96640a' }));
    g.append(s('text', { y: 23, 'text-anchor': 'middle', 'font-size': 11, fill: '#5d6370' }, n.label));
  } else if (n.type === 'file') {
    g.append(s('rect', { x: -7, y: -9, width: 14, height: 18, rx: 2, fill: '#fbe9e6', stroke: '#b3312a' }));
    g.append(s('text', { y: 22, 'text-anchor': 'middle', 'font-size': 11, fill: '#b3312a' }, n.label));
  } else {
    g.append(s('rect', { x: -14, y: -6, width: 28, height: 12, rx: 6, fill: '#f6f4ef', stroke: '#c9c4b7' }));
    g.append(s('text', { y: 19, 'text-anchor': 'middle', 'font-size': 10, fill: '#5d6370' }, n.label));
  }
  g.append(s('title', null, n.label));
  return g;
}

function details(board: Board, nodes: GraphNode[], edges: GraphEdge[]): HTMLElement {
  const n = nodes.find((x) => x.id === selected);
  if (!n) {
    return h('div', { class: 'card' }, h('h3', null, 'Map'), h('div', { class: 'age' }, 'Purple is talk, dashed amber is a question still open, red is a conflict. Click anything to focus on it.'));
  }
  const related = edges.filter((e) => e.a === n.id || e.b === n.id);
  return h('div', { class: 'card' },
    h('h3', null, n.type),
    n.name ? agentChip(board, n.name) : h('strong', null, n.label),
    n.data?.role ? h('div', null, n.data.role) : null,
    n.data?.branch ? h('div', { class: 'mono' }, n.data.branch) : null,
    n.data?.file ? h('div', { class: 'mono' }, n.data.file) : null,
    n.data?.why ? h('div', { class: 'mono' }, n.data.why) : null,
    h('div', { style: { 'margin-top': '8px' } }, related.map((e) => h('div', { class: 'age' }, e.title))),
  );
}

export default {
  id: 'graph',
  title: 'Graph',
  order: 3,
  render(root, board) {
    const { nodes, edges } = build(board);
    layout(nodes, edges);
    const near = new Set();
    if (selected) {
      near.add(selected);
      for (const e of edges) {
        if (e.a === selected) near.add(e.b);
        if (e.b === selected) near.add(e.a);
      }
    }
    const dimmed = (id: string) => selected && !near.has(id);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Map of agents, what they hold and who is talking' });
    svg.append(s('defs', null, s('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'context-stroke' }))));
    for (const e of edges) {
      const a = positions.get(e.a)!;
      const b = positions.get(e.b)!;
      const style = EDGE[e.type];
      const isTalk = e.type === 'talk' || e.type === 'ask';
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const trim = isTalk ? 28 : 0;
      const ex = b.x - (dx / d) * trim;
      const ey = b.y - (dy / d) * trim;
      const mx = (a.x + ex) / 2 - (dy / d) * (isTalk ? 26 : 0);
      const my = (a.y + ey) / 2 + (dx / d) * (isTalk ? 26 : 0);
      svg.append(s('path', {
        d: `M ${a.x} ${a.y} Q ${mx} ${my} ${ex} ${ey}`,
        fill: 'none',
        stroke: style.stroke,
        'stroke-width': isTalk ? Math.min(1.5 + (e.count ?? 1) * 0.6, 6) : style.width,
        'stroke-dasharray': style.dash ?? null,
        'marker-end': isTalk ? 'url(#arrow)' : null,
        class: dimmed(e.a) || dimmed(e.b) ? 'dim' : null,
      }, s('title', null, e.title)));
    }
    for (const n of nodes) svg.append(shape(board, n, positions.get(n.id)!, dimmed(n.id)));
    svg.addEventListener('click', (event) => {
      const id = (event.target as Element).closest<HTMLElement | SVGElement>('[data-id]')?.dataset.id ?? null;
      selected = id === selected ? null : id;
      this.render(root, board);
    });
    const toggle = h('input', {
      type: 'checkbox',
      checked: talkOnly,
      onchange: (event: Event) => {
        talkOnly = (event.target as HTMLInputElement).checked;
        this.render(root, board);
      },
    });
    root.replaceChildren(
      h('div', { class: 'legend' }, h('label', { class: 'check' }, toggle, 'Talk only')),
      h('div', { class: 'graph' }, svg, h('div', null, details(board, nodes, edges))),
    );
  },
} satisfies View;
