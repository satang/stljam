import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { unitToMillimeters } from '../core/review.mjs';

const colors = [0x8bd4c2, 0x7ab7e2, 0xe3af72, 0xb9a1e5, 0xe68993, 0xa1be7a];
const modelCache = new Map();
const cacheLimit = 128 * 1024 * 1024;
let cacheSize = 0;

async function modelBytes(hash) {
  if (modelCache.has(hash)) return modelCache.get(hash);
  const response = await fetch(`/assets/${hash}`);
  if (!response.ok) throw new Error('Could not load model.');
  const bytes = await response.arrayBuffer();
  if (cacheSize + bytes.byteLength > cacheLimit) {
    modelCache.clear();
    cacheSize = 0;
  }
  if (!modelCache.has(hash)) {
    modelCache.set(hash, bytes);
    cacheSize += bytes.byteLength;
  }
  return bytes;
}

export function validateStl(buffer) {
  if (buffer.byteLength < 15) throw new Error('Empty or invalid STL.');
  const count = buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0;
  const binary = count > 0 && buffer.byteLength === 84 + count * 50;
  if (!binary && !new TextDecoder().decode(buffer.slice(0, 160)).trimStart().startsWith('solid')) throw new Error('Invalid STL.');
  if (binary && count > 2_000_000) throw new Error('The STL exceeds two million triangles.');
}

export function threeMFScale(buffer) {
  let expanded = 0;
  let entries = 0;
  const packageFiles = unzipSync(new Uint8Array(buffer), { filter: entry => {
    expanded += entry.originalSize;
    entries++;
    if (expanded > 192 * 1024 * 1024 || entries > 3000) throw new Error('The 3MF archive exceeds the import size limit.');
    return entry.name.toLowerCase().endsWith('.model') || entry.name === '_rels/.rels';
  } });
  const parser = new DOMParser();
  const relations = packageFiles['_rels/.rels'];
  const document = relations && parser.parseFromString(strFromU8(relations), 'application/xml');
  const rootRelation = document && [...document.querySelectorAll('Relationship')]
    .find(relation => relation.getAttribute('Type')?.endsWith('/3dmodel'));
  const modelPath = rootRelation?.getAttribute('Target')?.replace(/^\//, '');
  const model = packageFiles[modelPath] ?? Object.entries(packageFiles).find(([name]) => name.toLowerCase().endsWith('.model'))?.[1];
  if (!model) throw new Error('The 3MF contains no geometry.');
  const xml = parser.parseFromString(strFromU8(model), 'application/xml');
  const unit = xml.documentElement.getAttribute('unit') ?? 'millimeter';
  const values = { micron: 'um', millimeter: 'mm', centimeter: 'cm', meter: 'm', inch: 'in', foot: 'ft' };
  if (!values[unit]) throw new Error('Unknown 3MF units.');
  return unitToMillimeters[values[unit]];
}

export async function loadPart(part, index) {
  const buffer = await modelBytes(part.asset);
  let object;
  let scale = unitToMillimeters[part.units];
  if (part.format === 'stl') {
    validateStl(buffer);
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.attributes.position?.count) throw new Error('The STL contains no triangles.');
    if (geometry.attributes.normal.array.every(value => value === 0)) geometry.computeVertexNormals();
    object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colors[index % colors.length], roughness: .7 }));
  } else if (part.format === '3mf') {
    const embedded = threeMFScale(buffer);
    scale = part.units === 'embedded' ? embedded : scale;
    object = new ThreeMFLoader().parse(buffer);
  } else {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      if (url.startsWith('blob:') || url.startsWith('data:')) return url;
      throw new Error('The GLB must embed its resources.');
    });
    object = (await new GLTFLoader(manager).parseAsync(buffer, '')).scene;
  }
  const normalized = new THREE.Group();
  normalized.scale.setScalar(scale);
  if (part.upAxis === 'Y') normalized.rotation.x = Math.PI / 2;
  normalized.add(object);
  const instance = new THREE.Group();
  instance.matrix.fromArray(part.transform);
  instance.matrixAutoUpdate = false;
  instance.userData.partId = part.id;
  instance.add(normalized);
  return instance;
}

export function disposePart(instance) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  instance.traverse(object => {
    if (!object.isMesh) return;
    geometries.add(object.geometry);
    for (const material of [object.material].flat()) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach(item => item.dispose());
  materials.forEach(item => item.dispose());
  textures.forEach(item => item.dispose());
}
