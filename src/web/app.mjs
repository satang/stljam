import { Viewport } from './viewport.mjs';
import { commentContext, dimensionLabel as mm, meshDistance } from './markup.mjs';
import { commentCard, sentRound } from './feedback-list.mjs';
import { addIcon } from './icons.mjs';
import { annotation, maxCommentMarks, targetMarks } from '../core/review.mjs';
import { partChanges, renderPartList } from './parts.mjs';

const $ = id => document.getElementById(id);
const projectId = location.pathname.split('/')[2];
const endpoint = `/api/projects/${projectId}`;
let review, active, viewer, comparison, comparedVersion;
let followLatest = true;
let modelLoading = false;
let target = { kind: 'assembly' };
let measurement, rulerStart, mode, selected;
let selectedComment, inlineEdit;
let commentBusy = false;
let pendingSubmission;
let activeRequest = 0;
let statusTimeout;
const markHistory = [];
const expandedPartGroups = new Set();
const storageKey = `stljam:view:${projectId}`;
const pinnedKey = `stljam:pinned:${projectId}`;
let pinnedParts = (projectId && readPinnedParts()) || new Set();
let partUndo = [];
let partRedo = [];
let beforeChangedView;
let saveTimer;

function localView(key, value) {
  try {
    if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
    else return JSON.parse(localStorage.getItem(key));
  } catch {
    // Reviews still work when browser storage is unavailable or full.
  }
}

function readPinnedParts() {
  const saved = localView(pinnedKey);
  if (Array.isArray(saved)) return new Set(saved.filter(id => typeof id === 'string'));
}

function setupPartsResize() {
  const grip = $('parts-resize');
  const panel = grip.parentElement;
  const feedback = document.querySelector('.feedback');
  const key = 'stljam:parts-width';
  const saved = localView(key);
  const min = 150;
  const max = 460;
  let drag;

  function maxWidth() {
    const room = innerWidth > 900 ? innerWidth - feedback.getBoundingClientRect().width - 320 : Infinity;
    return Math.floor(Math.min(max, innerWidth * .42, room));
  }
  function updateAria() {
    grip.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
    grip.setAttribute('aria-valuemax', String(maxWidth()));
  }
  function resize(width) {
    const next = Math.round(Math.max(min, Math.min(maxWidth(), width)));
    panel.parentElement.style.setProperty('--parts-width', `${next}px`);
    updateAria();
    return next;
  }
  if (typeof saved === 'number' && saved >= min && saved <= max) panel.parentElement.style.setProperty('--parts-width', `${saved}px`);
  grip.setAttribute('aria-valuemin', String(min));
  new ResizeObserver(updateAria).observe(panel);

  grip.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.id) drag.next = resize(drag.width + event.clientX - drag.x);
  });
  grip.addEventListener('lostpointercapture', () => {
    if (drag?.next !== undefined) localView(key, drag.next);
    drag = undefined;
  });
  grip.addEventListener('keydown', event => {
    const step = { ArrowLeft: -16, ArrowRight: 16, Home: -max, End: max }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    localView(key, resize(panel.getBoundingClientRect().width + step));
  });
}

function saveWorkspace() {
  clearTimeout(saveTimer);
  if (!active || modelLoading) return;
  localView(storageKey, { active, followLatest });
  localView(`${storageKey}:${active}`, {
    view: beforeChangedView ?? viewer.view(), selected, selectedComment, target, measurement,
    text: $('comment').value, revision: amendment(), comparedVersion,
    expanded: [...expandedPartGroups], preset: $('view').value, axis: $('axis').value
  });
}

function queueWorkspaceSave() {
  if (!active || modelLoading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspace, 180);
}

function restoreWorkspace(saved, model) {
  if (!saved) return;
  const canCompose = !reviewClosed() && saved.revision === amendment();
  selectedComment = review.comments.find(comment => comment.id === saved.selectedComment && comment.version === active)?.id;
  const viewOnly = !selectedComment && !canCompose;
  if (model.parts.some(part => part.id === saved.selected)) selected = saved.selected;
  for (const key of Array.isArray(saved.expanded) ? saved.expanded : []) if (typeof key === 'string') expandedPartGroups.add(key);
  if (['iso', 'top', 'front', 'right'].includes(saved.preset)) $('view').value = saved.preset;
  if (['X', 'Y', 'Z'].includes(saved.axis)) $('axis').value = saved.axis;
  if (canCompose && typeof saved.text === 'string') $('comment').value = saved.text.slice(0, 4000);
  try {
    const restored = annotation({
      text: 'Saved view', view: saved.view,
      target: viewOnly ? undefined : saved.target,
      measurement: viewOnly ? undefined : saved.measurement
    }, model);
    viewer.restore(restored.view);
    measurement = restored.measurement;
    setTarget(restored.target);
  } catch {
    // A saved view from a replaced local project may reference different geometry.
  }
}

function status(text) {
  clearTimeout(statusTimeout);
  $('status').textContent = text;
  if (text) statusTimeout = setTimeout(() => { $('status').textContent = ''; }, 5500);
}

