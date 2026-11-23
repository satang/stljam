import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { formats, requireValue } from '../core/review.mjs';

export async function request(base, route, value, options = {}) {
  const url = new URL(base);
  requireValue(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname), 'The service must use a loopback address');
  const headers = {};
  if (value !== undefined) headers['Content-Type'] = options.binary ? 'application/octet-stream' : 'application/json';
  const response = await fetch(new URL(route, url), {
    method: value === undefined ? 'GET' : 'POST', headers,
    body: value === undefined ? undefined : options.binary ? value : JSON.stringify(value),
    signal: options.signal
  });
  const data = await response.json();
  requireValue(response.ok, data.error ?? 'The operation could not be completed', response.status);
  return data;
}

async function within(workspace, file) {
  const resolved = await realpath(resolve(workspace, file));
  const rel = relative(workspace, resolved);
  requireValue(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'File is outside the registered workspace');
  requireValue((await stat(resolved)).isFile(), 'Expected a file');
  return resolved;
}

export async function prepareManifest(base, input, workspace) {
  const safeRoot = await realpath(workspace);
  const file = await within(safeRoot, input);
  requireValue((await stat(file)).size <= 1024 * 1024, 'Manifest exceeds the size limit');
  const definition = JSON.parse(await readFile(file, 'utf8'));
  requireValue(Array.isArray(definition.parts) && definition.parts.length > 0 && definition.parts.length <= 250, 'The manifest must contain 1 to 250 parts');
  const parts = [];
  for (const part of definition.parts) {
    const absolute = await within(safeRoot, resolve(dirname(file), part.file));
    const format = extname(absolute).slice(1).toLowerCase();
    requireValue(formats.has(format), 'Supported formats are STL, 3MF, and GLB');
    requireValue((await stat(absolute)).size <= 128 * 1024 * 1024, 'The model exceeds 128 MiB');
    const asset = await request(base, '/api/assets', await readFile(absolute), { binary: true });
    const { file: ignored, ...metadata } = part;
    parts.push({ ...metadata, format, asset: asset.hash });
  }
  return { parts };
}

export async function publish(base, { projectId, title, baseVersion, manifestPath, requestId = randomUUID(), note, outcomes, workspace }) {
  const model = await prepareManifest(base, manifestPath, workspace);
  return request(base, '/api/versions', { projectId, title, baseVersion, model, requestId, note, outcomes });
}
