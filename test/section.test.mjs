import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtrudeGeometry, Matrix4, Path, Shape, Vector3 } from '../vendor/three/build/three.module.min.js';
import { sectionTriangles } from '../src/web/section.mjs';

test('fills the solid section and preserves its hole in both orientations', () => {
  const rim = new Shape().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).lineTo(0, 10).closePath();
  rim.holes.push(new Path().moveTo(3, 3).lineTo(3, 7).lineTo(7, 7).lineTo(7, 3).closePath());
  const mesh = new ExtrudeGeometry(rim, { depth: 8, bevelEnabled: false });
  const matrix = new Matrix4().makeTranslation(2, 5, 11);
  for (const flip of [false, true]) {
    const { positions } = sectionTriangles(mesh, matrix, 'Z', 14, flip);
    let area = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const a = new Vector3().fromArray(positions, i);
      const b = new Vector3().fromArray(positions, i + 3);
      const c = new Vector3().fromArray(positions, i + 6);
      assert.equal(a.z, 14);
      assert.equal(b.z, 14);
      assert.equal(c.z, 14);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    assert.ok(Math.abs(area - 84) < 1e-8, String(area));
  }
  assert.deepEqual(sectionTriangles(mesh, matrix, 'Z', 20).positions, []);
});
