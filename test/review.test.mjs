import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { makeServer } from '../src/server/api.mjs';
import { publish, request } from '../src/server/client.mjs';
import { Store } from '../src/server/store.mjs';
import { annotation, manifest } from '../src/core/review.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stljam-test-'));
  const store = new Store(root);
  const server = makeServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, base };
}

async function waitUntilListening(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await request(base, '/api/projects/gearbox')).agentListening) return;
    await delay(20);
  }
  assert.fail('The listener did not become visible');
}

const triangle = width => Buffer.from(`solid test
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex ${width} 0 0
vertex 0 10 0
endloop
endfacet
endsolid test\n`);
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBTUAAAAASUVORK5CYII=';

async function newScene(base, workspace) {
  await writeFile(join(workspace, 'part.stl'), triangle(20));
  await writeFile(join(workspace, 'model.json'), JSON.stringify({ parts: [
    { id: 'gearbox', file: 'part.stl', units: 'mm', source: 'example.FCStd#Body' },
    { id: 'duplicate', file: 'part.stl', group: ['Assembly', 'Drivetrain'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] }
  ] }));
  const params = { projectId: 'gearbox', title: 'Test gearbox', workspace, manifestPath: 'model.json' };
  const opened = await publish(base, { ...params, requestId: 'first', baseVersion: 0 });
  return { params, opened };
}

const draft = {
  version: 1, text: 'Thicken the wall outward.', target: { kind: 'point', partId: 'gearbox', point: [10, 0, 0], normal: [0, 0, 1] },
  view: { position: [20, -20, 20], center: [0, 0, 0], projection: 'orthographic', zoom: 1, frame: 48, hidden: ['duplicate'], section: { axis: 'Y', offset: 0, flip: false } },
  measurement: { a: [0, 0, 0], b: [20, 0, 0] }, capture: pixel
};

test('publishes, comments, emits events, and preserves and recovers revisions', async t => {
  const { root, base } = await fixture(t);
  const { params, opened } = await newScene(base, root);
  assert.equal(opened.url, base + '/review/gearbox');
  const projectPath = '/api/projects/gearbox';
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(base + projectPath + '/events', { signal: controller.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /event: ready/);

  const first = await request(base, projectPath);
  assert.equal(first.versions[0].model.parts[1].transform[12], 5);
  const saved = await request(base, projectPath + '/comments', draft);
  assert.match((await reader.read()).value, /event: changed/);
  assert.equal(saved.measurement.mm, 20);
  assert.equal(saved.view.frame, 48);
  assert.deepEqual(await request(base, projectPath + '/feedback'), []);
  const png = await fetch(base + '/assets/' + saved.capture);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const batch = await request(base, projectPath + '/submit', { version: 1 });
  const [feedback] = await request(base, projectPath + '/feedback?batch=' + batch.id);
  assert.equal(feedback.comments[0].source, 'example.FCStd#Body');
  assert.match(feedback.markdown, /20\.000 mm/);
  assert.deepEqual(await request(base, projectPath + '/feedback?batch=' + batch.id), [feedback]);
  await assert.rejects(request(base, projectPath + '/submit', {
    version: 1, comment: { ...draft, id: saved.id, text: 'Attempt to edit a previous submission' }
  }), /review is closed/);

  await writeFile(join(root, 'part.stl'), triangle(21));
  const args = { ...params, baseVersion: 1, requestId: 'second',
    outcomes: [{ commentId: saved.id, status: 'applied', note: 'Revised the wall' }]
  };
  assert.equal((await publish(base, args)).version, 2);
  assert.equal((await publish(base, args)).repeated, true);
  await assert.rejects(publish(base, { ...args, note: 'changed' }), /already used/);
  await assert.rejects(publish(base, { ...args, requestId: 'third' }), /current version is v2/);
  const second = await request(base, projectPath);
  assert.equal(second.versions.length, 2);
  assert.equal(second.comments[0].version, 1);
  const nextDraft = await request(base, projectPath + '/comments', { ...draft, version: 2 });
  assert.equal(nextDraft.version, 2);
  for (const [index, version] of second.versions.entries()) {
    const artifact = await fetch(base + '/assets/' + version.model.parts[0].asset);
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), triangle(20 + index));
  }
  await reader.cancel();
});

