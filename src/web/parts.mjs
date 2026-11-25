import { addIcon } from './icons.mjs';

const pathKey = path => JSON.stringify(path);
const branch = () => ({ groups: new Map(), entries: [], ids: [] });

function expandPartGroups(path = [], expanded) {
  path.forEach((_, index) => expanded.add(pathKey(path.slice(0, index + 1))));
}

export function partChanges(parts, previous) {
  const changes = new Map();
  if (!previous) return { changes, removed: 0 };
  const remaining = new Map(previous.map(part => [part.id, part]));
  for (const part of parts) {
    const before = remaining.get(part.id);
    if (!before) changes.set(part.id, 'Added');
    else if (before.asset !== part.asset || before.format !== part.format || before.units !== part.units || before.upAxis !== part.upAxis
      || JSON.stringify(before.transform) !== JSON.stringify(part.transform)) changes.set(part.id, 'Updated');
    remaining.delete(part.id);
  }
  return { changes, removed: remaining.size };
}

function groupParts(parts) {
  const root = branch();
  const byKey = new Map();
  for (const part of parts) {
    let node = root;
    const path = [];
    for (const name of part.group ?? []) {
      path.push(name);
      if (!node.groups.has(name)) {
        const group = { ...branch(), name, key: pathKey(path), path: [...path] };
        byKey.set(`group:${group.key}`, group);
        node.groups.set(name, group);
        node.entries.push(group);
      }
      node = node.groups.get(name);
      node.ids.push(part.id);
    }
    node.entries.push(part);
  }
  return { entries: root.entries, byKey };
}

function revealRow(list, row) {
  const viewport = list.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
  else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  if (item.left < viewport.left) list.scrollLeft += item.left - viewport.left;
  else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right;
}

function showLabel(button, label, change) {
  const text = document.createElement('span');
  text.className = 'part-label';
  text.textContent = label;
  button.replaceChildren(text);
  button.title = change ? `${label} · ${change}` : label;
  if (change) {
    const dot = document.createElement('span');
    dot.className = 'part-change-dot';
    dot.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-label', button.title);
    button.append(dot);
  }
}

function enableReorder(handle, row, list, onReorder) {
  let drag;
  let frame;
  let marker;
  const rows = () => [...list.children];
  const insertionIndex = (others, y) => others.findIndex(item => {
    const bounds = item.getBoundingClientRect();
    return y < bounds.top + bounds.height / 2;
  });

  function moveTo(index) {
    const order = rows();
    const current = order.indexOf(row);
    if (current < 0 || index < 0 || index >= order.length || index === current) return;
    order.splice(current, 1);
    order.splice(index, 0, row);
    onReorder(order.map(item => item.dataset.pinId));
    if (list.children[index]) revealRow(list, list.children[index]);
  }

  function clearDrag() {
    cancelAnimationFrame(frame);
    marker?.classList.remove('drop-before', 'drop-after');
    row.classList.remove('is-dragging');
    drag = undefined;
  }

  function updateDrag() {
    if (!row.isConnected) return clearDrag();
    const viewport = list.getBoundingClientRect();
    if (drag.y < viewport.top + 18) list.scrollTop -= 8;
    else if (drag.y > viewport.bottom - 18) list.scrollTop += 8;
    const others = rows().filter(item => item !== row);
    const next = insertionIndex(others, drag.y);
    marker?.classList.remove('drop-before', 'drop-after');
    marker = others[next] ?? others.at(-1);
    marker?.classList.add(next < 0 ? 'drop-after' : 'drop-before');
    frame = requestAnimationFrame(updateDrag);
  }

  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, start: event.clientY, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    drag.y = event.clientY;
    if (drag.started || Math.abs(drag.y - drag.start) < 4) return;
    drag.started = true;
    row.classList.add('is-dragging');
    updateDrag();
  });
  handle.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.id) return;
    const started = drag.started;
    clearDrag();
    const viewport = list.getBoundingClientRect();
    if (!started || event.clientX < viewport.left || event.clientX > viewport.right || event.clientY < viewport.top || event.clientY > viewport.bottom) return;
    const others = rows().filter(item => item !== row);
    const index = insertionIndex(others, event.clientY);
    moveTo(index < 0 ? others.length : index);
  });
  handle.addEventListener('lostpointercapture', clearDrag);
  handle.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) return clearDrag();
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveTo(rows().indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1));
  });
}

