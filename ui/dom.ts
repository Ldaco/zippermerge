import type { Board } from '../src/types.ts';

export type Props = Record<string, unknown> | null;
export type Child = Node | string | number | boolean | null | undefined | Child[];

/** One tab of the dashboard. Each file in views/ exports one of these. */
export interface View {
  id: string;
  title: string;
  order: number;
  render(root: HTMLElement, board: Board): void;
}

// Everything is built with textContent and attributes, never innerHTML, so message text stays text.

function apply(el: HTMLElement | SVGElement, props?: Props): void {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value as string);
    else if (key === 'style') for (const [name, v] of Object.entries(value as Record<string, string>)) el.style.setProperty(name, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value as EventListener);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function fill<T extends Element>(el: T, children: Child[]): T {
  for (const child of (children as unknown[]).flat(Infinity) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  apply(el, props);
  return fill(el, children);
}

export function s(tag: string, props?: Props, ...children: Child[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  apply(el, props);
  return fill(el, children);
}

const PALETTE = ['#2f6fb0', '#b5532a', '#3d8a5f', '#7a52b3', '#a8862a', '#1f8a93', '#b0417a', '#5b6b7d'];

export function colorFor(board: Board, name: string): string {
  if (name === board.human) return '#1d2230';
  const index = board.agents.findIndex((a) => a.name === name);
  return index === -1 ? '#8a8f99' : PALETTE[index % PALETTE.length]!;
}

export function ago(ts: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** An age that keeps counting between data changes. The app ticks every [data-ts] each second. */
export function age(ts: string, suffix = ' ago'): HTMLElement {
  return h('span', { class: 'age', 'data-ts': ts, 'data-suffix': suffix }, `${ago(ts)}${suffix}`);
}

export function clock(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'none yet';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function chip(text: string, cls = ''): HTMLElement {
  return h('span', { class: `chip ${cls}` }, text);
}

export function agentChip(board: Board, name: string): HTMLElement {
  return h('span', { class: 'who', style: { '--c': colorFor(board, name) } }, name);
}
