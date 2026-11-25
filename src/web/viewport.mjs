import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposePart, loadPart } from './model.mjs';
import { dimensionLabel, drawMark, drawMarkup } from './markup.mjs';
import { sectionTriangles } from './section.mjs';
import { captureDetail } from './detail.mjs';
import { maxPaintSamples, targetMarks } from '../core/review.mjs';
import { disposePaintLayer, erasePaint, paintLayer, updatePaintLayer } from './paint.mjs';
import { assignPartColors } from './part-colors.mjs';

const axes = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const directions = { iso: [1, -1.3, .9], front: [0, -1, 0], right: [1, 0, 0], top: [0, -.0001, 1] };
const presetDirections = Object.entries(directions).map(([name, coordinates]) => [name, new THREE.Vector3(...coordinates).normalize()]);
const presetTolerance = Math.cos(THREE.MathUtils.degToRad(.25));
const corners = (a, b) => [a, [b[0], a[1]], b, [a[0], b[1]]];

function cutMaterial() {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 48;
  const ctx = tile.getContext('2d');
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, 48, 48);
  ctx.strokeStyle = '#939393';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 48);
  ctx.lineTo(48, 0);
  ctx.moveTo(-2, 2);
  ctx.lineTo(2, -2);
  ctx.moveTo(46, 50);
  ctx.lineTo(50, 46);
  ctx.stroke();
  const map = new THREE.CanvasTexture(tile);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
}

