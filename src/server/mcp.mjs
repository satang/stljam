import pkg from '../../package.json' with { type: 'json' };
import { publish, request } from './client.mjs';
import { identifier } from '../core/review.mjs';

const string = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'list_reviews', description: 'List local 3D review projects.', inputSchema: schema({}) },
  { name: 'open_review', description: 'Open an existing project, or publish v1 from a manifest in the registered workspace.', inputSchema: schema({ projectId: string, title: string, manifestPath: string, requestId: string }, ['projectId']) },
  { name: 'get_feedback', description: 'Read submitted feedback. Batch IDs are safe to read again. Coordinates are in millimeters.', inputSchema: schema({ projectId: string, afterBatchId: string, batchId: string }, ['projectId']) },
  { name: 'wait_for_feedback', description: 'Wait briefly for a submitted review. Continue with the returned cursor while status is waiting.', inputSchema: schema({ projectId: string, cursor: string, seconds: { type: 'integer', minimum: 1, maximum: 20 } }, ['projectId']) },
  { name: 'add_version', description: 'Publish a revision and record the disposition of submitted comments.', inputSchema: schema({ projectId: string, baseVersion: { type: 'integer' }, manifestPath: string, requestId: string, note: string, outcomes: { type: 'array', items: schema({ commentId: string, status: { enum: ['applied', 'pending', 'needs-clarification'] }, note: string }, ['commentId', 'status']) } }, ['projectId', 'baseVersion', 'manifestPath', 'requestId']) }
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
    return { id, version: review.versions.at(-1).number, url: `${base}/review/${id}` };
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

export async function handleRpc(message, base, signal, local) {
  const id = message?.id;
  const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const result = result => ({ jsonrpc: '2.0', id, result });
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
  if (id === undefined) return;
  if (message.method === 'initialize') return result({
    protocolVersion: supportedVersions.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25',
    capabilities: { tools: {} }, serverInfo: { name: 'stljam', version: pkg.version },
    instructions: 'Share the review URL and call wait_for_feedback before ending your turn. While waiting, call it again with the returned cursor for up to 10 minutes in total. Apply the requested changes in the editable CAD source, verify and publish a new revision with add_version, then wait again using the last cursor. If the turn has ended, use get_feedback to resume. A batch with replaces supersedes that earlier batch.'
  });
  if (message.method === 'ping') return result({});
  if (message.method === 'tools/list') return result({ tools });
  if (message.method !== 'tools/call') return error(-32601, 'Method not found');
  const name = message.params?.name;
  if (!tools.some(tool => tool.name === name)) return error(-32602, 'Unknown tool');
  try {
    const output = await call(name, message.params?.arguments ?? {}, base, signal, local);
    return result({ content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] });
  } catch (failure) {
    return result({ isError: true, content: [{ type: 'text', text: failure.message }] });
  }
}
