import * as THREE from 'three';

// A depth-tested stamp centered on each surface hit. Its size is expressed in model units.
export function paintLayer(marks, parts) {
  const layer = new THREE.Group();
  for (const mark of marks) {
    if (mark.kind !== 'paint') continue;
    for (const { partId, points } of mark.parts) {
      const part = parts.get(partId);
      if (!part) continue;
      const geometry = new THREE.BufferGeometry();
      const positions = points.flatMap(point => part.localToWorld(new THREE.Vector3(...point)).toArray());
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: 0xff7bd7, sizeAttenuation: false, depthWrite: false, toneMapped: false });
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z -= 0.00002 * gl_Position.w;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;');
      };
      const stamps = new THREE.Points(geometry, material);
      stamps.userData = { partId, radius: mark.radius };
      stamps.renderOrder = 2;
      layer.add(stamps);
    }
  }
  return layer;
}

export function updatePaintLayer(layer, camera, height, plane, visible) {
  const pixelsPerUnit = height * camera.zoom / (camera.top - camera.bottom);
  for (const stamp of layer.children) {
    stamp.visible = visible(stamp.userData.partId);
    stamp.material.size = Math.min(128, Math.max(2, stamp.userData.radius * pixelsPerUnit * 2));
    if ((stamp.material.clippingPlanes?.[0] ?? null) !== plane) {
      stamp.material.clippingPlanes = plane ? [plane] : [];
      stamp.material.needsUpdate = true;
    }
  }
}

export function disposePaintLayer(layer) {
  if (!layer) return;
  layer.removeFromParent();
  for (const stamp of layer.children) {
    stamp.geometry.dispose();
    stamp.material.dispose();
  }
}

export function erasePaint(marks, hits, radius, parts, plane, direction) {
  if (!hits.size) return marks;
  let changed = false;
  const distanceSquared = radius ** 2;
  const depth = radius * .45;
  const difference = new THREE.Vector3();
  const result = marks.flatMap(mark => {
    if (mark.kind !== 'paint') return [mark];
    const remaining = mark.parts.flatMap(entry => {
      const centers = hits.get(entry.partId);
      if (!centers) return [entry];
      const part = parts.get(entry.partId);
      const points = entry.points.filter(point => {
        const world = part.localToWorld(new THREE.Vector3(...point));
        if (plane && plane.distanceToPoint(world) < -1e-7) return true;
        return !centers.some(center => {
          difference.subVectors(world, center);
          return difference.lengthSq() <= distanceSquared && Math.abs(difference.dot(direction)) <= depth;
        });
      });
      if (points.length !== entry.points.length) changed = true;
      return points.length ? [{ partId: entry.partId, points }] : [];
    });
    return remaining.length ? [{ ...mark, parts: remaining }] : [];
  });
  return changed ? result : marks;
}
