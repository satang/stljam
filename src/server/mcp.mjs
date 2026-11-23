import pkg from '../../package.json' with { type: 'json' };
import { publish, request } from './client.mjs';
import { identifier } from '../core/review.mjs';

const string = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'list_reviews', description: 'List local 3D review projects.', inputSchema: schema({}) },
  { name: 'open_review', description: 'Get the latest review URL, version, and part list, or publish v1 from a manifest in the registered workspace.', inputSchema: schema({ projectId: string, title: string, manifestPath: string, requestId: string }, ['projectId']) },
  { name: 'get_feedback', description: 'Read submitted feedback with original and detail images when available. Grouped marks are numbered in order within the comment. Batch IDs are safe to read again. Coordinates are in millimeters.', inputSchema: schema({ projectId: string, afterBatchId: string, batchId: string }, ['projectId']) },
  { name: 'wait_for_feedback', description: 'Wait for a submitted review. If status is waiting, call again immediately with the returned cursor. Repeat in the same turn for up to about 10 minutes per review round.', inputSchema: schema({ projectId: string, cursor: string, seconds: { type: 'integer', minimum: 1, maximum: 20 } }, ['projectId']) },
  { name: 'add_version', description: 'Publish a revised preview and record the outcome of submitted comments. In an ongoing review, share the updated link and restart wait_for_feedback in the same turn using the last feedback cursor.', inputSchema: schema({ projectId: string, baseVersion: { type: 'integer' }, manifestPath: string, requestId: string, note: string, outcomes: { type: 'array', items: schema({ commentId: string, status: { enum: ['applied', 'pending', 'needs-clarification'] }, note: string }, ['commentId', 'status']) } }, ['projectId', 'baseVersion', 'manifestPath', 'requestId']) }
];

async function feedback(base, project, after, batch) {
  const query = new URLSearchParams();
  if (after) query.set('after', after);
  if (batch) query.set('batch', batch);
  return request(base, `/api/projects/${project}/feedback?${query}`);
}

async function call(name, args, base, signal, local) {
  if (name === 'list_reviews') return request(base, '/api/projects');
  const id = identifier(args.projectId, 'Project');
  const workspace = process.env.STLJAM_WORKSPACE;
  if (name === 'open_review' && !args.manifestPath) {
    const review = await request(base, `/api/projects/${id}`);
    const latest = review.versions.at(-1);
    const parts = latest.model.parts.map(({ id, label, group }) => ({ id, label, group }));
    return { id, version: latest.number, url: `${base}/review/${id}`, parts };
  }
  if (name === 'open_review' || name === 'add_version') {
    if (!workspace) throw new Error('Set STLJAM_WORKSPACE to publish through HTTP or use the CLI.');
    return publish(base, { ...args, workspace, baseVersion: name === 'open_review' ? 0 : args.baseVersion });
  }
  if (name === 'get_feedback') return feedback(base, id, args.afterBatchId, args.batchId);
  if (name === 'wait_for_feedback') {
    if (local) return local.waitForFeedback(id, args.cursor, args.seconds);
    const query = new URLSearchParams();
    if (args.cursor) query.set('after', args.cursor);
    if (args.seconds !== undefined) query.set('seconds', args.seconds);
    return request(base, `/api/projects/${id}/listen?${query}`, undefined, { signal });
  }
  throw new Error('Unknown tool');
}

const supportedVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

async function feedbackImages(batches, base, signal) {
  const content = [];
  let remainingBytes = 8_000_000;
  for (const { comments } of batches) for (const comment of comments) {
    for (const [label, hash] of [['Original view', comment.capture], ['Detail view', comment.detailCapture]]) {
      if (!/^[a-f0-9]{64}$/.test(hash ?? '')) continue;
      try {
        const response = await fetch(`${base}/assets/${hash}`, { signal });
        const size = Number(response.headers.get('content-length'));
        if (!response.ok || response.headers.get('content-type') !== 'image/png' || !size || size > remainingBytes) {
          await response.body?.cancel();
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        remainingBytes -= bytes.length;
        content.push({ type: 'text', text: `${label} for comment ${comment.id}` },
          { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Keep the feedback and asset links available if an image cannot be loaded.
      }
    }
  }
  return content;
}

export async function handleRpc(message, base, signal, local) {
  const id = message?.id;
  const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const result = result => ({ jsonrpc: '2.0', id, result });
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
  if (id === undefined) return;
  if (message.method === 'initialize') return result({
    protocolVersion: supportedVersions.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25',
    capabilities: { tools: {} }, serverInfo: { name: 'stljam', version: pkg.version },
    instructions: [
      'Check the current review and reuse suitable exports. Match the work and verification to the request. Edit the CAD source when the user asks for a design change. Use add_version when the published preview changes and share the same review link.',
      'In an ongoing review, share the review URL as a progress update after publishing the first version and every revised version. Immediately call wait_for_feedback in the same turn, using the last feedback cursor when available.',
      'If wait_for_feedback returns waiting, call it again immediately with the returned cursor. Allow up to about 10 minutes of waiting for each new version, or stop sooner if the user ends the review. At the time limit, tell the user how to resume. Use get_feedback when they return. A batch with replaces supersedes the earlier batch.'
    ].join(' ')
  });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools });
  if (message.method !== 'tools/call') return error(-32601, 'Method not found');
  const name = message.params?.name;
  if (!tools.some(tool => tool.name === name)) return error(-32602, 'Unknown tool');
  try {
    const output = await call(name, message.params?.arguments ?? {}, base, signal, local);
    const batches = name === 'get_feedback' ? output : name === 'wait_for_feedback' ? output.batches : undefined;
    const images = batches ? await feedbackImages(batches, base, signal) : [];
    return result({ content: [{ type: 'text', text: JSON.stringify(output, null, 2) }, ...images] });
  } catch (failure) {
    return result({ isError: true, content: [{ type: 'text', text: failure.message }] });
  }
}
