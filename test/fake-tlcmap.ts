import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { JSON_CONTENT_TYPE, MANIFEST, v2Bytes } from './helpers/v2-fixtures.js';

export type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  delayMs?: number;
  streamBytes?: number;
};

export interface FakeTlcmap {
  baseUrl: URL;
  requests: { path: string; headers: Record<string, string> }[];
  close(): Promise<void>;
}

const CHUNK = 64 * 1024;

function defaultRoutes(): Record<string, FakeRoute> {
  const v2: Record<string, FakeRoute> = {};
  for (const e of MANIFEST) {
    v2[e.path] = { status: e.status, headers: { 'Content-Type': JSON_CONTENT_TYPE }, body: v2Bytes(e.file) };
  }
  return v2;
}

export async function startFakeTlcmap(routes: Record<string, FakeRoute> = {}): Promise<FakeTlcmap> {
  const table = { ...defaultRoutes(), ...routes };
  const requests: FakeTlcmap['requests'] = [];
  const sockets = new Set<Socket>();

  const respond = (req: IncomingMessage, res: ServerResponse): void => {
    const parsed = new URL(req.url ?? '/', 'http://fake');
    const path = parsed.pathname;
    requests.push({
      path: req.url ?? path,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]),
      ),
    });
    const route = table[path + parsed.search] ?? table[path];
    const send = (): void => {
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(route.status ?? 200, route.headers ?? {});
      if (route.streamBytes !== undefined) {
        let left = route.streamBytes;
        const pump = (): void => {
          while (left > 0) {
            const n = Math.min(CHUNK, left);
            left -= n;
            if (!res.write(Buffer.alloc(n, 0x5b))) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      res.end(route.body);
    };
    if (route?.delayMs) setTimeout(send, route.delayMs);
    else send();
  };

  const server = createServer(respond);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: new URL(`http://127.0.0.1:${port}/`),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
