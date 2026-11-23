#!/usr/bin/env node
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { makeServer } from './api.mjs';
import { publish, request } from './client.mjs';
import { handleRpc } from './mcp.mjs';
import { Store } from './store.mjs';
import { identifier, requireValue } from '../core/review.mjs';
import { runDemo } from '../../scripts/demo.mjs';
import pkg from '../../package.json' with { type: 'json' };

const { positionals: [command = 'help', projectId, manifestPath], values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, data: { type: 'string' }, workspace: { type: 'string' }, title: { type: 'string' },
    base: { type: 'string' }, note: { type: 'string' }, request: { type: 'string' }, batch: { type: 'string' },
    next: { type: 'boolean' }, version: { type: 'boolean' }
  }
});
const port = Number(values.port ?? process.env.STLJAM_PORT ?? 32410);
const folder = resolve(values.data ?? process.env.STLJAM_DATA ?? join(homedir(), '.stljam'));
const base = `http://127.0.0.1:${port}`;
const show = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function healthy() {
  try { return (await request(base, '/api/health', undefined, { signal: AbortSignal.timeout(500) })).service === 'stljam'; }
  catch { return false; }
}

async function start() {
  if (await healthy()) return;
  mkdirSync(folder, { recursive: true });
  const log = openSync(join(folder, 'server.log'), 'a');
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(port), '--data', folder], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env
    }).unref();
  } finally { closeSync(log); }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await healthy()) return;
    await delay(100);
  }
  throw new Error(`StlJam did not start. Check ${join(folder, 'server.log')}`);
}

async function run() {
  if (values.version) return console.log(pkg.version);
  requireValue(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid port');
  if (values.workspace) process.env.STLJAM_WORKSPACE = resolve(values.workspace);
  if (command === 'serve') {
    const store = new Store(folder);
    const server = makeServer(store);
    server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(base));
    return;
  }
  if (command === 'start') {
    await start();
    console.log(base);
    return;
  }
  if (command === 'demo') {
    await start();
    return show(await runDemo(base, folder, values.next));
  }
  if (command === 'mcp') {
    await start();
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Map();
    reader.on('close', () => { for (const controller of pending.values()) controller.abort(); });
    reader.on('line', async line => {
      let message;
      try { message = JSON.parse(line); }
      catch { return showLine({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
      if (message.method === 'notifications/cancelled') return pending.get(message.params?.requestId)?.abort();
      const controller = new AbortController();
      if (message.id !== undefined) pending.set(message.id, controller);
      try {
        const result = await handleRpc(message, base, controller.signal);
        if (result && !controller.signal.aborted) showLine(result);
      } finally { pending.delete(message.id); }
    });
    return;
  }
  if (command === 'publish') {
    await start();
    return show(await publish(base, { projectId, title: values.title ?? projectId,
      baseVersion: Number(values.base ?? 0), requestId: values.request, note: values.note,
      manifestPath, workspace: process.env.STLJAM_WORKSPACE ?? process.cwd()
    }));
  }
  if (command === 'feedback') {
    await start();
    const id = identifier(projectId, 'Project');
    const query = new URLSearchParams(values.batch ? { batch: values.batch } : {});
    return show(await request(base, `/api/projects/${id}/feedback?${query}`));
  }
  if (command !== 'help') throw new Error('Unknown command');
  console.log('stljam serve | start | demo [--next] | mcp | publish <project> <manifest.json> [--base N] | feedback <project> [--batch ID]');
}

function showLine(data) { process.stdout.write(JSON.stringify(data) + '\n'); }

run().catch(error => { console.error(error.message); process.exitCode = 1; });
