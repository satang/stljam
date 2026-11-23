import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { feedbackMarkdown, requireValue } from '../core/review.mjs';
import { handleRpc } from './mcp.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const maxModel = 128 * 1024 * 1024;
const maxJson = 12 * 1024 * 1024;
const importMapHash = createHash('sha256')
  .update('{"imports":{"three":"/vendor/three/build/three.module.min.js","three/addons/":"/vendor/three/examples/jsm/"}}')
  .digest('base64');

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBytes(req, limit) {
  requireValue(!req.headers['content-length'] || Number(req.headers['content-length']) <= limit, 'The request exceeds the size limit', 413);
  const parts = [];
  let length = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    length += part.length;
    requireValue(length <= limit, 'The request exceeds the size limit', 413);
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

async function readJson(req) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Expected a JSON request body', 415);
  try { return JSON.parse((await readBytes(req, maxJson)).toString()); }
  catch (error) {
    if (error instanceof SyntaxError) requireValue(false, 'Invalid JSON');
    throw error;
  }
}

export function makeServer(store) {
  const streams = new Map();
  const listeners = new Map();
  function change(project) {
    for (const stream of streams.get(project) ?? []) stream.write('event: changed\ndata: {}\n\n');
  }

  function readFeedback(project, base, options) {
    return store.feedback(project, options).map(batch => ({ ...batch, markdown: feedbackMarkdown(batch, base) }));
  }

  async function waitForFeedback(project, base, cursor, seconds, signal) {
    const pending = () => readFeedback(project, base, { after: cursor });
    const ready = batches => ({ status: 'feedback', batches, cursor: batches.at(-1).id });
    const existing = pending();
    if (existing.length) return ready(existing);

    const previous = listeners.get(project);
    const listener = previous ?? { active: 0 };
    clearTimeout(listener.timer);
    listener.active++;
    if (!previous) {
      listeners.set(project, listener);
      change(project);
    }
    const deadline = Date.now() + Math.min(20, Math.max(1, Number(seconds) || 15)) * 1000;
    let timedOut = false;
    try {
      while (Date.now() < deadline) {
        await delay(Math.min(250, deadline - Date.now()), undefined, { signal });
        const batches = pending();
        if (batches.length) return ready(batches);
      }
      timedOut = true;
      return { status: 'waiting', cursor: cursor ?? null };
    } finally {
      if (--listener.active === 0) {
        const stop = () => {
          listeners.delete(project);
          change(project);
        };
        // Bridge the short gap between consecutive MCP calls.
        if (timedOut) listener.timer = setTimeout(stop, 4000).unref();
        else stop();
      }
    }
  }

  function disconnectSignal(response) {
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    return controller.signal;
  }

  async function handle(req, res) {
    const host = req.headers.host;
    requireValue(/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host ?? ''), 'A loopback host is required', 403);
    const base = `http://${host}`;
    requireValue(!req.headers.origin || req.headers.origin === base, 'Invalid origin', 403);
    const url = new URL(req.url, base);
    const pathname = url.pathname;
    const { method } = req;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${importMapHash}'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'`);
    if (pathname === '/api/health' && method === 'GET') return reply(res, 200, { ok: true, service: 'stljam' });
    if (pathname === '/mcp' && method === 'POST') {
      const signal = disconnectSignal(res);
      const answer = await handleRpc(await readJson(req), base, signal, {
        waitForFeedback: (id, cursor, seconds) => waitForFeedback(id, base, cursor, seconds, signal)
      });
      if (signal.aborted) return;
      if (answer === undefined) { res.writeHead(202); return res.end(); }
      return reply(res, 200, answer);
    }
    if (pathname === '/mcp' && method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (pathname === '/api/assets' && method === 'POST') {
      requireValue(req.headers['content-type'] === 'application/octet-stream', 'Expected a binary model upload', 415);
      return reply(res, 201, { hash: store.addAsset(await readBytes(req, maxModel), 'application/octet-stream') });
    }
    const asset = /^\/assets\/([a-f0-9]{64})$/.exec(pathname);
    if (asset && method === 'GET') {
      const { bytes, type } = store.asset(asset[1]);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(bytes);
    }
    if (pathname === '/api/projects' && method === 'GET') return reply(res, 200, store.list());
    if (pathname === '/api/versions' && method === 'POST') {
      const result = store.publish(await readJson(req));
      if (!result.repeated) change(result.id);
      return reply(res, result.repeated ? 200 : 201, { ...result, url: `${base}/review/${result.id}` });
    }
    const route = /^\/api\/projects\/([a-zA-Z0-9_-]+)(?:\/(events|comments|submit|feedback|listen|amendments)(?:\/([a-zA-Z0-9_-]+))?)?$/.exec(pathname);
    if (route) {
      const [, id, action, member] = route;
      if (!action && method === 'GET') return reply(res, 200, { ...store.review(id), agentListening: listeners.has(id) });
      if (action === 'events' && method === 'GET') {
        store.review(id);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        if (!streams.has(id)) streams.set(id, new Set());
        const clients = streams.get(id);
        clients.add(res);
        res.write('event: ready\ndata: {}\n\n');
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => {
          clearInterval(timer);
          clients.delete(res);
          if (!clients.size) streams.delete(id);
        });
        return;
      }
      if (action === 'comments' && (method === 'POST' || method === 'PATCH')) {
        requireValue(Boolean(member) === (method === 'PATCH'), 'Invalid comment route', 405);
        const input = await readJson(req);
        const saved = store.saveComment(id, input.version, input, member);
        change(id);
        return reply(res, method === 'POST' ? 201 : 200, saved);
      }
      if (action === 'comments' && method === 'DELETE' && member) {
        store.deleteComment(id, member);
        change(id);
        return reply(res, 200, { removed: true });
      }
      if (action === 'submit' && method === 'POST') {
        const { version, comment, requestId, revision } = await readJson(req);
        const batch = store.submit(id, version, comment, requestId, revision);
        change(id);
        return reply(res, 201, batch);
      }
      if (action === 'amendments' && member && (method === 'POST' || method === 'DELETE')) {
        const result = method === 'POST' ? store.reopen(id, member) : store.discardAmendment(id, member);
        change(id);
        return reply(res, 200, result);
      }
      if (action === 'feedback' && method === 'GET') {
        return reply(res, 200, readFeedback(id, base, { batch: url.searchParams.get('batch'), after: url.searchParams.get('after') }));
      }
      if (action === 'listen' && !member && method === 'GET') {
        const signal = disconnectSignal(res);
        const result = await waitForFeedback(id, base, url.searchParams.get('after'), url.searchParams.get('seconds'), signal);
        if (!signal.aborted) reply(res, 200, result);
        return;
      }
    }
    if (method === 'GET') {
      let file;
      if (pathname === '/' || /^\/review\/[a-zA-Z0-9_-]+$/.test(pathname)) file = 'src/web/index.html';
      if (/^\/(vendor\/three|src\/(web|core))\/[a-zA-Z0-9_./-]+$/.test(pathname)) file = pathname.slice(1);
      if (file) {
        const full = resolve(root, file);
        requireValue(full.startsWith(root.endsWith(sep) ? root : root + sep), 'File not found', 404);
        const contentType = mime[extname(full)];
        requireValue(contentType, 'File not found', 404);
        const bytes = await readFile(full).catch(() => null);
        requireValue(bytes, 'File not found', 404);
        res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
        return res.end(bytes);
      }
    }
    reply(res, 404, { error: 'Route not found' });
  }

  return createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      if (!error.status) console.error(error);
      reply(res, error.status ?? 500, { error: error.status ? error.message : 'Internal error' });
    });
  });
}
