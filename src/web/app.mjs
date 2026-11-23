import { Viewport } from './viewport.mjs';
import { dimensionLabel as mm } from './markup.mjs';
import { commentCard, sentRound } from './feedback-list.mjs';
import { addIcon } from './icons.mjs';
import { maxCommentMarks, targetMarks } from '../core/review.mjs';
import { renderPartList } from './parts.mjs';

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
const expandedPartGroups = new Set();

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

function hasPendingMarks() { return !selectedComment && ['point', 'region', 'group'].includes(target.kind); }

function editingDraft() {
  return !reviewClosed() && Boolean($('comment').value.trim() || inlineEdit || hasPendingMarks());
}

function amendment() { return review?.amendments?.find(item => item.version === active)?.batch ?? null; }

function lastBatch() { return review?.batches.findLast(batch => batch.version === active); }

function reviewClosed() { return Boolean(lastBatch() && !amendment()); }

function draftsForVersion() {
  const revision = amendment();
  return review?.comments.filter(comment => comment.version === active && !comment.batch && (comment.revision ?? null) === revision) ?? [];
}

function updateComposer() {
  const typing = Boolean($('comment').value.trim());
  const correcting = Boolean(amendment());
  const closed = reviewClosed();
  const count = draftsForVersion().length;
  if (closed && mode) setMode(undefined);
  for (const id of ['pin', 'region', 'measure']) $(id).disabled = closed;
  $('comment-form').hidden = closed;
  $('closed-review').hidden = !closed;
  $('reopen-review').disabled = commentBusy;
  $('comment').readOnly = commentBusy;
  $('review-status').textContent = closed ? `v${active} · Closed` : correcting ? `v${active} · Reopened` : (count ? `${count} ${count === 1 ? 'comment ready' : 'comments ready'}` : 'Review open');
  $('comment-label').textContent = 'New comment';
  $('amendment-controls').hidden = !correcting;
  $('discard-amendment').disabled = commentBusy || Boolean(inlineEdit);
  $('add-comment').disabled = commentBusy || !typing;
  $('submit').hidden = closed;
  $('submit').textContent = correcting && !count ? 'Withdraw previous submission' : 'Submit review';
  const pending = hasPendingMarks();
  $('submit').disabled = closed || commentBusy || typing || pending || Boolean(inlineEdit) || (!count && !correcting);
  $('send-hint').hidden = closed || (!typing && !pending);
  $('send-hint').textContent = typing ? 'Add the comment you are writing before submitting.' : 'Add a comment for the marks or clear them before submitting.';
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

function targetLabel(mark) {
  const partName = id => currentVersion()?.model.parts.find(part => part.id === id)?.label ?? id;
  if (mark.kind === 'group') {
    const ids = new Set(mark.marks.flatMap(item => item.parts ? item.parts.map(part => part.partId) : [item.partId]));
    return `${mark.marks.length} marks · ${[...ids].map(partName).join(', ')}`;
  }
  if (mark.kind === 'region') return `Region · ${mark.parts.map(({ partId }) => partName(partId)).join(', ')}`;
  if (!mark.partId) return 'Entire assembly';
  if (mark.kind === 'point') return `${mark.surface === 'section' ? 'Point on section' : 'Point'} · ${partName(mark.partId)}`;
  return partName(mark.partId);
}

function updateMarker() {
  viewer?.setAnnotations(target, measurement, rulerStart);
  $('clear-target').hidden = target.kind === 'assembly' && !measurement && !rulerStart;
  $('undo-mark').hidden = target.kind !== 'group';
}

function setTarget(next) {
  target = next;
  const label = targetLabel(target);
  $('target').textContent = label;
  $('target').title = label;
  $('target').toggleAttribute('data-marked', target.kind !== 'assembly');
  updateMarker();
  updateComposer();
}

function appendMark(mark) {
  const marks = selectedComment ? [] : targetMarks(target).filter(item => item.kind === 'point' || item.kind === 'region');
  if (marks.length === maxCommentMarks) {
    status(`Add the comment before marking more than ${maxCommentMarks} locations.`);
    return;
  }
  selectedComment = undefined;
  setTarget(marks.length ? { kind: 'group', marks: [...marks, mark] } : mark);
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
  $('viewport').classList.toggle('picking', mode === 'point' || mode === 'measure');
  viewer.setRegionMode(mode === 'region');
  const hints = { point: 'Pick a point on the part', measure: 'Measure distance: select point A', region: 'Drag a box over visible surfaces. Isolate a part first to select only that part.' };
  $('tool-hint').textContent = hints[mode] ?? '';
  updateMarker();
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
      measurement = undefined;
      rulerStart = hit.world;
      $('tool-hint').textContent = 'Select point B';
      displayMeasurement();
      return;
    }
    measurement = { a: rulerStart, b: hit.world };
    setMode(undefined);
    displayMeasurement();
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
  $('measurement').textContent = measurement
    ? `Mesh distance · ${mm(Math.hypot(...measurement.a.map((n, i) => n - measurement.b[i])))}` : '';
  updateMarker();
}

