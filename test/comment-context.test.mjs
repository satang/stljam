import test from 'node:test';
import assert from 'node:assert/strict';
import { commentContext } from '../src/web/markup.mjs';

const partName = id => ({ base: 'Base', mount: 'Motor mount' })[id] ?? id;
const assembly = { kind: 'assembly' };
const a = { partId: 'base', surface: 'mesh' };
const b = { partId: 'mount', surface: 'section' };
const measurement = { a: [0, 0, 0], b: [3.6, 0, 0], endpoints: { a, b } };

test('labels in-progress, completed, and older measurements', () => {
  assert.equal(commentContext(assembly, undefined, partName), 'Entire assembly');
  assert.equal(commentContext(assembly, undefined, partName, a), 'Measure · Select point B · A: Base');
  assert.equal(commentContext(assembly, measurement, partName), 'Measure · 3.6 mm · A: Base → B: Motor mount (section fill)');
  assert.equal(commentContext(assembly, { a: measurement.a, b: measurement.b }, partName), 'Measure · 3.6 mm');
});

test('preserves the context of points, regions and paint alongside a measurement', () => {
  const point = { kind: 'point', partId: 'base', surface: 'section' };
  const region = { kind: 'region', parts: [{ partId: 'mount' }] };
  const paint = { kind: 'paint', parts: [{ partId: 'base' }, { partId: 'mount' }] };
  assert.equal(commentContext(point, undefined, partName), 'Point on section · Base');
  assert.equal(commentContext(region, undefined, partName), 'Region · Motor mount');
  assert.equal(commentContext(paint, undefined, partName), 'Painted surface · Base, Motor mount');
  const group = { kind: 'group', marks: [point, region, paint] };
  assert.match(commentContext(group, measurement, partName), /Measure · 3\.6 mm.* · 3 marks · Base, Motor mount$/);
});
