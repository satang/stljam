import test from 'node:test';
import assert from 'node:assert/strict';
import { partChanges } from '../src/web/parts.mjs';

test('marks model changes and tracks removals by stable part ID', () => {
  const base = { id: 'base', asset: 'base-mesh', transform: [1, 0, 0] };
  const mount = { id: 'mount', asset: 'mount-mesh' };
  const bolt = { id: 'bolt', asset: 'bolt-mesh' };
  const lid = { id: 'lid', asset: 'lid-mesh' };
  const current = [{ ...base, transform: [1, 5, 0] }, { ...mount, asset: 'revised-mount' }, { ...bolt, label: 'Bolt A', group: ['Hardware'] }, lid];
  assert.deepEqual(partChanges(current, [base, mount, bolt, { id: 'washer' }]), {
    changes: new Map([['base', 'Updated'], ['mount', 'Updated'], ['lid', 'Added']]), removed: 1
  });
  assert.deepEqual(partChanges(current), { changes: new Map(), removed: 0 });
});
