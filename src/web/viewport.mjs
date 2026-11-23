import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposePart, loadPart } from './model.mjs';
import { dimensionLabel, drawMarkup } from './markup.mjs';
import { sectionTriangles } from './section.mjs';

const axes = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const directions = { iso: [1, -1.3, .9], front: [0, -1, 0], right: [1, 0, 0], top: [0, -.0001, 1] };
const corners = (a, b) => [a, [b[0], a[1]], b, [a[0], b[1]]];

function cutMaterial() {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 48;
  const ctx = tile.getContext('2d');
  ctx.fillStyle = '#efad62';
  ctx.fillRect(0, 0, 48, 48);
  ctx.strokeStyle = '#b36e37';
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
  constructor(parent, { onPick = () => {}, onRegion = () => {}, onCamera = () => {}, onResize = () => {} } = {}) {
    this.parent = parent;
    this.onCamera = onCamera;
    this.parts = new Map();
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
    let start;
    canvas.addEventListener('pointerdown', event => {
      start = event.button === 0 ? [event.clientX, event.clientY] : undefined;
    });
    canvas.addEventListener('pointerup', event => {
      if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) < 4) onPick(this.pick(event));
      start = undefined;
    });
    canvas.addEventListener('pointerdown', event => {
      if (!this.regionMode || event.button !== 0 || this.drag) return;
      event.stopImmediatePropagation();
      canvas.setPointerCapture(event.pointerId);
      const cursor = this.cursor(event);
      this.drag = { pointerId: event.pointerId, start: cursor, end: cursor };
      this.drawAnnotations();
    }, true);
    canvas.addEventListener('pointermove', event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      event.stopImmediatePropagation();
      this.drag.end = this.cursor(event);
      this.drawAnnotations();
    }, true);
    const finishRegion = event => {
      if (this.drag?.pointerId !== event.pointerId) return;
      event.stopImmediatePropagation();
      const drag = this.drag;
      this.drag = undefined;
      this.drawAnnotations();
      if (event.type === 'pointerup') onRegion(this.pickRegion(drag.start, this.cursor(event)));
    };
    canvas.addEventListener('pointerup', finishRegion, true);
    canvas.addEventListener('pointercancel', finishRegion, true);
    canvas.addEventListener('lostpointercapture', finishRegion, true);
    this.frame = 100;
    this.hidden = new Set();
    this.generation = 0;
    this.lastSize = [];
    this.render();
  }

  async load(model, keepView = false) {
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
    this.bounds.setFromObject(this.stage);
    if (this.bounds.isEmpty() || !this.bounds.min.toArray().every(Number.isFinite) || !this.bounds.max.toArray().every(Number.isFinite)) throw new Error('The model has no valid visible geometry.');
    this.setHidden(this.hidden);
    this.setSection(this.section);
    if (!keepView) this.fit();
    return true;
  }

  size() { return this.bounds.getSize(new THREE.Vector3()).toArray(); }

  fit(direction = 'iso') {
    const visible = new THREE.Box3();
    for (const part of this.parts.values()) if (part.visible) visible.expandByObject(part);
    const bounds = visible.isEmpty() ? this.bounds : visible;
    const span = bounds.getSize(new THREE.Vector3());
    const radius = span.length() / 2 || 1;
    const center = bounds.getCenter(new THREE.Vector3());
    this.frame = radius * 1.26;
    this.camera.near = Math.max(.00001, radius / 10000);
    this.camera.far = Math.max(10, radius * 100);
    this.camera.zoom = 1;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(...directions[direction]).normalize().multiplyScalar(radius * 4));
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
    this.clearCaps();
    if (section) this.capFrame = requestAnimationFrame(() => this.buildCaps(section));
    this.render();
  }

  clearCaps() {
    this.caps.children.forEach(cap => cap.geometry.dispose());
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
        const cap = new THREE.Mesh(geometry, this.cutMaterial);
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
      const normal = hit.normal ?? hit.face?.normal;
      const localNormal = normal?.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(instance.matrixWorld.clone().invert()));
      return { partId: instance.userData.partId, point: instance.worldToLocal(hit.point.clone()).toArray(), world: hit.point.toArray(), normal: localNormal?.toArray() };
    }
  }

  setRegionMode(active) {
    this.regionMode = active;
    this.parent.classList.toggle('drawing-region', active);
    this.drag = undefined;
    this.drawAnnotations();
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
    this.annotationTarget = target;
    this.ruler = measurement ?? (start ? { a: start } : undefined);
    this.drawAnnotations();
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
    const target = this.annotationTarget;
    let region;
    if (target?.kind === 'region') {
      const samples = target.parts.flatMap(({ partId, points }) => points.flatMap(point => {
        const projected = this.projectPin({ kind: 'point', partId, point });
        return projected ? [toPixel(projected)] : [];
      }));
      if (samples.length) {
        const low = [0, 1].map(i => Math.min(...samples.map(point => point[i])) - 6);
        const high = [0, 1].map(i => Math.max(...samples.map(point => point[i])) + 6);
        region = corners(low, high);
      }
    }
    const { a, b } = this.ruler ?? {};
    const ruler = a && {
      a: project(new THREE.Vector3(...a)), b: b && project(new THREE.Vector3(...b)),
      text: b && dimensionLabel(Math.hypot(...a.map((value, i) => value - b[i])))
    };
    drawMarkup(ctx, { ruler, region, drag: this.drag && corners(this.drag.start, this.drag.end).map(toPixel) });
  }

  capture(target) {
    this.render();
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1100 / Math.max(source.width, source.height));
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.overlay, 0, 0, canvas.width, canvas.height);
    const pin = this.projectPin(target);
    if (pin) {
      const x = pin[0] * canvas.width;
      const y = pin[1] * canvas.height;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#9ce0cd';
      ctx.fill();
      ctx.strokeStyle = '#111a21';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    return canvas.toDataURL('image/png');
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
    this.cutMaterial?.map.dispose();
    this.cutMaterial?.dispose();
    this.parts.forEach(disposePart);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}
