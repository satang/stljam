const dateLabel = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' });

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function commentCard(comment, { label, outcome, selected, editor, button, onSelect, onEdit, onDelete, onSave, onCancel }) {
  const item = node('li', 'comment-card');
  item.dataset.commentId = comment.id;
  item.classList.toggle('is-selected', selected);
  const details = node('span', 'comment-content');
  details.append(node('small', 'comment-context', label), node('span', 'comment-text', comment.text));
  const jump = button('', () => onSelect(comment), selected);
  jump.className = 'comment-open';
  jump.title = comment.target.kind === 'region' ? 'Show region' : 'Show comment view';
  if (comment.capture) {
    const image = node('img', 'comment-preview');
    image.src = `/assets/${comment.capture}`;
    image.alt = '';
    image.loading = 'lazy';
    jump.append(image);
  }
  jump.append(details);
  item.append(jump);
  if (outcome) {
    const status = { applied: 'Applied', pending: 'Pending', 'needs-clarification': 'Needs clarification' }[outcome.status];
    item.append(node('small', 'comment-outcome', `${status} in v${outcome.version}${outcome.note ? ` · ${outcome.note}` : ''}`));
  }
  if (comment.batch) return item;

  const actions = node('div', 'comment-actions');
  if (editor) {
    const input = node('textarea', 'comment-edit');
    input.value = editor.text;
    input.rows = 3;
    input.maxLength = 4000;
    input.setAttribute('aria-label', 'Edit comment text');
    const apply = addIcon(button('Done', onSave), 'check');
    apply.disabled = !editor.text.trim();
    input.addEventListener('input', () => {
      editor.text = input.value;
      apply.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        apply.click();
      }
    });
    actions.append(button('Cancel', onCancel), apply);
    item.append(input, actions);
    return item;
  }
  const remove = addIcon(button('Delete', () => onDelete(comment)), 'delete');
  remove.classList.add('remove-button');
  actions.append(addIcon(button('Edit', () => onEdit(comment)), 'edit'), remove);
  item.append(actions);
  return item;
}

export function sentRound(batch, { comments, renderCard, replacement, previous, button, onCopy }) {
  const item = node('li', 'sent-round');
  const label = `Submitted ${dateLabel.format(new Date(batch.created))}`;
  const head = node('header', 'round-header');
  const title = node('div', 'round-title');
  title.append(node('strong', '', label));
  if (replacement) title.append(node('small', '', 'Replaced'));
  else if (batch.replaces) title.append(node('small', '', previous ? `Revises the submission from ${dateLabel.format(new Date(previous.created))}` : 'Revision'));
  head.append(title);

  const list = node('ol', 'round-comments');
  list.append(...comments.map(renderCard));
  if (replacement) {
    const history = node('details', 'round-history');
    history.append(node('summary', '', `View original · ${comments.length}`), list);
    item.append(head, history);
    return item;
  }

  const actions = node('div', 'round-actions');
  actions.append(addIcon(button('Copy', () => onCopy(batch)), 'copy'));
  item.append(head, actions, list);
  if (!comments.length) item.append(node('p', 'empty-round secondary', 'Comments withdrawn.'));
  return item;
}
import { addIcon } from './icons.mjs';
