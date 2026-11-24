const palette = [
  0x8bd4c2, 0x6ba9f0, 0xf4a052, 0xc69be7, 0xe87c91, 0xaac960,
  0xf1d76e, 0x6692ae, 0xd88854, 0x64be75, 0x8d87ec, 0xde6898,
  0x67c6e1, 0xdbbb9b, 0xf1a9cb, 0x5fa9a1, 0xb3bde8, 0x84a853,
  0xe3a13a, 0xebc5d5, 0x6680cc, 0xd56862, 0xbb9c55, 0x83d0a1,
  0xb979be, 0x5dafd2, 0x96d8e9, 0xb5a6a0, 0xe978b3, 0x879f8f,
  0xa3b451, 0xd0a3f3, 0xea9c84, 0xc3dba0, 0x749fce, 0xdda76f
];

function oklab(color) {
  const [r, g, b] = [16, 8, 0].map(shift => {
    const value = ((color >> shift) & 255) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [
    .2104542553 * l + .7936177850 * m - .0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .8086757660 * s
  ];
}

const labs = palette.map(oklab);
const contrast = labs.map(a => labs.map(b => Math.hypot(...a.map((value, i) => value - b[i]))));
const span = ({ min, max }) => Math.hypot(...max.map((value, i) => value - min[i]));
const gap = (a, b) => Math.hypot(...a.min.map((value, i) => Math.max(0, value - b.max[i], b.min[i] - a.max[i])));

function colorStart(id) {
  let hash = 0;
  for (const char of id) hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0;
  return (hash >>> 0) % palette.length;
}

export function assignPartColors(boxes, size, preferred = new Map()) {
  if (boxes.length === 1) return new Map([[boxes[0].id, palette[0]]]);
  const nodes = boxes.map(box => ({ ...box, span: span(box), neighbors: [], pressure: 0 }));
  // Compare expanded assembly-space boxes rather than testing mesh triangles.
  for (const [i, a] of nodes.entries()) for (let j = i + 1; j < nodes.length; j++) {
    const b = nodes[j];
    const reach = Math.max(size * .008, Math.min(a.span, b.span) * .12);
    const distance = gap(a, b);
    if (distance > reach) continue;
    const weight = reach ? 1 - .75 * distance / reach : 1;
    a.neighbors.push({ node: b, weight });
    b.neighbors.push({ node: a, weight });
    a.pressure += weight;
    b.pressure += weight;
  }
  nodes.sort((a, b) => b.pressure - a.pressure || (a.id < b.id ? -1 : 1));
  const assigned = new Map();
  for (const { id, neighbors } of nodes) {
    const colored = neighbors.filter(({ node }) => assigned.has(node.id));
    const used = new Set(colored.map(({ node }) => assigned.get(node.id)));
    const start = colorStart(id);
    const previous = palette.indexOf(preferred.get(id));
    let best = start;
    let bestScore = -Infinity;
    for (let offset = 0; offset < palette.length; offset++) {
      const candidate = (start + offset) % palette.length;
      if (used.size < palette.length && used.has(candidate)) continue;
      const score = colored.reduce((minimum, { node, weight }) =>
        Math.min(minimum, contrast[candidate][assigned.get(node.id)] + (1 - weight) * .12), .5)
        + (candidate === previous ? .025 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    assigned.set(id, best);
  }
  return new Map([...assigned].map(([id, index]) => [id, palette[index]]));
}