test('keeps drafts on their original version and can submit them later', async t => {
  const { root, base } = await fixture(t);
  const { params } = await newScene(base, root);
  await request(base, '/api/projects/gearbox/comments', draft);
  await publish(base, { ...params, requestId: 'next', baseVersion: 1 });
  const batch = await request(base, '/api/projects/gearbox/submit', { version: 1 });
  const historical = await request(base, '/api/projects/gearbox/feedback?batch=' + batch.id);
  assert.equal(historical[0].version, 1);
  assert.deepEqual(historical[0].comments[0].target.point, [10, 0, 0]);
});

test('preserves a multi-part region and a group of marks with their sources', async t => {
  const { root, base } = await fixture(t);
  await newScene(base, root);
  const path = '/api/projects/gearbox';
  const region = {
    kind: 'region', outline: [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]],
    parts: [{ partId: 'gearbox', points: [[1, 2, 3], [4, 5, 6]] }, { partId: 'duplicate', points: [[0, 1, 2]] }]
  };
  const saved = await request(base, `${path}/comments`, { ...draft, target: region });
  assert.deepEqual(saved.target, region);
  const paint = { kind: 'paint', radius: .5, parts: [{ partId: 'gearbox', points: [[2, 3, 4]] }, { partId: 'duplicate', points: [[3, 4, 5]] }] };
  const group = { kind: 'group', marks: [draft.target, region, { kind: 'point', partId: 'duplicate', point: [3, 4, 5] }, paint] };
  await assert.rejects(request(base, `${path}/comments`, { ...draft, target: { ...group, marks: [draft.target, group] } }), /Only points, regions and paint strokes/);
  await assert.rejects(request(base, `${path}/comments`, { ...draft, target: { ...paint, radius: 0 } }), /Invalid paint radius/);
  const grouped = await request(base, `${path}/comments`, { ...draft, text: 'Check the mating parts', target: group });
  assert.deepEqual(grouped.target, group);
  const { id } = await request(base, `${path}/submit`, { version: 1 });
  const [feedback] = await request(base, `${path}/feedback?batch=${id}`);
  const single = feedback.comments.find(comment => comment.id === saved.id);
  assert.deepEqual(single.target, region);
  assert.equal(single.sources[0].source, 'example.FCStd#Body');
  const recovered = feedback.comments.find(comment => comment.id === grouped.id);
  assert.deepEqual(recovered.target, group);
  assert.deepEqual(recovered.sources, [{ partId: 'gearbox', source: 'example.FCStd#Body' }, { partId: 'duplicate' }]);
  assert.match(feedback.markdown, /1\. gearbox.*Local point/);
  assert.match(feedback.markdown, /2\. Region/);
  assert.match(feedback.markdown, /3\. duplicate.*Local point/);
  assert.match(feedback.markdown, /4\. Painted surface \(brush radius 0\.5 mm\)/);
  assert.match(feedback.markdown, /gearbox: 2 samples between \[1, 2, 3\] mm and \[4, 5, 6\] mm/);
  assert.match(feedback.markdown, /from A \[0, 0, 0\] mm to B \[20, 0, 0\] mm/);
});

