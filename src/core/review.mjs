export class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function requireValue(condition, message, status) {
  if (!condition) throw new ReviewError(message, status);
}

export const unitToMillimeters = Object.freeze({ um: 0.001, mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 });
export const formats = new Set(['stl', '3mf', 'glb']);
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function textField(value, label, max = 4000) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= max, `Invalid ${label}`);
  return value.trim();
}

export function identifier(value, label) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value), `Invalid ${label}`);
  return value;
}

export function vector(value, length, label) {
  requireValue(Array.isArray(value) && value.length === length && value.every(Number.isFinite), `Invalid ${label}`);
  return value;
}

export function manifest(input) {
  requireValue(Array.isArray(input?.parts) && input.parts.length && input.parts.length <= 250, 'The manifest must contain 1 to 250 parts');
  const ids = new Set();
  const parts = input.parts.map(part => {
    const id = identifier(part.id, 'Part ID');
    requireValue(!ids.has(id), 'Duplicate part ID');
    ids.add(id);
    requireValue(formats.has(part.format), 'Supported formats are STL, 3MF, and GLB');
    const units = part.units ?? (part.format === 'glb' ? 'm' : part.format === '3mf' ? 'embedded' : 'mm');
    const upAxis = part.upAxis ?? (part.format === 'glb' ? 'Y' : 'Z');
    requireValue(Object.hasOwn(unitToMillimeters, units) || (units === 'embedded' && part.format === '3mf'), 'Invalid unit');
    requireValue(['Y', 'Z'].includes(upAxis), 'Invalid up axis');
    const transform = vector(part.transform ?? identity, 16, 'Transform');
    const [a, b, c, , d, e, f, , g, h, i] = transform;
    const determinant = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
    requireValue(transform[3] === 0 && transform[7] === 0 && transform[11] === 0 && transform[15] === 1 && Number.isFinite(determinant) && Math.abs(determinant) > 1e-12, 'The transform must be affine and invertible');
    requireValue(/^[a-f0-9]{64}$/.test(part.asset ?? ''), 'Missing part asset');
    let group;
    if (part.group !== undefined) {
      requireValue(Array.isArray(part.group) && part.group.length <= 8, 'Group must be a path of up to 8 names');
      if (part.group.length) group = part.group.map(name => textField(name, 'Group name', 100));
    }
    return { id, label: textField(part.label ?? id, 'Name', 130), format: part.format, units, upAxis, transform, asset: part.asset, source: part.source ? textField(part.source, 'Source reference', 1000) : undefined, group };
  });
  return { parts };
}

export const maxCommentMarks = 12;

export function targetMarks(target) {
  return target?.kind === 'group' ? target.marks : target ? [target] : [];
}

function annotationTarget(target, hasPart) {
  requireValue(['assembly', 'part', 'point', 'region'].includes(target.kind), 'Invalid annotation type');
  const anchor = { kind: target.kind };
  if (target.kind === 'part' || target.kind === 'point') {
    requireValue(hasPart(target.partId), 'Unknown part');
    anchor.partId = target.partId;
  }
  if (target.kind === 'point') {
    anchor.point = vector(target.point, 3, 'Point');
    if (target.normal) anchor.normal = vector(target.normal, 3, 'Normal');
    if (target.surface !== undefined) {
      requireValue(target.surface === 'section', 'Invalid surface');
      anchor.surface = target.surface;
    }
  }
  if (target.kind === 'region') {
    requireValue(Array.isArray(target.outline) && target.outline.length === 4, 'Invalid region outline');
    requireValue(Array.isArray(target.parts) && target.parts.length > 0 && target.parts.length <= 81, 'Invalid parts in region');
    const ids = new Set();
    let total = 0;
    anchor.outline = target.outline.map(point => vector(point, 3, 'Region outline'));
    anchor.parts = target.parts.map(part => {
      requireValue(part && hasPart(part.partId) && !ids.has(part.partId), 'Invalid part in region');
      ids.add(part.partId);
      requireValue(Array.isArray(part.points) && part.points.length > 0, 'Invalid region samples');
      total += part.points.length;
      requireValue(total <= 81, 'Too many region samples');
      return { partId: part.partId, points: part.points.map(point => vector(point, 3, 'Region sample')) };
    });
  }
  return anchor;
}