export class Viewport {
  constructor(parent, { onPick = () => {}, onRegion = () => {}, onPaint = () => {}, onErase = () => {}, canErase = () => false, onCamera = () => {}, onResize = () => {} } = {}) {
    this.parent = parent;
    this.onCamera = onCamera;
    this.parts = new Map();
    this.partColors = new Map();
    this.bounds = new THREE.Box3();
    this.scene = new THREE.Scene();
    this.stage = new THREE.Group();
    this.caps = new THREE.Group();
    this.scene.background = new THREE.Color(0x101a23);
    this.scene.add(this.stage, new THREE.HemisphereLight(0xd8eaff, 0x28393e, 2.2));
    this.scene.add(this.caps);
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(2, -3, 5);
    this.scene.add(light);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.parent.append(this.renderer.domElement);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'markup-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    this.parent.append(this.overlay);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(100, -100, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => {
      this.render();
      if (!this.restoring) this.onCamera(this.view());
    });
    this.resize = new ResizeObserver(() => {
      this.render();
      onResize();
    });
    this.resize.observe(parent);
    this.hitTester = new THREE.Raycaster();
    const canvas = this.renderer.domElement;
    canvas.addEventListener('contextmenu', event => {
      if (this.dragMode === 'paint' || this.dragMode === 'erase') event.preventDefault();
    });
    let start;
    canvas.addEventListener('pointerdown', event => {
      start = event.button === 0 ? [event.clientX, event.clientY] : undefined;
    });
    canvas.addEventListener('pointerup', event => {
      if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) < 4) onPick(this.pick(event));
      start = undefined;
    });
    canvas.addEventListener('pointerdown', event => {
      if (!this.dragMode || this.drag || (event.button !== 0 && (event.button !== 2 || this.dragMode !== 'paint'))) return;
      event.stopImmediatePropagation();
      const erasing = event.button === 2 || this.dragMode === 'erase';
      if (erasing && !canErase()) return;
      canvas.setPointerCapture(event.pointerId);
      const cursor = this.cursor(event);
      this.drag = { pointerId: event.pointerId, start: cursor, end: cursor, mode: erasing ? 'erase' : this.dragMode, count: 0 };
      if (this.drag.mode !== 'region') {
        this.drag.radius = (erasing ? 13 : 9) * (this.camera.top - this.camera.bottom) / (this.camera.zoom * this.parent.clientHeight);
        if (erasing) {
          this.drag.marks = targetMarks(this.annotationTarget);
          this.drag.original = this.drag.marks;
          this.drag.direction = this.camera.getWorldDirection(new THREE.Vector3());
        } else this.drag.stroke = { kind: 'paint', radius: this.drag.radius, parts: [] };
        this.extendBrush(cursor, true);
      } else this.drawAnnotations();
    }, true);
    canvas.addEventListener('pointermove', event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      event.stopImmediatePropagation();
      const cursor = this.cursor(event);
      if (this.drag.mode !== 'region') this.extendBrush(cursor);
      else {
        this.drag.end = cursor;
        this.drawAnnotations();
      }
    }, true);
    const finishDrag = event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      event.stopImmediatePropagation();
      const drag = this.drag;
      this.drag = undefined;
      if (drag.mode !== 'region') {
        disposePaintLayer(this.paintPreview);
        this.paintPreview = undefined;
        if (this.paintMarks) this.paintMarks.visible = true;
        this.render();
        if (event.type === 'pointerup') {
          if (drag.mode === 'paint') onPaint(drag.count ? drag.stroke : undefined);
          else if (drag.original !== drag.marks) onErase(drag.marks);
        }
      } else {
        this.drawAnnotations();
        if (event.type === 'pointerup') onRegion(this.pickRegion(drag.start, this.cursor(event)));
      }
    };
    canvas.addEventListener('pointerup', finishDrag, true);
    canvas.addEventListener('pointercancel', finishDrag, true);
    canvas.addEventListener('lostpointercapture', finishDrag, true);
    this.frame = 100;
    this.hidden = new Set();
    this.generation = 0;
    this.lastSize = [];
    this.render();
  }

  async load(model, keepView = false, preferredColors = this.partColors) {
    const token = ++this.generation;
    const results = await Promise.allSettled(model.parts.map(loadPart));
    const ready = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const error = results.find(result => result.status === 'rejected');
    if (token !== this.generation || error) {
      ready.forEach(disposePart);
      if (token === this.generation) throw error.reason;
      return false;
    }
    this.parts.forEach(disposePart);
    this.parts.clear();
    this.stage.clear();
    for (const part of ready) {
      this.parts.set(part.userData.partId, part);
      this.stage.add(part);
    }
    this.stage.updateMatrixWorld(true);
    this.bounds.makeEmpty();
    const boxes = ready.flatMap(part => {
      const bounds = new THREE.Box3().setFromObject(part);
      if (bounds.isEmpty()) return [];
      this.bounds.union(bounds);
      return [{ id: part.userData.partId, min: bounds.min.toArray(), max: bounds.max.toArray() }];
    });
    if (this.bounds.isEmpty() || !this.bounds.min.toArray().every(Number.isFinite) || !this.bounds.max.toArray().every(Number.isFinite)) throw new Error('The model has no valid visible geometry.');
    this.partColors = assignPartColors(boxes, this.bounds.getSize(new THREE.Vector3()).length(), preferredColors);
    for (const part of ready) {
      const color = this.partColors.get(part.userData.partId);
      part.userData.color = color;
      if (color === undefined || ready.length < 2) continue;
      part.traverse(object => {
        if (!object.isMesh) return;
        for (const material of [object.material].flat()) {
          if (material.color && !material.map && !material.vertexColors) material.color.setHex(color);
        }
      });
    }
    this.setHidden(this.hidden);
    this.setSection(this.section);
    if (!keepView) this.fit();
    return true;
  }

  size() { return this.bounds.getSize(new THREE.Vector3()).toArray(); }

  viewPreset() {
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    return presetDirections.find(([, preset]) => direction.dot(preset) >= presetTolerance)?.[0] ?? 'custom';
  }

  fit(direction = 'iso', ids) {
    const visible = new THREE.Box3();
    for (const [id, part] of this.parts) if (ids ? ids.has(id) : part.visible) visible.expandByObject(part);
    const bounds = visible.isEmpty() ? this.bounds : visible;
    const span = bounds.getSize(new THREE.Vector3());
    const radius = span.length() / 2 || 1;
    const center = bounds.getCenter(new THREE.Vector3());
    this.frame = radius * 1.26;
    this.camera.near = Math.max(.00001, radius / 10000);
    this.camera.far = Math.max(10, radius * 100);
    this.camera.zoom = 1;
    const angle = direction ? new THREE.Vector3(...directions[direction]) : this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(angle.normalize().multiplyScalar(radius * 4));
    this.controls.update();
    this.render();
    this.onCamera(this.view());
  }

  render() {
    const width = this.parent.clientWidth;
    const height = this.parent.clientHeight;
    if (!width || !height) return;
    if (this.lastSize[0] !== width || this.lastSize[1] !== height) {
      this.renderer.setSize(width, height, false);
      this.lastSize = [width, height];
    }
    const ratio = width / height;
    const vertical = this.frame / Math.min(1, ratio);
    const horizontal = vertical * ratio;
    Object.assign(this.camera, { left: -horizontal, right: horizontal, top: vertical, bottom: -vertical });
    this.camera.updateProjectionMatrix();
    for (const layer of [this.paintMarks, this.paintPreview]) {
      if (layer) updatePaintLayer(layer, this.camera, height, this.plane ?? null, id => this.parts.get(id)?.visible);
    }
    this.renderer.render(this.scene, this.camera);
    this.drawAnnotations();
  }

  setHidden(values) {
    this.hidden = new Set(values);
    for (const [id, part] of this.parts) part.visible = !this.hidden.has(id);
    this.caps.children.forEach(cap => { cap.visible = !this.hidden.has(cap.userData.partId); });
    this.render();
  }

  setSection(section) {
    this.section = section;
    this.plane = section ? new THREE.Plane(new THREE.Vector3(...axes[section.axis]).multiplyScalar(section.flip ? -1 : 1), section.offset * (section.flip ? 1 : -1)) : null;
    this.stage.traverse(object => {
      if (object.isMesh) for (const material of [object.material].flat()) {
        material.clippingPlanes = this.plane ? [this.plane] : [];
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      }
    });
    cancelAnimationFrame(this.capFrame);
    this.capFrame = undefined;
    this.clearCaps();
    if (section) this.capFrame = requestAnimationFrame(() => {
      this.capFrame = undefined;
      this.buildCaps(section);
    });
    this.render();
  }

  clearCaps() {
    this.caps.children.forEach(cap => {
      cap.geometry.dispose();
      cap.material.dispose();
    });
    this.caps.clear();
  }

  buildCaps({ axis, offset, flip }) {
    const key = axis.toLowerCase();
    for (const [id, part] of this.parts) {
      const addCap = object => {
        if (!object.isMesh) return;
        const source = object.geometry;
        if (!source.boundingBox) source.computeBoundingBox();
        const bounds = source.boundingBox.clone().applyMatrix4(object.matrixWorld);
        if (offset <= bounds.min[key] || offset >= bounds.max[key]) return;
        const section = sectionTriangles(source, object.matrixWorld, axis, offset, flip);
        if (!section.positions.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(section.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(section.uv, 2));
        this.cutMaterial ??= cutMaterial();
        const material = this.cutMaterial.clone();
        material.color.setHex(this.partColors.get(id) ?? 0x8bd4c2);
        const cap = new THREE.Mesh(geometry, material);
        cap.userData.partId = id;
        cap.visible = part.visible;
        this.caps.add(cap);
      };
      part.children.forEach(child => child.traverseVisible(addCap));
    }
    this.render();
  }

  view() {
    return { position: this.camera.position.toArray(), center: this.controls.target.toArray(), projection: 'orthographic',
      zoom: this.camera.zoom, frame: this.frame, hidden: [...this.hidden], section: this.section };
  }

  restore(view, cameraOnly = false) {
    if (!view) return;
    this.restoring = true;
    try {
      this.camera.position.fromArray(view.position);
      this.camera.zoom = view.zoom;
      this.frame = view.frame ?? this.frame;
      const distance = this.camera.position.distanceTo(new THREE.Vector3(...view.center));
      this.camera.near = Math.max(.00001, distance / 100000);
      this.camera.far = Math.max(10, distance * 25);
      this.controls.target.fromArray(view.center);
      if (!cameraOnly) {
        this.setHidden(view.hidden ?? []);
        this.setSection(view.section);
      }
      this.controls.update();
      this.render();
    } finally { this.restoring = false; }
  }

  cursor(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  pick(event) { return this.pickAt(this.cursor(event)); }

  pickAt(cursor) {
    const pointer = new THREE.Vector2(cursor[0] * 2 - 1, 1 - cursor[1] * 2);
    this.hitTester.setFromCamera(pointer, this.camera);
    const candidates = this.hitTester.intersectObjects([...this.parts.values()].filter(part => part.visible), true);
    this.hitTester.intersectObjects(this.caps.children.filter(cap => cap.visible), false, candidates);
    for (const hit of candidates) {
      if (hit.object.parent === this.caps) {
        const partId = hit.object.userData.partId;
        const instance = this.parts.get(partId);
        const normal = this.plane.normal.clone().negate().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(instance.matrixWorld.clone().invert()));
        const world = this.plane.projectPoint(hit.point, new THREE.Vector3());
        return { partId, point: instance.worldToLocal(world.clone()).toArray(), world: world.toArray(), normal: normal.toArray(), surface: 'section' };
      }
      if (this.plane && this.plane.distanceToPoint(hit.point) < -1e-7) continue;
      let instance = hit.object;
      let visible = true;
      while (!instance.userData.partId && instance.parent) {
        visible &&= instance.visible;
        instance = instance.parent;
      }
      if (!visible || !instance.userData.partId) continue;
      const toLocalNormal = new THREE.Matrix3().getNormalMatrix(instance.matrixWorld.clone().invert().multiply(hit.object.matrixWorld));
      const normal = (hit.normal ?? hit.face?.normal)?.clone().applyNormalMatrix(toLocalNormal).toArray();
      const faceNormal = hit.face?.normal.clone().applyNormalMatrix(toLocalNormal).toArray();
      return { partId: instance.userData.partId, point: instance.worldToLocal(hit.point.clone()).toArray(), world: hit.point.toArray(), normal, faceNormal };
    }
  }

  setDragMode(mode) {
    this.dragMode = mode;
    this.parent.classList.toggle('drawing-region', Boolean(mode));
    this.drag = undefined;
    disposePaintLayer(this.paintPreview);
    this.paintPreview = undefined;
    if (this.paintMarks) this.paintMarks.visible = true;
    this.render();
  }

  extendBrush(cursor, first = false) {
    const { drag } = this;
    const distance = Math.hypot((cursor[0] - drag.end[0]) * this.parent.clientWidth, (cursor[1] - drag.end[1]) * this.parent.clientHeight);
    if (!first && distance < 6) return;
    const steps = Math.min(24, Math.max(1, Math.ceil(distance / 6)));
    const seen = drag.count;
    const hits = new Map();
    for (let i = 1; i <= steps && drag.count < maxPaintSamples; i++) {
      const position = cursor.map((value, axis) => THREE.MathUtils.lerp(drag.end[axis], value, i / steps));
      if (position.some(value => value < 0 || value > 1)) continue;
      const hit = this.pickAt(position);
      if (!hit) continue;
      drag.count++;
      if (drag.mode === 'erase') {
        if (!hits.has(hit.partId)) hits.set(hit.partId, []);
        hits.get(hit.partId).push(new THREE.Vector3(...hit.world));
        continue;
      }
      let part = drag.stroke.parts.find(item => item.partId === hit.partId);
      if (!part) {
        part = { partId: hit.partId, points: [] };
        drag.stroke.parts.push(part);
      }
      part.points.push(hit.point);
    }
    drag.end = cursor;
    if (drag.count === seen) return;
    if (drag.mode === 'erase') {
      const marks = erasePaint(drag.marks, hits, drag.radius, this.parts, this.plane, drag.direction);
      if (marks === drag.marks) return;
      drag.marks = marks;
      if (this.paintMarks) this.paintMarks.visible = false;
    }
    const previous = this.paintPreview;
    previous?.removeFromParent();
    this.paintPreview = paintLayer(drag.stroke ? [drag.stroke] : drag.marks, this.parts);
    this.scene.add(this.paintPreview);
    this.render();
    disposePaintLayer(previous);
  }

  pickRegion(start, end) {
    const clamp = value => THREE.MathUtils.clamp(value, 0, 1);
    const lower = end.map((value, i) => clamp(Math.min(value, start[i])));
    const upper = end.map((value, i) => clamp(Math.max(value, start[i])));
    if ((upper[0] - lower[0]) * this.parent.clientWidth < 8 || (upper[1] - lower[1]) * this.parent.clientHeight < 8) return;
    const samples = [];
    const byPart = new Map();
    const steps = 9;
    for (let y = 0; y < steps; y++) for (let x = 0; x < steps; x++) {
      const cursor = [x, y].map((value, i) => THREE.MathUtils.lerp(lower[i], upper[i], (value + .5) / steps));
      const hit = this.pickAt(cursor);
      if (!hit) continue;
      samples.push(new THREE.Vector3(...hit.world).project(this.camera).z);
      if (!byPart.has(hit.partId)) byPart.set(hit.partId, []);
      byPart.get(hit.partId).push(hit.point);
    }
    if (!samples.length) return;
    samples.sort((a, b) => a - b);
    const depth = samples[Math.floor(samples.length / 2)];
    const outline = corners(lower, upper).map(([x, y]) => new THREE.Vector3(x * 2 - 1, 1 - y * 2, depth).unproject(this.camera).toArray());
    return { kind: 'region', outline, parts: [...byPart].map(([partId, points]) => ({ partId, points })) };
  }

  setAnnotations(target, measurement, start) {
    const changed = target !== this.annotationTarget;
    this.annotationTarget = target;
    this.ruler = measurement ?? (start ? { a: start.world } : undefined);
    if (changed) {
      disposePaintLayer(this.paintMarks);
      this.paintMarks = paintLayer(targetMarks(target), this.parts);
      this.scene.add(this.paintMarks);
      this.render();
    } else this.drawAnnotations();
  }

  drawAnnotations() {
    const overlay = this.overlay;
    const source = this.renderer.domElement;
    if (overlay.width !== source.width || overlay.height !== source.height) {
      overlay.width = source.width;
      overlay.height = source.height;
    }
    const ctx = overlay.getContext('2d');
    const { clientWidth: width, clientHeight: height } = this.parent;
    if (!width || !height) return;
    ctx.setTransform(overlay.width / width, 0, 0, overlay.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const toPixel = ([x, y]) => [x * width, y * height];
    const project = world => toPixel(this.projectWorld(world));
    const marks = targetMarks(this.annotationTarget);
    marks.forEach((mark, index) => {
      const pin = this.projectPin(mark);
      const region = mark.kind === 'region' && mark.parts.some(({ partId }) => this.parts.get(partId)?.visible)
        ? mark.outline.map(point => project(new THREE.Vector3(...point)))
        : undefined;
      const regionBack = region && (region[1][0] - region[0][0]) * (region[3][1] - region[0][1])
        < (region[1][1] - region[0][1]) * (region[3][0] - region[0][0]);
      const labelPin = mark.kind === 'paint' && marks.length > 1 && mark.parts
        .map(({ partId, points }) => this.projectPin({ kind: 'point', partId, point: points[0] })).find(Boolean);
      drawMark(ctx, { point: pin && toPixel(pin), region, regionBack, labelAt: labelPin && toPixel(labelPin), label: marks.length > 1 ? index + 1 : undefined });
    });
    const { a, b } = this.ruler ?? {};
    const ruler = a && {
      a: project(new THREE.Vector3(...a)), b: b && project(new THREE.Vector3(...b)),
      text: b && dimensionLabel(Math.hypot(...a.map((value, i) => value - b[i])))
    };
    drawMarkup(ctx, { ruler, drag: this.drag?.mode === 'region' && corners(this.drag.start, this.drag.end).map(toPixel) });
  }

  capture() {
    if (this.capFrame !== undefined) {
      cancelAnimationFrame(this.capFrame);
      this.capFrame = undefined;
      this.buildCaps(this.section);
    }
    this.render();
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1100 / Math.max(source.width, source.height));
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.overlay, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  captureDetail(target, measurement) {
    const { renderer, camera, frame, parts, caps, plane } = this;
    try { return captureDetail({ renderer, camera, frame, parts, caps, plane, target, measurement }); }
    catch (error) { console.warn('Could not capture the detail view:', error); }
    finally { this.render(); }
  }

  projectWorld(world) {
    const projected = world.project(this.camera);
    return [(projected.x + 1) / 2, (1 - projected.y) / 2];
  }

  projectPin(target) {
    const instance = target?.kind === 'point' && this.parts.get(target.partId);
    if (!instance?.visible) return;
    const world = instance.localToWorld(new THREE.Vector3(...target.point));
    if (this.plane && this.plane.distanceToPoint(world) < -1e-7) return;
    const point = world.project(this.camera);
    if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return;
    return [(point.x + 1) / 2, (1 - point.y) / 2];
  }

  dispose() {
    this.generation++;
    this.resize.disconnect();
    this.controls.dispose();
    cancelAnimationFrame(this.capFrame);
    this.clearCaps();
    disposePaintLayer(this.paintMarks);
    disposePaintLayer(this.paintPreview);
    this.cutMaterial?.map.dispose();
    this.cutMaterial?.dispose();
    this.parts.forEach(disposePart);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}