test('migrates a legacy database and keeps the review closed until reopened', async t => {
  const { root, base, store } = await fixture(t);
  await newScene(base, root);
  const path = '/api/projects/gearbox';
  store.db.exec('CREATE UNIQUE INDEX old_batches ON batches (project, version)');
  const original = await request(base, `${path}/submit`, { version: 1, comment: draft });
  const [first] = await request(base, `${path}/feedback?batch=${original.id}`);
  const migrated = new Store(root);
  migrated.close();
  await assert.rejects(request(base, `${path}/comments`, draft), /review is closed/);
  await assert.rejects(request(base, `${path}/submit`, { version: 1 }), /review is closed/);
  assert.deepEqual(await request(base, `${path}/feedback?batch=${original.id}`), [first]);

  await request(base, `${path}/amendments/${original.id}`, {});
  const pending = await request(base, `${path}/comments`, { ...draft, revision: original.id, text: 'Another comment after reopening' });
  const submission = { version: 1, revision: original.id, requestId: 'retry-safe-correction' };
  const corrected = await request(base, `${path}/submit`, submission);
  assert.deepEqual(await request(base, `${path}/submit`, submission), corrected);
  const [latest] = await request(base, `${path}/feedback?after=${original.id}`);
  assert.equal(latest.replaces, original.id);
  assert.equal(latest.comments.find(comment => comment.id === pending.id).text, 'Another comment after reopening');
  assert.deepEqual(await request(base, `${path}/feedback?after=${corrected.id}`), []);
  await assert.rejects(request(base, `${path}/comments`, draft), /review is closed/);
});