async function api(route, body, method = 'GET') {
  const binary = body instanceof File;
  const response = await fetch(route, {
    method, headers: body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The operation could not be completed');
  return data;
}

function safe(action) {
  return async (...args) => {
    try { await action(...args); }
    catch (error) { status(error.message); }
  };
}

function button(label, action, pressed) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (pressed !== undefined) element.setAttribute('aria-pressed', String(pressed));
  element.addEventListener('click', safe(action));
  return element;
}

function option(number, suffix = '') {
  return new Option(`v${number}${suffix}`, String(number));
}

function isMark(target) { return ['point', 'region', 'paint', 'group'].includes(target?.kind); }

function hasPendingAnnotations() { return !selectedComment && Boolean(isMark(target) || measurement || rulerStart); }

function editingDraft() {
  return !reviewClosed() && Boolean($('comment').value.trim() || inlineEdit || hasPendingAnnotations());
}

function roundDraft() { return review?.amendments?.find(item => item.version === active); }

function amendment() { return roundDraft()?.batch ?? null; }

function lastBatch() { return review?.batches.findLast(batch => batch.version === active); }

function reviewClosed() { return Boolean(lastBatch() && !amendment()); }

function resumableBatch() {
  const batch = lastBatch();
  if (batch && !batch.deliveredAt && !amendment() && !review.agentListening && review.comments.some(comment => comment.batch === batch.id)) return batch;
}

function draftsForVersion() {
  const revision = amendment();
  return review?.comments.filter(comment => comment.version === active && !comment.batch && (comment.revision ?? null) === revision) ?? [];
}

function updateComposer() {
  const typing = Boolean($('comment').value.trim());
  const draft = roundDraft();
  const correcting = draft && !draft.additional;
  const closed = reviewClosed();
  const count = draftsForVersion().length;
  if (closed && mode) setMode(undefined);
  for (const id of ['pin', 'region', 'paint', 'measure']) $(id).disabled = closed;
  $('comment-form').hidden = closed;
  $('closed-review').hidden = !closed;
  const canResume = closed && Boolean(resumableBatch());
  $('resume-review').hidden = !canResume;
  $('copy-review-message').hidden = !canResume;
  $('add-more-feedback').classList.toggle('quiet-button', canResume);
  $('add-more-feedback').classList.toggle('accent-button', !canResume);
  $('reopen-review').disabled = commentBusy;
  $('add-more-feedback').disabled = commentBusy;
  $('comment').readOnly = commentBusy;
  $('review-status').textContent = closed ? `v${active} · Submitted` : draft ? `v${active} · ${correcting ? 'Correction draft' : 'Additional feedback'}` : (count ? `${count} ${count === 1 ? 'comment ready' : 'comments ready'}` : 'Review open');
  $('comment-label').textContent = 'New comment';
  $('review-controls').classList.toggle('draft-controls', Boolean(draft));
  $('discard-amendment').hidden = !draft;
  $('discard-amendment').textContent = correcting ? 'Discard correction' : 'Discard additional draft';
  $('discard-amendment').disabled = commentBusy;
  const latest = review?.versions.at(-1)?.number;
  const newer = draft && latest > active;
  $('newer-review').hidden = !newer;
  if (newer) {
    $('newer-review-hint').textContent = `v${latest} is available. Your draft stays on v${active}.`;
    $('open-latest-review').textContent = `Review v${latest}`;
  }
  $('open-latest-review').disabled = commentBusy || Boolean(inlineEdit);
  $('add-comment').disabled = commentBusy || !typing || Boolean(rulerStart);
  $('submit').hidden = closed;
  $('submit').textContent = correcting ? (count ? 'Send correction' : 'Withdraw previous submission') : draft ? 'Send additional feedback' : 'Submit review';
  const pending = hasPendingAnnotations();
  $('submit').disabled = closed || commentBusy || typing || pending || Boolean(inlineEdit) || (!count && !correcting);
  $('send-hint').hidden = closed || (!typing && !pending);
  $('send-hint').textContent = rulerStart ? 'Select point B or press Esc to cancel the measurement.'
    : typing ? 'Add the comment you are writing before submitting.' : 'Add a comment for the annotations or clear them before submitting.';
  queueWorkspaceSave();
}

function composeComment() {
  const view = viewer.view();
  const capture = viewer.capture();
  const detailCapture = viewer.captureDetail(target, measurement);
  return { version: active, revision: amendment(), text: $('comment').value, target, view, measurement, capture, detailCapture };
}

async function writeComment(action) {
  if (commentBusy || modelLoading || !active) return;
  commentBusy = true;
  updateComposer();
  try { await action(); }
  finally {
    commentBusy = false;
    updateComposer();
  }
}

function currentVersion() {
  return review?.versions.find(version => version.number === active);
}

const partName = id => currentVersion()?.model.parts.find(part => part.id === id)?.label ?? id;

function updateMarker() {
  viewer?.setAnnotations(target, measurement, rulerStart);
  $('clear-target').hidden = target.kind === 'assembly' && !measurement && !rulerStart;
  $('undo-mark').hidden = Boolean(selectedComment) || (!isMark(target) && !markHistory.length);
  $('erase-paint').disabled = mode !== 'erase' && !canErase();
  queueWorkspaceSave();
}

function setTarget(next) {
  target = next;
  displayMeasurement();
}

function selectComment(id) {
  selectedComment = id;
  for (const card of $('comments').querySelectorAll('.comment-card')) {
    const current = card.dataset.commentId === id;
    card.classList.toggle('is-selected', current);
    card.querySelector('.comment-open').setAttribute('aria-pressed', String(current));
  }
}

function appendMark(mark) {
  const marks = selectedComment ? [] : targetMarks(target).filter(item => ['point', 'region', 'paint'].includes(item.kind));
  if (marks.length === maxCommentMarks) {
    status(`Add the comment before marking more than ${maxCommentMarks} locations.`);
    return;
  }
  changeMarks([...marks, mark]);
}

function marksTarget(marks) {
  return marks.length > 1 ? { kind: 'group', marks } : marks[0] ?? { kind: 'assembly' };
}

function canErase() {
  return !selectedComment && !reviewClosed() && targetMarks(target).some(mark => mark.kind === 'paint');
}

function changeMarks(marks) {
  if (selectedComment) {
    markHistory.length = 0;
    measurement = undefined;
  }
  markHistory.push(selectedComment ? { kind: 'assembly' } : target);
  if (markHistory.length > 24) markHistory.shift();
  selectComment(undefined);
  setTarget(marksTarget(marks));
}

function focusComposer() {
  if (matchMedia('(pointer: fine)').matches && !inlineEdit) $('comment').focus({ preventScroll: true });
}

function setMode(next) {
  if (next && reviewClosed()) return;
  mode = next;
  rulerStart = undefined;
  $('pin').setAttribute('aria-pressed', String(mode === 'point'));
  $('measure').setAttribute('aria-pressed', String(mode === 'measure'));
  $('region').setAttribute('aria-pressed', String(mode === 'region'));
  $('paint').setAttribute('aria-pressed', String(mode === 'paint'));
  $('erase-paint').setAttribute('aria-pressed', String(mode === 'erase'));
  $('erase-paint').hidden = mode !== 'paint' && mode !== 'erase';
  $('viewport').classList.toggle('picking', mode === 'point' || mode === 'measure');
  viewer.setDragMode(['region', 'paint', 'erase'].includes(mode) ? mode : undefined);
  const hints = { point: 'Pick a point on the part', measure: 'Measure distance: select point A', region: 'Drag a box over visible surfaces. Isolate a part first to select only that part.', paint: 'Drag to paint. Right-drag to erase. Esc to orbit.', erase: 'Drag to erase. Esc to orbit.' };
  $('tool-hint').textContent = hints[mode] ?? '';
  displayMeasurement();
}

function onPick(hit) {
  if (!hit || modelLoading || commentBusy) return;
  if (reviewClosed()) {
    selected = hit.partId;
    renderParts(true);
    return;
  }
  if (mode === 'measure') {
    if (!rulerStart) {
      if (selectedComment) {
        selectComment(undefined);
        target = { kind: 'assembly' };
      }
      measurement = undefined;
      rulerStart = hit;
      $('tool-hint').textContent = 'Select point B';
      displayMeasurement();
      return;
    }
    const endpoint = ({ partId, point, faceNormal, normal, surface }) => ({ partId, point, normal: faceNormal ?? normal, surface: surface ?? 'mesh' });
    measurement = { a: rulerStart.world, b: hit.world, endpoints: { a: endpoint(rulerStart), b: endpoint(hit) } };
    setMode(undefined);
    return;
  }
  const marking = mode === 'point';
  selected = hit.partId;
  if (marking) appendMark({ kind: 'point', partId: hit.partId, point: hit.point, normal: hit.normal, surface: hit.surface });
  else if (target.kind === 'part' || target.kind === 'assembly') setTarget({ kind: 'part', partId: hit.partId });
  setMode(undefined);
  renderParts(true);
  if (marking) focusComposer();
}

function displayMeasurement() {
  const onSection = ['a', 'b'].filter(key => measurement?.endpoints?.[key].surface === 'section').map(key => key.toUpperCase());
  $('measurement').textContent = measurement
    ? `Mesh distance · ${mm(meshDistance(measurement))}${onSection.length ? ` · ${onSection.join(' and ')} on section fill` : ''}` : '';
  const label = commentContext(target, measurement, partName, rulerStart);
  $('target').textContent = label;
  $('target').title = label;
  $('target').toggleAttribute('data-marked', target.kind !== 'assembly' || Boolean(measurement || rulerStart));
  $('target').toggleAttribute('data-measurement', Boolean(measurement || rulerStart));
  updateMarker();
  updateComposer();
}

function markSurface(mark, hint) {
  if (modelLoading || commentBusy || reviewClosed()) return;
  if (!mark) {
    $('tool-hint').textContent = hint;
    return;
  }
  selected = mark.parts.length === 1 ? mark.parts[0].partId : undefined;
  appendMark(mark);
  if (mark.kind !== 'paint') setMode(undefined);
  renderParts(Boolean(selected));
  focusComposer();
}

function clearTarget() {
  markHistory.length = 0;
  selectComment(undefined);
  selected = undefined;
  measurement = undefined;
  setMode(undefined);
  setTarget({ kind: 'assembly' });
  renderParts();
}

function resetForm() {
  $('comment').value = '';
  clearTarget();
  updateComposer();
}

function changesFromPrevious(parts) {
  const previous = review?.versions.findLast(version => version.number < active);
  return { ...partChanges(parts, previous?.model.parts), since: previous?.number };
}

function selectPart(id) {
  selected = id;
  if (!reviewClosed() && (target.kind === 'part' || target.kind === 'assembly')) setTarget({ kind: 'part', partId: id });
}

function renderParts(reveal = false, { save = true, revealGroup, revealInTree = false } = {}) {
  const parts = currentVersion()?.model.parts ?? [];
  const { changes, removed, since } = changesFromPrevious(parts);
  const showChanges = $('show-changed-parts');
  showChanges.hidden = !changes.size;
  showChanges.textContent = beforeChangedView ? 'Restore previous view' : 'Isolate changed parts';
  showChanges.title = beforeChangedView ? 'Restore the camera, section and part visibility' : `Show ${changes.size} changed parts since v${since}`;
  showChanges.setAttribute('aria-expanded', String(Boolean(beforeChangedView)));
  addIcon(showChanges, beforeChangedView ? 'undo' : 'isolate');
  $('changed-parts').hidden = !beforeChangedView;
  $('parts-removed').hidden = !removed;
  $('parts-removed').textContent = removed ? `${removed} removed since v${since}` : '';
  $('undo-parts').disabled = !partUndo.length;
  $('redo-parts').disabled = !partRedo.length;
  const isolate = parts.some(part => part.id === selected);
  const hideParts = $('hide-parts');
  hideParts.textContent = isolate ? 'Isolate selection' : 'Hide all';
  hideParts.classList.toggle('isolate-action', isolate);
  addIcon(hideParts, isolate ? 'isolate' : 'eyeOff');
  hideParts.disabled = parts.every(({ id }) => viewer.hidden.has(id) === (id !== selected));
  $('show-all').hidden = !parts.some(({ id }) => viewer.hidden.has(id));
  renderPartList($('parts'), $('pinned-list'), {
    parts, changes, selected, pinned: pinnedParts, hidden: viewer.hidden, colors: viewer.partColors, expanded: expandedPartGroups,
    revealId: reveal ? selected : undefined, revealGroup, revealInTree, button,
    changedList: beforeChangedView ? $('changed-list') : undefined,
    onFocusChange: focusChangedPart,
    onSelect: id => {
      selectPart(id);
      renderParts();
    },
    onVisibility: (ids, hide) => {
      const hidden = new Set(viewer.hidden);
      for (const id of ids) {
        if (hide) hidden.add(id);
        else hidden.delete(id);
      }
      setHidden(hidden);
    },
    onExpand: (key, revealGroup) => {
      if (revealGroup) return renderParts(false, { revealGroup: key });
      if (expandedPartGroups.has(key)) expandedPartGroups.delete(key);
      else expandedPartGroups.add(key);
      renderParts();
    },
    onPin: (id, pin) => {
      pinnedParts = readPinnedParts() ?? pinnedParts;
      const next = new Set(pinnedParts);
      if (pin) next.add(id);
      else next.delete(id);
      changeParts('pins', next);
    },
    onReorder: ordered => {
      pinnedParts = readPinnedParts() ?? pinnedParts;
      const existing = ordered.filter(id => pinnedParts.has(id));
      const visible = new Set(existing);
      const reordered = existing.values();
      const updated = [...pinnedParts].map(id => visible.has(id) ? reordered.next().value : id);
      changeParts('pins', updated);
    }
  });
  if (save) queueWorkspaceSave();
}

function setHidden(values) {
  changeParts('visibility', values);
}

function changeParts(kind, values) {
  if (modelLoading) return;
  if (kind === 'visibility' && beforeChangedView) return applyPartChange(kind, values);
  const current = kind === 'pins' ? pinnedParts : viewer.hidden;
  const before = [...current];
  const after = [...values];
  if (before.length === after.length && after.every((id, index) => kind === 'pins' ? id === before[index] : current.has(id))) return;
  partUndo.push({ kind, before, after });
  if (partUndo.length > 40) partUndo.shift();
  partRedo = [];
  applyPartChange(kind, after);
}

function applyPartChange(kind, values) {
  if (kind === 'pins') {
    pinnedParts = new Set(values);
    localView(pinnedKey, values);
  } else {
    viewer.setHidden(values);
    comparison?.setHidden(values);
    updateMarker();
  }
  renderParts();
}

function stepPartHistory(from, to, state) {
  if (modelLoading || !from.length) return;
  const change = from.pop();
  to.push(change);
  if (change.kind === 'visibility') restoreChangedView();
  applyPartChange(change.kind, change[state]);
}

function restoreChangedView() {
  if (!beforeChangedView) return;
  const view = beforeChangedView;
  beforeChangedView = undefined;
  viewer.restore(view);
  comparison?.restore(view);
  syncSectionControls();
}

function focusChangedPart(id) {
  if (!beforeChangedView || modelLoading) return;
  if (viewer.hidden.has(id)) applyPartChange('visibility', [...viewer.hidden].filter(hidden => hidden !== id));
  selectPart(id);
  viewer.fit(null, new Set([id]));
  renderParts(true, { revealInTree: true });
}

function toggleChangedView() {
  if (!active || modelLoading) return;
  if (beforeChangedView) {
    restoreChangedView();
    updateMarker();
    renderParts(Boolean(selected), { revealInTree: true });
    return;
  }
  const { parts } = currentVersion().model;
  const { changes } = changesFromPrevious(parts);
  if (!changes.size) return;
  beforeChangedView = viewer.view();
  applySection(undefined);
  applyPartChange('visibility', parts.filter(part => !changes.has(part.id)).map(part => part.id));
  viewer.fit(null);
}

function discardPartHistory(kind) {
  partUndo = partUndo.filter(change => change.kind !== kind);
  partRedo = partRedo.filter(change => change.kind !== kind);
}

function syncSectionControls() {
  const section = viewer.section;
  $('section-controls').hidden = !section;
  $('section').setAttribute('aria-pressed', String(Boolean(section)));
  if (!section) return;
  $('axis').value = section.axis;
  const axis = section.axis.toLowerCase();
  const min = Math.min(viewer.bounds.min[axis], section.offset);
  const max = Math.max(viewer.bounds.max[axis], section.offset);
  Object.assign($('offset'), { min, max, step: Math.max(.00001, (max - min) / 500), value: section.offset });
  $('flip').checked = section.flip;
  $('offset-label').textContent = mm(section.offset);
}

function applySection(section) {
  viewer.setSection(section);
  comparison?.setSection(section);
  syncSectionControls();
  updateMarker();
}

function sectionAt(axis) {
  const key = axis.toLowerCase();
  const flip = viewer.camera.position[key] >= viewer.controls.target[key];
  return { axis, offset: (viewer.bounds.min[key] + viewer.bounds.max[key]) / 2, flip };
}

async function compare(number) {
  const version = review.versions.find(version => version.number === number);
  if (!version) return;
  $('comparison').hidden = false;
  comparison ??= new Viewport($('comparison'), { onCamera: view => { viewer.restore(view, true); updateMarker(); } });
  if (await comparison.load(version.model, true, viewer.partColors)) {
    comparedVersion = number;
    comparison.restore(viewer.view());
    $('compare-version').value = String(number);
    $('compare').setAttribute('aria-pressed', 'true');
    queueWorkspaceSave();
  }
}

function closeCompare() {
  comparison?.dispose();
  comparison = undefined;
  comparedVersion = undefined;
  $('comparison').hidden = true;
  $('compare').setAttribute('aria-pressed', 'false');
  queueWorkspaceSave();
}

function renderFeedback() {
  const version = currentVersion();
  if (!version) return;
  const relevant = review.comments.filter(comment => comment.version === active);
  const batches = review.batches.filter(batch => batch.version === active).reverse();
  const drafts = draftsForVersion();
  const closed = reviewClosed();
  const outcomes = new Map(review.versions.flatMap(item => item.outcomes.map(outcome => [outcome.commentId, { ...outcome, version: item.number }])));
  $('version-note').textContent = version.note;
  $('version-note').hidden = !version.note;
  const latest = review.versions.at(-1).number;
  const working = review.batches.some(batch => batch.workingOn === latest + 1);
  const agentStatus = working ? `Agent started work on v${latest + 1}` : review.agentListening ? 'Agent listening' : batches[0]?.deliveredAt ? 'Agent received feedback' : '';
  $('agent-status').textContent = agentStatus;
  $('agent-status').hidden = !agentStatus;
  const editor = document.activeElement?.classList.contains('comment-edit') ? document.activeElement : undefined;
  const scroll = $('review-stream').scrollTop;
  const renderCard = comment => commentCard(comment, {
    label: commentContext(comment.target, comment.measurement, partName), outcome: outcomes.get(comment.id), selected: selectedComment === comment.id,
    editor: inlineEdit?.id === comment.id ? inlineEdit : undefined, button,
    onSelect: () => {
      if (editingDraft() || commentBusy) throw new Error('Add or clear the current comment before opening a different annotation.');
      selectComment(comment.id);
      showComment(comment);
    },
    onEdit: startInlineEdit, onDelete: deleteDraft,
    onSave: () => finishInlineEdit(comment),
    onCancel: () => endInlineEdit(comment.id)
  });
  const rows = closed ? batches.map(batch => sentRound(batch, {
    comments: relevant.filter(comment => comment.batch === batch.id), renderCard,
    replacement: batches.find(item => item.replaces === batch.id), previous: batches.find(item => item.id === batch.replaces),
    button, onCopy: copyRound
  })) : drafts.map(renderCard);
  $('comments').replaceChildren(...rows);
  $('empty-comments').hidden = rows.length > 0;
  $('empty-comments').textContent = amendment() ? 'This review has no comments.' : 'Add a comment to start the review.';
  $('review-stream').scrollTop = scroll;
  const restoredEditor = editor && $('comments').querySelector('.comment-edit');
  if (restoredEditor) {
    restoredEditor.focus({ preventScroll: true });
    restoredEditor.setSelectionRange(editor.selectionStart, editor.selectionEnd);
  }
  updateComposer();
}

function draftElement(id, control) { return $('comments').querySelector(`[data-comment-id="${id}"] ${control}`); }

function startInlineEdit(comment) {
  if (inlineEdit || commentBusy) throw new Error('Finish editing the current comment.');
  inlineEdit = { id: comment.id, text: comment.text };
  renderFeedback();
  draftElement(comment.id, 'textarea')?.focus();
}

function endInlineEdit(id) {
  inlineEdit = undefined;
  renderFeedback();
  draftElement(id, '.comment-open')?.focus({ preventScroll: true });
}

async function finishInlineEdit(comment) {
  if (inlineEdit?.id !== comment.id || !inlineEdit.text.trim()) return;
  await writeComment(async () => {
    const { target, view, measurement, revision } = comment;
    await api(`${endpoint}/comments/${comment.id}`, { version: active, text: inlineEdit.text, target, view, measurement, revision }, 'PATCH');
    inlineEdit = undefined;
    await loadReview();
    draftElement(comment.id, '.comment-open')?.focus({ preventScroll: true });
  });
}

async function deleteDraft(comment) {
  await writeComment(async () => {
    await api(`${endpoint}/comments/${comment.id}`, undefined, 'DELETE');
    await loadReview();
  });
}

async function reopenRound(batch, additional = false) {
  if (!batch || !reviewClosed()) return;
  await writeComment(async () => {
    await api(`${endpoint}/amendments/${batch.id}`, { additional }, 'POST');
    resetForm();
    $('review-stream').scrollTop = 0;
    await loadReview();
  });
}

function confirmCorrection(version, latest, withdrawing) {
  const dialog = $('confirm-correction');
  const newer = latest > version;
  $('correction-hint').textContent = newer
    ? `v${latest} is available. This ${withdrawing ? 'withdrawal' : 'correction'} updates the feedback for v${version}. You can keep the draft and review v${latest} first.`
    : `The agent already received the original feedback. It may have started work before this ${withdrawing ? 'withdrawal' : 'correction'}.`;
  $('review-newer').hidden = !newer;
  $('review-newer').textContent = `Review v${latest}`;
  $('send-correction').textContent = `${withdrawing ? 'Withdraw feedback on' : 'Send correction for'} v${version}`;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

async function copyRound(batch) {
  const [feedback] = await api(`${endpoint}/feedback?batch=${batch.id}`);
  await navigator.clipboard.writeText(feedback.markdown);
  status('Review copied');
}

function showComment(comment) {
  restoreChangedView();
  discardPartHistory('visibility');
  markHistory.length = 0;
  setMode(undefined);
  viewer.restore(comment.view);
  comparison?.restore(viewer.view());
  selected = comment.target.partId;
  measurement = comment.measurement;
  setTarget(comment.target);
  syncSectionControls();
  renderParts(true);
}

async function openVersion(number) {
  const item = review.versions.find(version => version.number === number);
  if (!item) return;
  saveWorkspace();
  restoreChangedView();
  const saved = localView(`${storageKey}:${number}`);
  const token = ++activeRequest;
  modelLoading = true;
  try {
    if (!await viewer.load(item.model, Boolean(active)) || token !== activeRequest) return;
    if (active !== number) {
      partUndo = [];
      partRedo = [];
    }
    active = number;
    pinnedParts = readPinnedParts() ?? pinnedParts;
    inlineEdit = selectedComment = undefined;
    resetForm();
    restoreWorkspace(saved, item.model);
    $('active-view-label').textContent = `v${number}`;
    $('versions').value = String(number);
    $('dimensions').textContent = viewer.size().map(mm).join(' × ');
    if (comparedVersion === number) closeCompare();
    versionOptions();
    renderParts(Boolean(selected));
    renderFeedback();
    syncSectionControls();
    if (saved?.comparedVersion !== number && review.versions.some(version => version.number === saved?.comparedVersion)) await compare(saved.comparedVersion);
  } finally {
    if (token === activeRequest) {
      modelLoading = false;
      saveWorkspace();
    }
  }
}

function versionOptions() {
  const latest = review.versions.at(-1).number;
  const versions = [...review.versions].reverse();
  $('versions').replaceChildren(...versions.map(version => option(version.number, version.number === latest ? ' · latest' : '')));
  $('versions').value = String(active);
  $('compare-version').replaceChildren(...versions.filter(version => version.number !== active).map(version => option(version.number)));
  if (comparedVersion) $('compare-version').value = String(comparedVersion);
  $('compare').hidden = versions.length < 2;
}

async function loadReview() {
  review = await api(endpoint);
  $('project-title').textContent = review.title;
  const latest = review.versions.at(-1).number;
  if (!active) {
    const last = localView(storageKey);
    const draft = last && localView(`${storageKey}:${last.active}`);
    const keepDraft = review.amendments?.some(item => item.version === last?.active) || (draft && (draft.text || (!draft.selectedComment && (isMark(draft.target) || draft.measurement))));
    const number = (last?.followLatest === false || keepDraft) && review.versions.some(version => version.number === last.active) ? last.active : latest;
    followLatest = last?.followLatest !== false || number === latest;
    await openVersion(number);
  } else if (followLatest && active !== latest && !amendment() && !editingDraft() && !commentBusy) await openVersion(latest);
  else {
    versionOptions();
    renderFeedback();
    if (followLatest && latest !== active && !amendment() && editingDraft()) status(`v${latest} is available. Your draft is still on v${active}.`);
  }
}

async function showProjects() {
  const list = await api('/api/projects');
  const container = $('project-list');
  for (const project of list) {
    const link = document.createElement('a');
    link.className = 'project-card';
    link.href = `/review/${project.id}`;
    const version = document.createElement('small');
    version.textContent = `v${project.latest}`;
    link.append(document.createTextNode(project.title), version);
    container.append(link);
  }
  $('projects').hidden = false;
}

function openUpload() {
  const form = $('upload-form');
  form.reset();
  $('upload-heading').textContent = projectId ? 'Publish a version' : 'New project';
  $('note-label').hidden = !projectId;
  form.elements.title.value = review?.title ?? '';
  form.elements.title.readOnly = Boolean(projectId);
  $('upload-error').textContent = '';
  $('upload-dialog').showModal();
}

$('upload').addEventListener('click', openUpload);
$('cancel-upload').addEventListener('click', () => $('upload-dialog').close());
$('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const fields = new FormData(form);
    const files = fields.getAll('files');
    if (!files.length || files.length > 250) throw new Error('Select 1 to 250 files.');
    const parts = [];
    for (const file of files) {
      const format = file.name.split('.').at(-1).toLowerCase();
      if (!['stl', '3mf', 'glb'].includes(format)) throw new Error(`Unsupported format: ${file.name}`);
      const id = file.name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 83) || 'pieza';
      const safeId = parts.some(part => part.id === id) ? `${id}-${parts.length + 1}` : id;
      const uploaded = await api('/api/assets', file, 'POST');
      parts.push({ id: safeId, label: file.name, format, units: format === 'stl' ? fields.get('units') : undefined, asset: uploaded.hash });
    }
    const result = await api('/api/versions', {
      projectId: projectId ?? crypto.randomUUID(), title: fields.get('title'), model: { parts },
      baseVersion: review?.versions.at(-1).number ?? 0, requestId: crypto.randomUUID(), note: fields.get('note')
    }, 'POST');
    $('upload-dialog').close();
    if (!projectId) location.assign(result.url);
    else await loadReview();
  } catch (error) { $('upload-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

async function boot() {
  document.querySelectorAll('[data-icon]').forEach(element => addIcon(element, element.dataset.icon));
  $('upload').hidden = false;
  if (!projectId) return showProjects();
  $('review').hidden = false;
  setupPartsResize();
  $('versions').hidden = false;
  $('version-label').hidden = false;
  viewer = new Viewport($('viewport'), {
    onPick, onResize: updateMarker,
    onRegion: region => markSurface(region, 'Drag a box over a visible surface'),
    onPaint: paint => markSurface(paint, 'Drag the brush over a visible surface'),
    canErase,
    onErase: marks => { if (canErase()) changeMarks(marks); },
    onCamera: view => { comparison?.restore(view, true); updateMarker(); }
  });
  window.addEventListener('storage', event => {
    if (event.key !== pinnedKey && event.key !== null) return;
    pinnedParts = readPinnedParts() ?? new Set();
    discardPartHistory('pins');
    if (active && !modelLoading) renderParts(false, { save: false });
  });
  $('undo-parts').addEventListener('click', () => stepPartHistory(partUndo, partRedo, 'before'));
  $('redo-parts').addEventListener('click', () => stepPartHistory(partRedo, partUndo, 'after'));
  $('versions').addEventListener('change', safe(async event => {
    if (editingDraft() || commentBusy) {
      event.target.value = String(active);
      throw new Error('Add the current comment before switching versions.');
    }
    const number = Number(event.target.value);
    followLatest = number === review.versions.at(-1).number;
    await openVersion(number);
  }));
  $('compare').addEventListener('click', safe(() => comparedVersion
    ? closeCompare() : compare([...review.versions].reverse().find(version => version.number !== active).number)));
  $('compare-version').addEventListener('change', safe(event => compare(Number(event.target.value))));
  $('hide-parts').addEventListener('click', () => {
    if (modelLoading) return;
    setHidden(currentVersion().model.parts.filter(part => part.id !== selected).map(part => part.id));
  });
  $('show-all').addEventListener('click', () => setHidden([]));
  $('show-changed-parts').addEventListener('click', toggleChangedView);
  $('view').addEventListener('change', event => { if (active) viewer.fit(event.target.value); });
  $('fit').addEventListener('click', () => { if (active) viewer.fit($('view').value); });
  $('section').addEventListener('click', () => { if (active) applySection(viewer.section ? undefined : sectionAt($('axis').value)); });
  $('axis').addEventListener('change', event => applySection(sectionAt(event.target.value)));
  $('offset').addEventListener('input', event => applySection({ ...viewer.section, offset: Number(event.target.value) }));
  $('flip').addEventListener('change', event => applySection({ ...viewer.section, flip: event.target.checked }));
  $('pin').addEventListener('click', () => setMode(mode === 'point' ? undefined : 'point'));
  $('region').addEventListener('click', () => setMode(mode === 'region' ? undefined : 'region'));
  $('paint').addEventListener('click', () => setMode(mode === 'paint' ? undefined : 'paint'));
  $('erase-paint').addEventListener('click', () => setMode(mode === 'erase' ? 'paint' : 'erase'));
  window.addEventListener('pagehide', saveWorkspace);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && mode) setMode(undefined); });
  $('measure').addEventListener('click', () => setMode(mode === 'measure' ? undefined : 'measure'));
  $('clear-target').addEventListener('click', clearTarget);
  $('undo-mark').addEventListener('click', () => {
    if (selectedComment || reviewClosed()) return;
    setTarget(markHistory.pop() ?? marksTarget(targetMarks(target).slice(0, -1)));
  });
  $('comment').addEventListener('input', updateComposer);
  $('reopen-review').addEventListener('click', safe(() => reopenRound(lastBatch())));
  $('add-more-feedback').addEventListener('click', safe(() => reopenRound(lastBatch(), true)));
  $('open-latest-review').addEventListener('click', safe(async () => {
    if (commentBusy || inlineEdit) return;
    const latest = review.versions.at(-1).number;
    if (latest <= active) return;
    followLatest = true;
    await openVersion(latest);
  }));
  $('discard-amendment').addEventListener('click', safe(async () => {
    await writeComment(async () => {
      await api(`${endpoint}/amendments/${amendment()}`, undefined, 'DELETE');
      inlineEdit = undefined;
      resetForm();
      await loadReview();
      const latest = review.versions.at(-1).number;
      if (followLatest && active < latest) await openVersion(latest);
    });
  }));
  $('comment').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    if (!$('add-comment').disabled) $('comment-form').requestSubmit();
  });
  $('comment-form').addEventListener('submit', safe(async event => {
    event.preventDefault();
    if (reviewClosed() || rulerStart || !$('comment').value.trim()) return;
    await writeComment(async () => {
      const saved = await api(`${endpoint}/comments`, composeComment(), 'POST');
      resetForm();
      selectedComment = saved.id;
      await loadReview();
      draftElement(saved.id, '.comment-open')?.closest('.comment-card').scrollIntoView({ block: 'nearest', container: 'nearest' });
      $('comment').focus({ preventScroll: true });
    });
  }));
  $('submit').addEventListener('click', safe(async () => {
    if ($('submit').disabled || reviewClosed()) return;
    await writeComment(async () => {
      const version = active;
      const draft = roundDraft();
      const revision = draft?.batch ?? null;
      const comments = draftsForVersion();
      const latest = review.versions.at(-1).number;
      let confirmed = false;
      if (draft && !draft.additional && (lastBatch()?.deliveredAt || latest > version)) {
        const answer = await confirmCorrection(version, latest, !comments.length);
        if (answer === 'latest') {
          followLatest = true;
          await openVersion(review.versions.at(-1).number);
          return;
        }
        if (answer !== 'send' || revision !== amendment()) return;
        confirmed = true;
      }
      const key = JSON.stringify([version, revision, comments.map(({ id, text }) => [id, text])]);
      if (pendingSubmission?.key !== key) pendingSubmission = { key, id: crypto.randomUUID() };
      await api(`${endpoint}/submit`, { version, revision, requestId: pendingSubmission.id, confirmed }, 'POST');
      pendingSubmission = undefined;
      resetForm();
      $('review-stream').scrollTop = 0;
      await loadReview();
    });
  }));
  $('copy-review-message').addEventListener('click', safe(async () => {
    const batch = resumableBatch();
    if (!batch) return;
    const reference = JSON.stringify({ projectId, batchId: batch.id });
    await navigator.clipboard.writeText(`Please review my StlJam feedback on v${batch.version}. Use get_feedback with ${reference}.`);
    status('Message copied');
  }));
  const events = new EventSource(`${endpoint}/events`);
  const refresh = safe(loadReview);
  events.addEventListener('ready', refresh);
  events.addEventListener('changed', refresh);
}

await safe(boot)();