function clearTarget() {
  selected = undefined;
  measurement = undefined;
  setMode(undefined);
  setTarget({ kind: 'assembly' });
  displayMeasurement();
  renderParts();
}

function resetForm() {
  $('comment').value = '';
  clearTarget();
  updateComposer();
}

function renderParts(reveal = false) {
  const parts = currentVersion()?.model.parts ?? [];
  $('show-all').hidden = !viewer.hidden.size;
  $('isolate-part').hidden = !selected;
  renderPartList($('parts'), {
    parts, selected, hidden: viewer.hidden, expanded: expandedPartGroups, reveal, button,
    onSelect: id => {
      selected = id;
      if (!reviewClosed() && (target.kind === 'part' || target.kind === 'assembly')) setTarget({ kind: 'part', partId: id });
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
    onExpand: key => {
      if (expandedPartGroups.has(key)) expandedPartGroups.delete(key);
      else expandedPartGroups.add(key);
      renderParts();
    }
  });
}

function setHidden(values) {
  viewer.setHidden(values);
  comparison?.setHidden(values);
  updateMarker();
  renderParts();
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
  if (await comparison.load(version.model, true)) {
    comparedVersion = number;
    comparison.restore(viewer.view());
    $('compare-version').value = String(number);
    $('compare').setAttribute('aria-pressed', 'true');
  }
}

function closeCompare() {
  comparison?.dispose();
  comparison = undefined;
  comparedVersion = undefined;
  $('comparison').hidden = true;
  $('compare').setAttribute('aria-pressed', 'false');
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
  $('agent-status').hidden = !review.agentListening;
  const editor = document.activeElement?.classList.contains('comment-edit') ? document.activeElement : undefined;
  const scroll = $('review-stream').scrollTop;
  const renderCard = comment => commentCard(comment, {
    label: targetLabel(comment.target), outcome: outcomes.get(comment.id), selected: selectedComment === comment.id,
    editor: inlineEdit?.id === comment.id ? inlineEdit : undefined, button,
    onSelect: () => {
      if (editingDraft() || commentBusy) throw new Error('Add or clear the current comment before opening a different annotation.');
      selectedComment = comment.id;
      showComment(comment);
      for (const card of $('comments').querySelectorAll('.comment-card')) {
        const current = card.dataset.commentId === selectedComment;
        card.classList.toggle('is-selected', current);
        card.querySelector('.comment-open').setAttribute('aria-pressed', String(current));
      }
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

async function reopenRound(batch) {
  if (!batch || !reviewClosed()) return;
  await writeComment(async () => {
    await api(`${endpoint}/amendments/${batch.id}`, {}, 'POST');
    resetForm();
    $('review-stream').scrollTop = 0;
    await loadReview();
  });
}

async function copyRound(batch) {
  const [feedback] = await api(`${endpoint}/feedback?batch=${batch.id}`);
  await navigator.clipboard.writeText(feedback.markdown);
  status('Review copied');
}

function showComment(comment) {
  setMode(undefined);
  viewer.restore(comment.view);
  comparison?.restore(viewer.view());
  selected = comment.target.partId;
  setTarget(comment.target);
  measurement = comment.measurement;
  syncSectionControls();
  displayMeasurement();
  renderParts(true);
}

async function openVersion(number) {
  const item = review.versions.find(version => version.number === number);
  if (!item) return;
  const token = ++activeRequest;
  modelLoading = true;
  try {
    if (!await viewer.load(item.model, Boolean(active)) || token !== activeRequest) return;
    active = number;
    inlineEdit = selectedComment = undefined;
    resetForm();
    $('active-view-label').textContent = `v${number}`;
    $('versions').value = String(number);
    $('dimensions').textContent = viewer.size().map(mm).join(' × ');
    if (comparedVersion === number) closeCompare();
    versionOptions();
    renderParts();
    renderFeedback();
    syncSectionControls();
  } finally {
    if (token === activeRequest) modelLoading = false;
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
  if (!active || (followLatest && active !== latest && !editingDraft() && !commentBusy)) await openVersion(latest);
  else {
    versionOptions();
    renderFeedback();
    if (followLatest && latest !== active) status(`v${latest} is available. Your draft is still on v${active}.`);
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
  $('versions').hidden = false;
  $('version-label').hidden = false;
  viewer = new Viewport($('viewport'), {
    onPick, onResize: updateMarker,
    onRegion: region => {
      if (modelLoading || commentBusy || reviewClosed()) return;
      if (!region) {
        $('tool-hint').textContent = 'Drag a box over a visible surface';
        return;
      }
      selected = region.parts.length === 1 ? region.parts[0].partId : undefined;
      appendMark(region);
      setMode(undefined);
      renderParts(Boolean(selected));
      focusComposer();
    },
    onCamera: view => { comparison?.restore(view, true); updateMarker(); }
  });
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
  $('show-all').addEventListener('click', () => setHidden([]));
  $('view').addEventListener('change', event => { if (active) viewer.fit(event.target.value); });
  $('fit').addEventListener('click', () => { if (active) viewer.fit($('view').value); });
  $('section').addEventListener('click', () => { if (active) applySection(viewer.section ? undefined : sectionAt($('axis').value)); });
  $('axis').addEventListener('change', event => applySection(sectionAt(event.target.value)));
  $('offset').addEventListener('input', event => applySection({ ...viewer.section, offset: Number(event.target.value) }));
  $('flip').addEventListener('change', event => applySection({ ...viewer.section, flip: event.target.checked }));
  $('pin').addEventListener('click', () => setMode(mode === 'point' ? undefined : 'point'));
  $('region').addEventListener('click', () => setMode(mode === 'region' ? undefined : 'region'));
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && mode) setMode(undefined); });
  $('measure').addEventListener('click', () => setMode(mode === 'measure' ? undefined : 'measure'));
  $('clear-target').addEventListener('click', clearTarget);
  $('isolate-part').addEventListener('click', () => {
    setHidden(currentVersion().model.parts.filter(part => part.id !== selected).map(part => part.id));
  });
  $('undo-mark').addEventListener('click', () => {
    if (target.kind !== 'group') return;
    const marks = target.marks.slice(0, -1);
    setTarget(marks.length === 1 ? marks[0] : { kind: 'group', marks });
  });
  $('comment').addEventListener('input', updateComposer);
  $('reopen-review').addEventListener('click', safe(() => reopenRound(lastBatch())));
  $('discard-amendment').addEventListener('click', safe(async () => {
    await writeComment(async () => {
      await api(`${endpoint}/amendments/${amendment()}`, undefined, 'DELETE');
      resetForm();
      await loadReview();
    });
  }));
  $('comment').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    if ($('comment').value.trim()) $('comment-form').requestSubmit();
  });
  $('comment-form').addEventListener('submit', safe(async event => {
    event.preventDefault();
    if (reviewClosed() || !$('comment').value.trim()) return;
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
      const revision = amendment();
      const key = JSON.stringify([active, revision, draftsForVersion().map(({ id, text }) => [id, text])]);
      if (pendingSubmission?.key !== key) pendingSubmission = { key, id: crypto.randomUUID() };
      await api(`${endpoint}/submit`, { version: active, revision, requestId: pendingSubmission.id }, 'POST');
      pendingSubmission = undefined;
      resetForm();
      $('review-stream').scrollTop = 0;
      await loadReview();
    });
  }));
  const events = new EventSource(`${endpoint}/events`);
  const refresh = safe(loadReview);
  events.addEventListener('ready', refresh);
  events.addEventListener('changed', refresh);
}

await safe(boot)();
