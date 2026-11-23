import { addIcon } from './icons.mjs';

const pathKey = path => JSON.stringify(path);
const branch = () => ({ groups: new Map(), entries: [], ids: [] });

function groupParts(parts) {
  const root = branch();
  for (const part of parts) {
    let node = root;
    const path = [];
    for (const name of part.group ?? []) {
      path.push(name);
      if (!node.groups.has(name)) {
        const group = { ...branch(), name, key: pathKey(path) };
        node.groups.set(name, group);
        node.entries.push(group);
      }
      node = node.groups.get(name);
      node.ids.push(part.id);
    }
    node.entries.push(part);
  }
  return root.entries;
}

function revealRow(list, row) {
  const viewport = list.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
  else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  if (item.left < viewport.left) list.scrollLeft += item.left - viewport.left;
  else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right;
}

function showLabel(button, label) {
  const text = document.createElement('span');
  text.className = 'part-label';
  text.textContent = label;
  button.replaceChildren(text);
  button.title = label;
}

export function renderPartList(list, { parts, selected, hidden, expanded, reveal, button, onSelect, onVisibility, onExpand }) {
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.control : undefined;
  const controls = new Map();
  const control = (element, key) => {
    element.dataset.control = key;
    controls.set(key, element);
    return element;
  };
  if (reveal) {
    const path = parts.find(part => part.id === selected)?.group ?? [];
    path.forEach((_, i) => expanded.add(pathKey(path.slice(0, i + 1))));
  }

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
  const entries = nodes => nodes.map(node => {
    const row = document.createElement('div');
    if (!node.entries) {
      row.className = 'part';
      row.dataset.partId = node.id;
      const select = control(button(node.label, () => onSelect(node.id), selected === node.id), `part:${node.id}`);
      showLabel(select, node.label);
      row.append(addIcon(select, 'cube'), visibility(node.label, [node.id], `visibility:${node.id}`));
      return row;
    }
    row.className = 'part-group';
    const head = document.createElement('div');
    head.className = 'part group-row';
    const open = expanded.has(node.key);
    const expand = control(button(node.name, () => onExpand(node.key)), `group:${node.key}`);
    expand.className = 'group-toggle';
    expand.setAttribute('aria-expanded', String(open));
    showLabel(expand, node.name);
    head.append(expand, visibility(node.name, node.ids, `group-visibility:${node.key}`));
    row.append(head);
    if (open) {
      const children = document.createElement('div');
      children.className = 'group-children';
      children.append(...entries(node.entries));
      row.append(children);
    }
    return row;
  });
  list.replaceChildren(...entries(groupParts(parts)));
  if (focused) controls.get(focused)?.focus({ preventScroll: true });
  const selectedButton = reveal && controls.get(`part:${selected}`);
  if (selectedButton) revealRow(list, selectedButton.parentElement);
}