test('revises a submission without altering its history or other drafts', async t => {
  const { root, base } = await fixture(t);
  const { params } = await newScene(base, root);
  const path = '/api/projects/gearbox';
  const original = await request(base, `${path}/comments`, { ...draft, text: 'Original comment' });
  await request(base, `${path}/comments`, { ...draft, text: 'Comment to remove' });
  const first = await request(base, `${path}/submit`, { version: 1 });
  const before = await request(base, `${path}/feedback?batch=${first.id}`);
  await publish(base, { ...params, requestId: 'next', baseVersion: 1 });
  const normal = await request(base, `${path}/comments`, { ...draft, version: 2, text: 'Draft on another version' });

  const reopen = await request(base, `${path}/amendments/${first.id}`, {});
  assert.deepEqual(await request(base, `${path}/amendments/${first.id}`, {}), reopen);
  const review = await request(base, path);
  assert.deepEqual(review.amendments, [{ version: 1, batch: first.id }]);
  const copies = review.comments.filter(comment => comment.revision === first.id);
  assert.equal(copies.length, 2);
  const edit = copies.find(comment => comment.text === 'Original comment');
  const remove = copies.find(comment => comment !== edit);
  assert.notEqual(edit.id, original.id);
  assert.equal(edit.capture, original.capture);
  const patch = (id, value, method) => fetch(`${base}${path}/comments/${id}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value)
  });
  assert.equal((await patch(edit.id, { ...draft, revision: first.id, text: 'Edited comment' }, 'PATCH')).status, 200);
  assert.equal((await patch(remove.id, undefined, 'DELETE')).status, 200);
  const corrected = await request(base, `${path}/submit`, { version: 1, revision: first.id, comment: { ...draft, text: 'Added comment' } });
  const [latest] = await request(base, `${path}/feedback?after=${first.id}`);
  assert.equal(latest.id, corrected.id);
  assert.equal(latest.replaces, first.id);
  assert.deepEqual(latest.comments.map(comment => comment.text), ['Edited comment', 'Added comment']);
  assert.match(latest.markdown, /This submission replaces review/);
  assert.deepEqual(await request(base, `${path}/feedback?batch=${first.id}`), before);
  assert.deepEqual((await request(base, path)).comments.filter(comment => !comment.batch).map(comment => comment.id), [normal.id]);
  await assert.rejects(request(base, `${path}/amendments/${first.id}`, {}), /already been replaced/);

  await request(base, `${path}/amendments/${corrected.id}`, {});
  assert.equal((await fetch(`${base}${path}/amendments/${corrected.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await request(base, `${path}/feedback?after=${corrected.id}`), []);
  await request(base, `${path}/amendments/${corrected.id}`, {});
  for (const comment of (await request(base, path)).comments.filter(item => !item.batch && item.revision === corrected.id)) {
    assert.equal((await patch(comment.id, undefined, 'DELETE')).status, 200);
  }
  await request(base, `${path}/submit`, { version: 1, revision: corrected.id });
  const [withdrawal] = await request(base, `${path}/feedback?after=${corrected.id}`);
  assert.equal(withdrawal.replaces, corrected.id);
  assert.deepEqual(withdrawal.comments, []);
  assert.match(withdrawal.markdown, /withdrew every comment/);
});

test('negotiates MCP and delivers a review while listening', async t => {
  const { root, base } = await fixture(t);
  await newScene(base, root);
  const rpc = (method, params, id = 1) => request(base, '/mcp', { jsonrpc: '2.0', id, method, params });
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal((await rpc('tools/list')).result.tools.length, 5);
  const payload = response => JSON.parse(response.result.content[0].text);
  const opened = payload(await rpc('tools/call', { name: 'open_review', arguments: { projectId: 'gearbox' } }));
  assert.equal(opened.version, 1);
  assert.deepEqual(opened.parts, [{ id: 'gearbox', label: 'gearbox' }, { id: 'duplicate', label: 'duplicate', group: ['Assembly', 'Drivetrain'] }]);
  const wait = rpc('tools/call', { name: 'wait_for_feedback', arguments: { projectId: 'gearbox', seconds: 4 } });
  await waitUntilListening(base);
  const endpoints = {
    a: { partId: 'gearbox', point: [0, 0, 0], normal: [0, 0, 1], surface: 'mesh' },
    b: { partId: 'duplicate', point: [15, 0, 0], normal: [0, -1, 0], surface: 'section' }
  };
  const saved = await request(base, '/api/projects/gearbox/comments', {
    ...draft, measurement: { ...draft.measurement, endpoints }, detailCapture: pixel
  });
  assert.deepEqual(saved.measurement.endpoints, endpoints);
  const batch = await request(base, '/api/projects/gearbox/submit', { version: 1 });
  const delivered = await wait;
  assert.equal(payload(delivered).cursor, batch.id);
  assert.equal(payload(delivered).batches[0].comments[0].detailCapture, saved.detailCapture);
  const deliveredMeasurement = payload(delivered).batches[0].comments[0].measurement;
  assert.equal(deliveredMeasurement.endpoints.a.source, 'example.FCStd#Body');
  assert.equal(deliveredMeasurement.endpoints.b.transform[12], 5);
  assert.match(payload(delivered).batches[0].markdown, /B: duplicate.*section fill \(virtual/);
  assert.deepEqual(delivered.result.content.slice(1), [
    { type: 'text', text: `Original view for comment ${saved.id}` },
    { type: 'image', mimeType: 'image/png', data: pixel.slice(22) },
    { type: 'text', text: `Detail view for comment ${saved.id}` },
    { type: 'image', mimeType: 'image/png', data: pixel.slice(22) }
  ]);
  const recovered = await rpc('tools/call', { name: 'get_feedback', arguments: { projectId: 'gearbox', batchId: batch.id } });
  assert.deepEqual(recovered.result.content.slice(1), delivered.result.content.slice(1));
  assert.equal((await request(base, '/api/projects/gearbox')).agentListening, false);
  const next = await rpc('tools/call', { name: 'wait_for_feedback', arguments: { projectId: 'gearbox', seconds: 1, cursor: batch.id } });
  assert.equal(payload(next).status, 'waiting');
  const notification = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.equal(notification.status, 202);
});

test('enforces loopback access and serves the browser modules', async t => {
  const { base } = await fixture(t);
  const blocked = await fetch(base + '/api/projects', { headers: { Origin: 'https://example.com' } });
  assert.equal(blocked.status, 403);
  const page = await fetch(base);
  const html = await page.text();
  const importMap = html.match(/type="importmap">(.*?)<\/script>/)[1];
  const hash = createHash('sha256').update(importMap).digest('base64');
  assert.ok(page.headers.get('content-security-policy').includes(hash));
  for (const asset of ['/src/web/app.mjs', '/src/web/viewport.mjs', '/vendor/three/build/three.module.min.js', '/vendor/three/build/three.core.min.js']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(base + '/package.json')).status, 404);
});

test('receives a review and publishes v2 over MCP stdio without mixing server output', async t => {
  const { base, root } = await fixture(t);
  await newScene(base, root);
  const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'mcp', '--port', new URL(base).port, '--workspace', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const received = once(lines, 'line', { signal: AbortSignal.timeout(6000) });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'open_review', arguments: { projectId: 'gearbox' }
  } }) + '\n');
  const [line] = await received;
  const reply = JSON.parse(line);
  assert.equal(reply.id, 1);
  assert.equal(JSON.parse(reply.result.content[0].text).url, base + '/review/gearbox');
  const call = async (id, name, args = {}) => {
    const response = once(lines, 'line', { signal: AbortSignal.timeout(6000) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectId: 'gearbox', ...args } } }) + '\n');
    const [line] = await response;
    const reply = JSON.parse(line);
    assert.equal(reply.id, id);
    assert.equal(reply.result.isError, undefined, reply.result.content[0].text);
    return JSON.parse(reply.result.content[0].text);
  };
  const wait = call(2, 'wait_for_feedback', { seconds: 4 });
  await waitUntilListening(base);
  const saved = await request(base, '/api/projects/gearbox/comments', draft);
  const batch = await request(base, '/api/projects/gearbox/submit', { version: 1 });
  const delivered = await wait;
  assert.equal(delivered.cursor, batch.id);
  assert.equal(delivered.batches[0].comments[0].id, saved.id);
  await writeFile(join(root, 'part.stl'), triangle(21));
  const revised = await call(3, 'add_version', { baseVersion: 1, manifestPath: 'model.json', requestId: 'second-stdio',
    note: 'Housing updated', outcomes: [{ commentId: saved.id, status: 'applied' }] });
  assert.equal(revised.version, 2);
  const project = await request(base, '/api/projects/gearbox');
  assert.deepEqual(project.comments.map(comment => comment.version), [1]);
  assert.notEqual(project.versions[0].model.parts[0].asset, project.versions[1].model.parts[0].asset);
  const exited = once(child, 'exit');
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});

