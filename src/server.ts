import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './board.ts';
import { UserError } from './errors.ts';
import { sendMessage } from './messages.ts';
import type { Ctx } from './types.ts';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.ts': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new UserError('Message too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const clean = pathname === '/' ? '/index.html' : pathname;
  // Only known files in known folders are ever served, so a path can't walk out of ui/.
  const allowed = new Set(['/index.html', '/app.ts', '/app.css', '/dom.ts']);
  if (existsSync(join(uiDir, 'views'))) {
    for (const name of readdirSync(join(uiDir, 'views'))) allowed.add(`/views/${name}`);
  }
  if (!allowed.has(clean)) return send(res, 404, '{"error":"not found"}');
  const file = join(uiDir, ...clean.split('/').filter(Boolean));
  // The dashboard is TypeScript too. The browser gets it with the types taken out, so there is no build step.
  const body = extname(clean) === '.ts' ? stripTypeScriptTypes(readFileSync(file, 'utf8')) : readFileSync(file);
  send(res, 200, body, TYPES[extname(clean)] ?? 'text/plain');
}

export interface StartedServer {
  server: Server;
  token: string;
  port: number;
  url: string;
}

export function startServer(ctx: Ctx, { port = ctx.config.port, host = '127.0.0.1' }: { port?: number | undefined; host?: string } = {}): Promise<StartedServer> {
  // Held in memory and handed over in the URL. No GET ever returns it.
  const token = randomBytes(24).toString('hex');
  let cached: string | null = null;
  let cachedAt = 0;

  const server = createServer(async (req, res) => {
    try {
      const actualPort = (server.address() as AddressInfo).port;
      const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!hosts.has(req.headers.host ?? '')) return send(res, 403, '{"error":"bad host"}');

      const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && pathname === '/api/board') {
        if (!cached || Date.now() - cachedAt > 1000) {
          cached = JSON.stringify(buildBoard(ctx));
          cachedAt = Date.now();
        }
        return send(res, 200, cached);
      }
      if (req.method === 'GET' && pathname === '/api/views') {
        const dir = join(uiDir, 'views');
        const views = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.ts')).sort() : [];
        return send(res, 200, JSON.stringify(views));
      }
      if (req.method === 'POST' && pathname === '/api/note') {
        const origin = req.headers.origin;
        if (!origin || !hosts.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, '{"error":"bad origin"}');
        if (req.headers['x-zm-token'] !== token) return send(res, 401, '{"error":"open the dashboard from the link it printed"}');
        const { to, kind, body } = JSON.parse(await readBody(req));
        const message = sendMessage(ctx, { from: ctx.config.human, to, kind: kind ?? 'note', body, via: 'dashboard' });
        cached = null;
        return send(res, 200, JSON.stringify({ id: message.id }));
      }
      if (req.method === 'GET') return serveStatic(res, pathname);
      return send(res, 405, '{"error":"method not allowed"}');
    } catch (error) {
      const status = error instanceof UserError || error instanceof SyntaxError ? 400 : 500;
      return send(res, status, JSON.stringify({ error: (error as Error).message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, token, port: actual, url: `http://127.0.0.1:${actual}/#t=${token}` });
    });
  });
}