export function annotation(input, model) {
  const target = input.target ?? { kind: 'assembly' };
  const hasPart = id => model.parts.some(part => part.id === id);
  let anchor;
  if (target.kind === 'group') {
    requireValue(Array.isArray(target.marks) && target.marks.length >= 2 && target.marks.length <= maxCommentMarks, 'Invalid number of marks');
    anchor = { kind: 'group', marks: target.marks.map(mark => {
      requireValue(mark?.kind === 'point' || mark?.kind === 'region', 'Only points and regions can be grouped');
      return annotationTarget(mark, hasPart);
    }) };
  } else {
    anchor = annotationTarget(target, hasPart);
  }
  let view;
  if (input.view) {
    const { position, center, projection, zoom, hidden, section } = input.view;
    requireValue(projection === 'orthographic' || projection === 'perspective', 'Invalid projection');
    requireValue(Number.isFinite(zoom) && zoom > 0, 'Invalid zoom');
    requireValue(Array.isArray(hidden) && hidden.every(id => model.parts.some(part => part.id === id)), 'Invalid hidden parts');
    view = { position: vector(position, 3, 'Camera'), center: vector(center, 3, 'Orbit target'), projection, zoom, hidden };
    if (input.view.frame !== undefined) {
      requireValue(Number.isFinite(input.view.frame) && input.view.frame > 0, 'Invalid camera scale');
      view.frame = input.view.frame;
    }
    if (section) {
      requireValue(['X', 'Y', 'Z'].includes(section.axis) && Number.isFinite(section.offset) && typeof section.flip === 'boolean', 'Invalid section plane');
      view.section = { axis: section.axis, offset: section.offset, flip: section.flip };
    }
  }
  let measurement;
  if (input.measurement) {
    const { a, b } = input.measurement;
    vector(a, 3, 'Start point');
    vector(b, 3, 'End point');
    measurement = { a, b, mm: Math.hypot(...a.map((n, index) => n - b[index])), method: 'mesh' };
  }
  return { text: textField(input.text, 'Comment'), target: anchor, view, measurement };
}

export function feedbackMarkdown(batch, baseUrl = '') {
  return [
    `# Review ${batch.id} · version ${batch.version}`,
    ...(batch.replaces ? [`This submission replaces review ${batch.replaces}.`, ...(batch.comments.length ? ['This list contains the complete revised feedback.'] : ['The user withdrew every comment from that submission.'])] : []),
    'Part-local coordinates are in millimeters, with Z up in the assembly frame. Dimensions are measured on the mesh.',
    ...batch.comments.map(comment => {
      const { target, measurement, capture, detailCapture, source, sources } = comment;
      const coords = point => `[${point.map(value => Number(value.toFixed(3))).join(', ')}] mm`;
      const regionLine = ({ partId, points }) => {
        const extent = fn => coords([0, 1, 2].map(i => fn(...points.map(point => point[i]))));
        const origin = sources?.find(item => item.partId === partId)?.source;
        return `${partId}: ${points.length} samples between ${extent(Math.min)} and ${extent(Math.max)}${origin ? ` · ${origin}` : ''}`;
      };
      const region = target.parts?.map(part => '- ' + regionLine(part));
      const pointLine = mark => `Local point${mark.surface === 'section' ? ' on the section plane' : ''}: ${coords(mark.point)}`;
      const grouped = target.kind === 'group' && target.marks.map((mark, i) => {
        if (mark.kind === 'region') return `${i + 1}. Region\n${mark.parts.map(part => '   - ' + regionLine(part)).join('\n')}`;
        const origin = sources?.find(item => item.partId === mark.partId)?.source;
        return `${i + 1}. ${mark.partId} · ${pointLine(mark)}${origin ? ` · ${origin}` : ''}`;
      });
      return [
        `## ${comment.id}${target.partId ? ` · ${target.partId}` : ''}`,
        comment.text,
        target.point && pointLine(target),
        region && `Region with part-local surface samples:\n${region.join('\n')}`,
        grouped && `Marks:\n${grouped.join('\n')}`,
        source && `Source: ${source}`,
        measurement && `Distance: ${measurement.mm.toFixed(3)} mm from A ${coords(measurement.a)} to B ${coords(measurement.b)} in assembly coordinates`,
        capture && `Capture: ${baseUrl}/assets/${capture}`,
        detailCapture && `Detail capture: ${baseUrl}/assets/${detailCapture}`
      ].filter(Boolean).join('\n');
    })
  ].join('\n\n');
}