export function renderPartList(list, pinnedList, { parts, changes, selected, pinned, hidden, colors, expanded, revealId, revealGroup, revealInTree,
  button, changedList, onFocusChange, onSelect, onVisibility, onExpand, onPin, onReorder }) {
  const active = document.activeElement;
  const focused = list.contains(active) || pinnedList.contains(active) || changedList?.contains(active) ? active.dataset.control : undefined;
  const controls = new Map();
  const control = (element, key) => {
    element.dataset.control = key;
    controls.set(key, element);
    return element;
  };
  if (revealId && (revealInTree || !pinned.has(revealId))) expandPartGroups(parts.find(part => part.id === revealId)?.group, expanded);
  const tree = groupParts(parts);
  if (revealGroup) expandPartGroups(tree.byKey.get(`group:${revealGroup}`)?.path, expanded);

  const visibility = (label, ids, key) => {
    const visibleCount = ids.filter(id => !hidden.has(id)).length;
    const allVisible = visibleCount === ids.length;
    const name = `${allVisible ? 'Hide' : 'Show'} ${label}`;
    const element = control(button('', () => onVisibility(ids, allVisible)), key);
    element.className = 'visibility';
    element.classList.toggle('is-hidden', visibleCount === 0);
    element.classList.toggle('is-mixed', visibleCount > 0 && !allVisible);
    element.setAttribute('aria-label', name);
    element.title = name;
    return addIcon(element, visibleCount === 0 ? 'eyeOff' : 'eye');
  };
  const pinButton = (id, label, prefix) => {
    const isPinned = pinned.has(id);
    const pin = control(button('', () => onPin(id, !isPinned), isPinned), `${prefix}pin:${id}`);
    pin.className = 'part-pin';
    pin.setAttribute('aria-label', `Pin ${label}`);
    pin.title = `${isPinned ? 'Unpin' : 'Pin'} ${label}`;
    return addIcon(pin, 'pin');
  };
  const reorderHandle = (row, id, label, color) => {
    const handle = control(document.createElement('button'), `pinned:move:${id}`);
    handle.type = 'button';
    handle.className = 'part-grip';
    handle.setAttribute('aria-label', `Reorder ${label}`);
    handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    handle.title = 'Drag to reorder or use the arrow keys';
    enableReorder(handle, row, pinnedList, onReorder);
    if (color !== undefined) handle.style.setProperty('--part-color', `#${color.toString(16).padStart(6, '0')}`);
    row.append(addIcon(handle, 'grip'));
  };
  const partRow = (part, prefix = '', reorder = false) => {
    const { id, label } = part;
    const row = document.createElement('div');
    row.className = 'part';
    row.dataset.partId = id;
    row.dataset.pinId = id;
    const select = control(button(label, () => onSelect(id), prefix ? undefined : selected === id), `${prefix}part:${id}`);
    select.className = 'part-select';
    showLabel(select, label, prefix ? undefined : changes.get(id));
    const color = colors.get(id);
    if (color !== undefined) select.style.setProperty('--part-color', `#${color.toString(16).padStart(6, '0')}`);
    if (reorder) reorderHandle(row, id, label, color);
    else addIcon(select, 'cube');
    row.append(pinButton(id, label, prefix), select, visibility(label, [id], `${prefix}visibility:${id}`));
    return row;
  };
  const groupRow = (node, prefix = '', reorder = false) => {
    const head = document.createElement('div');
    head.className = 'part group-row';
    const id = `group:${node.key}`;
    head.dataset.pinId = id;
    const expand = control(button(node.name, () => onExpand(node.key, Boolean(prefix))), `${prefix}${id}`);
    expand.className = prefix ? 'part-select' : 'group-toggle';
    if (prefix) addIcon(expand, 'group');
    else expand.setAttribute('aria-expanded', String(expanded.has(node.key)));
    const count = prefix ? 0 : node.ids.filter(id => changes.has(id)).length;
    showLabel(expand, node.name, count ? `${count} changed ${count === 1 ? 'part' : 'parts'}` : undefined);
    if (reorder) reorderHandle(head, id, node.name);
    head.append(pinButton(id, node.name, prefix), expand, visibility(node.name, node.ids, `${prefix}group-visibility:${node.key}`));
    return head;
  };
  const entries = nodes => nodes.map(node => {
    if (!node.entries) return partRow(node);
    const row = document.createElement('div');
    row.className = 'part-group';
    row.append(groupRow(node));
    if (expanded.has(node.key)) {
      const children = document.createElement('div');
      children.className = 'group-children';
      children.append(...entries(node.entries));
      row.append(children);
    }
    return row;
  });
  const byId = new Map(parts.map(part => [part.id, part]));
  if (changedList) {
    const rows = [...changes.keys()].map(id => {
      const { label } = byId.get(id);
      const row = document.createElement('div');
      row.className = 'part change-row';
      const focus = control(button(label, () => onFocusChange(id)), `changed:part:${id}`);
      focus.className = 'quiet-button change-focus';
      focus.title = `Focus and select ${label}`;
      focus.setAttribute('aria-label', focus.title);
      row.append(pinButton(id, label, 'changed:'), focus);
      return row;
    });
    changedList.replaceChildren(...rows);
  }
  const visiblePins = [...pinned].filter(id => byId.has(id) || tree.byKey.has(id));
  const pinnedRows = visiblePins.map(id => byId.has(id) ? partRow(byId.get(id), 'pinned:', visiblePins.length > 1) : groupRow(tree.byKey.get(id), 'pinned:', visiblePins.length > 1));
  pinnedList.replaceChildren(...pinnedRows);
  pinnedList.parentElement.hidden = !pinnedRows.length;
  list.replaceChildren(...entries(tree.entries));
  if (focused) {
    const replacement = controls.get(focused) ?? controls.get(focused.replace(/^pinned:/, ''));
    (replacement ?? list).focus({ preventScroll: true });
  }
  if (revealGroup) {
    const row = controls.get(`group:${revealGroup}`)?.parentElement;
    if (row) revealRow(list, row);
  } else if (revealId) {
    const pinnedButton = !revealInTree && controls.get(`pinned:part:${revealId}`);
    const row = (pinnedButton ?? controls.get(`part:${revealId}`))?.parentElement;
    if (row) revealRow(pinnedButton ? pinnedList : list, row);
  }
}
