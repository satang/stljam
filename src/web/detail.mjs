import * as THREE from 'three';
import { dimensionLabel, drawMark, drawMarkup } from './markup.mjs';
import { targetMarks } from '../core/review.mjs';

const palette = [0x79c8f4, 0xffb368, 0x91d6a0, 0xd0a4f4, 0xf08d9e, 0xebe080];
const vector = coordinates => new THREE.Vector3(...coordinates);

function detailCamera(camera, plane, points, aspect, frame) {
  const view = camera.clone();
  if (plane) {
    view.up.set(0, Math.abs(plane.normal.z) > .9 ? 1 : 0, Math.abs(plane.normal.z) > .9 ? 0 : 1);
    view.position.copy(plane.normal).multiplyScalar(-1);
    view.lookAt(0, 0, 0);
  }
  const inverse = view.quaternion.clone().invert();
  const bounds = new THREE.Box3().setFromPoints(points.map(point => point.clone().applyQuaternion(inverse)));
  const center = bounds.getCenter(new THREE.Vector3()).applyQuaternion(view.quaternion);
  const size = bounds.getSize(new THREE.Vector3());
  const halfHeight = Math.max(size.y, size.x / aspect, frame * .08) * .74;
  const distance = Math.max(camera.far / 4, size.z * 2, frame);
  view.position.copy(center).add(new THREE.Vector3(0, 0, distance).applyQuaternion(view.quaternion));
  Object.assign(view, {
    left: -halfHeight * aspect, right: halfHeight * aspect, top: halfHeight, bottom: -halfHeight,
    zoom: 1, near: .001, far: distance * 5
  });
  view.updateProjectionMatrix();
  view.updateMatrixWorld(true);
  return view;
}

export function captureDetail({ renderer, camera, frame, parts, caps, plane, target, measurement }) {
  const marks = targetMarks(target).map(mark => {
    const samples = mark.parts ?? (mark.partId ? [{ partId: mark.partId, points: mark.point ? [mark.point] : [] }] : []);
    const entries = samples.flatMap(({ partId, points }) => {
      const part = parts.get(partId);
      return part && (part.visible || target.kind === 'group')
        ? [{ part, points: points.map(point => part.localToWorld(vector(point))) }]
        : [];
    });
    return { kind: mark.kind, entries, points: entries.flatMap(entry => entry.points) };
  });
  const entries = marks.flatMap(mark => mark.entries);
  const points = marks.flatMap(mark => mark.points);
  for (const { part, points: samples } of entries) {
    if (samples.length) continue;
    const bounds = new THREE.Box3().setFromObject(part);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) {
      points.push(new THREE.Vector3(x, y, bounds.min.z), new THREE.Vector3(x, y, bounds.max.z));
    }
  }
  if (measurement?.b) points.push(vector(measurement.a), vector(measurement.b));
  if (!points.length) return undefined;

  const source = renderer.domElement;
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const shown = new Set(entries.map(entry => entry.part));
  if (!shown.size || measurement?.b) for (const part of parts.values()) if (part.visible) shown.add(part);
  const renderedParts = [...shown];
  const legend = renderedParts.slice(0, 8);
  const columns = Math.min(legend.length, canvas.width >= 480 ? 3 : 2);
  canvas.height = height + (columns ? Math.ceil(legend.length / columns) * 24 + 10 : 0);
  const ctx = canvas.getContext('2d');
  const view = detailCamera(camera, plane, points, source.width / source.height, frame);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x263747);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x70849b, 2.1));
  const light = new THREE.DirectionalLight(0xfff2dc, 2.1);
  light.position.set(-1, 2, 2).applyQuaternion(view.quaternion);
  scene.add(light);
  const resources = [];
  const edgeColor = 0x162431;
  const place = (object, geometry, material, clippingPlanes) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrix.copy(object.matrixWorld);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    const outline = new THREE.EdgesGeometry(geometry, 25);
    const line = new THREE.LineBasicMaterial({ color: edgeColor, opacity: .84, transparent: true, clippingPlanes });
    const edges = new THREE.LineSegments(outline, line);
    edges.matrix.copy(object.matrixWorld);
    edges.matrixAutoUpdate = false;
    scene.add(edges);
    resources.push(outline, line);
  };
  const swatches = renderedParts.map((part, i) => {
    const color = i < palette.length ? new THREE.Color(palette[i]) : new THREE.Color().setHSL((i * .618) % 1, .58, .65);
    const clippingPlanes = plane ? [plane] : [];
    const surface = new THREE.MeshStandardMaterial({
      color, roughness: .85, side: THREE.DoubleSide, clippingPlanes, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    });
    const section = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    resources.push(surface, section);
    for (const child of part.children) child.traverseVisible(object => {
      if (object.isMesh) place(object, object.geometry, surface, clippingPlanes);
    });
    for (const cap of caps.children) {
      if (cap.userData.partId === part.userData.partId) place(cap, cap.geometry, section, []);
    }
    return '#' + color.getHexString();
  });
  try {
    renderer.render(scene, view);
    ctx.drawImage(source, 0, 0, canvas.width, height);
  } finally {
    resources.forEach(resource => resource.dispose());
  }

  const project = point => {
    const { x, y } = point.clone().project(view);
    return [(x + 1) * canvas.width / 2, (1 - y) * height / 2];
  };
  marks.forEach((mark, index) => {
    if (!mark.points.length) return;
    const xy = mark.points.map(project);
    let region;
    if (mark.kind === 'region') {
      const x0 = Math.min(...xy.map(([x]) => x)) - 7;
      const y0 = Math.min(...xy.map(([, y]) => y)) - 7;
      const x1 = Math.max(...xy.map(([x]) => x)) + 7;
      const y1 = Math.max(...xy.map(([, y]) => y)) + 7;
      region = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    drawMark(ctx, { point: mark.kind === 'point' ? xy[0] : undefined, region, label: marks.length > 1 ? index + 1 : undefined });
  });
  const ruler = measurement?.b && {
    a: project(vector(measurement.a)), b: project(vector(measurement.b)),
    text: dimensionLabel(vector(measurement.a).distanceTo(vector(measurement.b)))
  };
  drawMarkup(ctx, { ruler });
  ctx.fillStyle = '#101a23';
  ctx.fillRect(0, height, canvas.width, canvas.height - height);
  ctx.font = '600 13px system-ui';
  legend.forEach((part, i) => {
    const cell = canvas.width / columns;
    const x = i % columns * cell + 10;
    const y = height + Math.floor(i / columns) * 24 + 8;
    ctx.fillStyle = swatches[i];
    ctx.fillRect(x, y, 12, 12);
    ctx.fillStyle = '#f4f8ff';
    ctx.fillText(part.userData.label, x + 19, y + 11, cell - 26);
  });
  return canvas.toDataURL('image/png');
}
