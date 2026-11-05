import type { Board } from '../src/types.ts';
import type { View } from './dom.ts';
import { ago, h } from './dom.ts';

const POLL_MS = 2000;
const state: {
  board: Board | null;
  views: View[];
  active: string | null;
  lastOk: string | null;
  failed: string | null;
  renderedRev: string | null;
} = { board: null, views: [], active: null, lastOk: null, failed: null, renderedRev: null };

const params = new URLSearchParams(location.hash.slice(1));
const handedOver = params.get('t');
if (handedOver) {
  sessionStorage.setItem('zm-token', handedOver);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('zm-token');

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren(
    ...state.views.map((view) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: view.id === state.active ? 'tab on' : 'tab',
        'aria-selected': String(view.id === state.active),
        onclick: () => select(view.id),
      }, view.title),
    ),
  );
}

function select(id: string): void {
  state.active = id;
  location.replace(`#${id}`);
  renderTabs();
  state.renderedRev = null;
  renderView();
}

function renderView() {
  const view = state.views.find((v) => v.id === state.active);
  if (!view || !state.board || state.renderedRev === state.board.rev) return;
  state.renderedRev = state.board.rev;
  const root = $('view');
  const scroll = [...root.querySelectorAll<HTMLElement>('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollTop] as const);
  const top = root.scrollTop;
  if (root.dataset.view !== view.id) {
    root.replaceChildren();
    root.dataset.view = view.id;
  }
  view.render(root, state.board);
  root.scrollTop = top;
  for (const [key, value] of scroll) {
    const el = root.querySelector<HTMLElement>(`[data-keep-scroll="${key}"]`);
    if (el) el.scrollTop = value;
  }
}

function renderStrip() {
  const button = $('alerts');
  const live = $('live');
  const stale = state.failed !== null;
  const board = state.board;
  if (!board) {
    button.textContent = stale ? 'No data' : 'Loading';
    button.className = 'alerts';
  } else if (stale) {
    // We don't know the state now, so the count is not presented as current.
    button.textContent = 'Counts unknown';
    button.className = 'alerts unknown';
  } else {
    const { red, amber } = board.counts;
    button.textContent = red + amber === 0 ? 'All clear' : `${red} red, ${amber} amber`;
    button.className = red ? 'alerts red' : amber ? 'alerts amber' : 'alerts clear';
  }
  if (stale) {
    live.textContent = state.lastOk ? `Disconnected, data is ${ago(state.lastOk)} old` : 'Cannot reach the server';
    live.className = 'live down';
  } else if (board) {
    live.textContent = `Live, ${board.base} ${board.baseSha ? board.baseSha.slice(0, 8) : 'unknown'}, ${board.agents.length} agents`;
    live.className = 'live up';
  }
}

function renderAttention() {
  const panel = $('attention');
  const items = state.board?.attention ?? [];
  panel.replaceChildren(
    ...(items.length
      ? items.map((item) => h('div', { class: `item ${item.sev}` }, h('strong', null, item.title), h('span', null, item.detail)))
      : [h('div', { class: 'item' }, 'Nothing needs you right now.')]),
  );
}

async function poll() {
  try {
    const res = await fetch('/api/board', { cache: 'no-store' });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    state.board = (await res.json()) as Board;
    state.lastOk = new Date().toISOString();
    state.failed = null;
    renderView();
    renderAttention();
    fillRecipients();
  } catch (error) {
    state.failed = (error as Error).message;
  }
  renderStrip();
}

function fillRecipients() {
  const select = $<HTMLSelectElement>('note-to');
  const names = ['all', ...state.board!.agents.map((a) => a.name)];
  if ([...select.options].map((o) => o.value).join() === names.join()) return;
  const current = select.value;
  select.replaceChildren(...names.map((name) => h('option', { value: name }, name === 'all' ? 'All agents' : name)));
  if (names.includes(current)) select.value = current;
}

function wireComposer() {
  const dialog = $<HTMLDialogElement>('composer');
  $('compose').addEventListener('click', () => {
    $('note-result').textContent = token ? '' : 'Read-only: open the dashboard from the link it printed to send notes.';
    $<HTMLButtonElement>('note-send').disabled = !token;
    dialog.showModal();
    $('note-body').focus();
  });
  $('note-cancel').addEventListener('click', () => dialog.close());
  $('composer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = $('note-result');
    result.textContent = 'Sending';
    try {
      const res = await fetch('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ZM-Token': token ?? '' },
        body: JSON.stringify({ to: [$<HTMLSelectElement>('note-to').value], kind: $<HTMLSelectElement>('note-kind').value, body: $<HTMLTextAreaElement>('note-body').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Written to the store. It isn't "seen" until the agent's inbox says so.
      result.textContent = '';
      $<HTMLTextAreaElement>('note-body').value = '';
      dialog.close();
      poll();
    } catch (error) {
      result.textContent = `Not sent: ${(error as Error).message}`;
    }
  });
}

async function start() {
  const names = (await (await fetch('/api/views')).json()) as string[];
  const modules = (await Promise.all(names.map((name) => import(`/views/${name}`)))) as { default: View }[];
  state.views = modules.map((m) => m.default).sort((a, b) => a.order - b.order);
  const wanted = location.hash.slice(1);
  state.active = state.views.some((v) => v.id === wanted) ? wanted : (state.views[0]?.id ?? null);
  renderTabs();
  wireComposer();
  $('alerts').addEventListener('click', () => {
    const panel = $('attention');
    panel.hidden = !panel.hidden;
    $('alerts').setAttribute('aria-expanded', String(!panel.hidden));
  });
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-ts]')) el.textContent = `${ago(el.dataset.ts!)}${el.dataset.suffix ?? ''}`;
    renderStrip();
  }, 1000);
}

start();
