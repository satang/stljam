import assert from 'node:assert/strict';
import test from 'node:test';
import { assignPartColors } from '../src/web/part-colors.mjs';

const box = (id, x) => ({ id, min: [x, 0, 0], max: [x + 1, 1, 1] });

test('keeps nearby overlapping parts distinct and does not depend on manifest order', () => {
  const boxes = Array.from({ length: 30 }, (_, i) => box(`part-${i}`, i / 100));
  const colors = assignPartColors(boxes, 2);
  assert.equal(new Set(colors.values()).size, boxes.length);
  assert.deepEqual(assignPartColors([...boxes].reverse(), 2), colors);
});

test('distinguishes neighbors that meet across a small clearance', () => {
  const boxes = [box('left', 0), box('right', 1.05)];
  const colors = assignPartColors(boxes, 3);
  assert.notEqual(colors.get('left'), colors.get('right'));
  const changed = assignPartColors([boxes[0], box('right', 1.03)], 3, colors);
  assert.deepEqual(changed, colors);
});
