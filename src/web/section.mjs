import { ShapeUtils, Vector2, Vector3 } from '../../vendor/three/build/three.module.min.js';

// Form closed contours from the actual section of each mesh, including holes.
export function sectionTriangles(geometry, matrix, axis, offset, flip = false) {
  const component = axis.toLowerCase();
  const [u, v] = ['x', 'y', 'z'].filter(key => key !== component);
  const epsilon = 0.00001;
  const key = point => `${Math.round(point.x / epsilon)},${Math.round(point.y / epsilon)}`;
  const vertices = new Map();
  const edges = new Map();
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index?.count ?? position.count;
  const triangle = Array.from({ length: 3 }, () => new Vector3());
  const distance = vertex => (vertex[component] - offset) * (flip ? -1 : 1);
  for (let start = 0; start + 2 < count; start += 3) {
    triangle.forEach((vertex, i) => vertex.fromBufferAttribute(position, index ? index.getX(start + i) : start + i).applyMatrix4(matrix));
    const distances = triangle.map(distance).map(value => Math.abs(value) < epsilon ? 0 : value);
    if (distances.every(value => value <= 0) || distances.every(value => value > 0)) continue;
    const intersections = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const a = triangle[i];
      const b = triangle[j];
      if (distances[i] === 0) intersections.push(new Vector2(a[u], a[v]));
      if (distances[i] * distances[j] < 0) {
        const mix = distances[i] / (distances[i] - distances[j]);
        intersections.push(new Vector2(a[u] + (b[u] - a[u]) * mix, a[v] + (b[v] - a[v]) * mix));
      }
    }
    if (intersections.length !== 2) continue;
    const [a, b] = intersections.map(key);
    if (a === b) continue;
    vertices.set(a, intersections[0]);
    vertices.set(b, intersections[1]);
    const id = [a, b].sort().join('|');
    // An edge lying exactly in the plane cancels if both neighboring faces are retained.
    if (edges.has(id)) edges.delete(id);
    else edges.set(id, [a, b]);
  }

  const links = new Map();
  for (const [a, b] of edges.values()) {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b);
    links.get(b).push(a);
  }
  const contours = [];
  const seen = new Set();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const contour = [];
    let previous;
    let current = start;
    while (current && !seen.has(current) && links.get(current).length === 2) {
      seen.add(current);
      contour.push(vertices.get(current));
      const next = links.get(current).find(candidate => candidate !== previous);
      previous = current;
      current = next;
    }
    if (current === start && contour.length >= 3 && Math.abs(ShapeUtils.area(contour)) > epsilon ** 2) contours.push(contour);
  }

  const contains = (polygon, point) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const rings = contours.map(points => ({ points, area: Math.abs(ShapeUtils.area(points)), depth: 0 }));
  rings.sort((a, b) => b.area - a.area);
  rings.forEach((ring, i) => {
    ring.parent = rings.slice(0, i).findLast(candidate => contains(candidate.points, ring.points[0]));
    if (ring.parent) ring.depth = ring.parent.depth + 1;
  });
  const positions = [];
  const uv = [];
  for (const ring of rings.filter(candidate => candidate.depth % 2 === 0)) {
    const holes = rings.filter(candidate => candidate.parent === ring).map(candidate => candidate.points);
    const triangles = ShapeUtils.triangulateShape(ring.points, holes);
    const allPoints = [ring.points, ...holes].flat();
    for (const vertex of triangles.flat()) {
      const point = allPoints[vertex];
      const spatial = { [component]: offset, [u]: point.x, [v]: point.y };
      positions.push(spatial.x, spatial.y, spatial.z);
      uv.push(point.x / 4, point.y / 4);
    }
  }
  return { positions, uv };
}
