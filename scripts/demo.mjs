import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publish, request } from '../src/server/client.mjs';

function solid(name, faces) {
  const facets = [];
  for (const [a, ...rest] of faces) {
    for (let i = 1; i < rest.length; i++) {
      const b = rest[i - 1], c = rest[i];
      const [x, y, z] = b.map((n, axis) => n - a[axis]);
      const [u, v, w] = c.map((n, axis) => n - a[axis]);
      const normal = [y * w - z * v, z * u - x * w, x * v - y * u];
      const length = Math.hypot(...normal);
      facets.push(`  facet normal ${normal.map(n => n / length).join(' ')}\n    outer loop\n${[a, b, c].map(point => `      vertex ${point.join(' ')}`).join('\n')}\n    endloop\n  endfacet`);
    }
  }
  return `solid ${name}\n${facets.join('\n')}\nendsolid ${name}\n`;
}

const rectangle = (x0, y0, x1, y1, z) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
const ring = (x, y, radius, z) => Array.from({ length: 32 }, (_, i) => {
  const angle = i * Math.PI / 16;
  return [x + radius * Math.cos(angle), y + radius * Math.sin(angle), z];
});
const bridge = (from, to) => from.map((point, i) => {
  const next = (i + 1) % from.length;
  return [point, from[next], to[next], to[i]];
});
const closed = (base, top) => [[...base].reverse(), ...bridge(base, top), top];

function housing(wall) {
  const base = rectangle(-wall, 0, 20, 18, 0);
  const rim = rectangle(-wall, 0, 20, 18, 12);
  const cavityRim = rectangle(0, 2, 18, 16, 12);
  const floor = rectangle(0, 2, 18, 16, 2);
  return [[...base].reverse(), ...bridge(base, rim), ...bridge(rim, cavityRim), ...bridge(cavityRim, floor), floor];
}

export async function writeDemoManifest(workspace, next = false) {
  await mkdir(workspace, { recursive: true });
  const wall = next ? 2.8 : 2;
  const objects = {
    Housing: housing(wall),
    Lid: closed(rectangle(-2, 0, 20, 18, 15), rectangle(-2, 0, 20, 18, 17)),
    Shaft: closed(ring(10, 9, 2, 2), ring(10, 9, 2, 10))
  };
  const parts = [];
  for (const [label, faces] of Object.entries(objects)) {
    const id = label.toLowerCase();
    const file = `${id}.stl`;
    await writeFile(resolve(workspace, file), solid(id, faces));
    parts.push({ id, label, file, units: 'mm', source: 'scripts/demo.mjs' });
  }
  const manifestPath = 'manifest.json';
  await writeFile(resolve(workspace, manifestPath), JSON.stringify({ parts }, null, 2));
  return manifestPath;
}

export async function runDemo(base, data, next = false) {
  const projectId = 'gearbox-demo';
  let current;
  try { current = await request(base, `/api/projects/${projectId}`); }
  catch (error) { if (error.status !== 404) throw error; }
  const latest = current?.versions.at(-1).number ?? 0;
  const version = next ? 2 : 1;
  const url = `${base}/review/${projectId}`;
  if (latest >= version) return { id: projectId, version: latest, repeated: true, url };
  if (next && !latest) throw new Error('Run stljam demo to publish v1 first.');
  const workspace = resolve(data, 'demo', `v${version}`);
  const manifestPath = await writeDemoManifest(workspace, next);
  return publish(base, { projectId, title: 'Gearbox demo', workspace, manifestPath, baseVersion: latest,
    requestId: `gearbox-demo-v${version}`, note: next ? 'Left wall increased from 2 to 2.8 mm. Interior clearance preserved.' : 'Sample housing, lid, and shaft.' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [cli, 'demo', ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
}