test('the CLI confines manifest reads to the workspace', async t => {
  const { base, root } = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'stljam-other-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'part.stl'), triangle(20));
  await writeFile(join(root, 'model.json'), JSON.stringify({ parts: [{ id: 'p', file: join(external, 'part.stl') }] }));
  await assert.rejects(publish(base, { projectId: 'p', title: 'P', baseVersion: 0, workspace: root, manifestPath: 'model.json' }), /outside the registered workspace/);
  assert.deepEqual(await request(base, '/api/projects'), []);
});

test('validates units, transforms, and annotation targets', () => {
  const part = { id: 'body', format: 'stl', asset: 'a'.repeat(64) };
  assert.throws(() => manifest({ parts: [part, part] }), /Duplicate part ID/);
  assert.throws(() => manifest({ parts: [{ ...part, transform: Array(16).fill(0) }] }), /invertible/);
  assert.throws(() => manifest({ parts: [{ ...part, units: 'pixels' }] }), /Invalid unit/);
  assert.throws(() => manifest({ parts: [{ ...part, group: 'Assembly' }] }), /Group must be a path/);
  assert.throws(() => manifest({ parts: [{ ...part, group: ['Assembly', ' '] }] }), /Invalid Group name/);
  const model = manifest({ parts: [part] });
  assert.throws(() => annotation({ text: 'x', target: { kind: 'point', partId: 'other' } }, model), /Unknown part/);
  assert.throws(() => annotation({ text: 'x', target: { kind: 'point', partId: 'body', point: [0, 1, Infinity] } }, model), /Invalid Point/);
});
