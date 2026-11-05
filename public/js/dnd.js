// Drag and drop for tasks between lists, columns and sprints, and file drops for attachments.
//
// Markup contract:
//   draggable item:  data-drag-task="<taskId>" draggable="true"
//   drop zone:       data-drop="<field>:<value>"   e.g. statusId:abc, sprintId:null, assigneeId:xyz
//                    (a zone may carry several, separated by spaces)
//   file drop zone:  data-filedrop   (handled by DRAG.files)
import { task, saveTask, rankBetween, changed } from './store.js';
import { toast } from './ui.js';
import { DRAG } from './actions.js';

let dragId = null;

const clearMarks = () => {
  document.querySelectorAll('.drop-before, .drop-after').forEach((e) => e.classList.remove('drop-before', 'drop-after'));
  document.querySelectorAll('.over').forEach((e) => e.classList.remove('over'));
};
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

/** The item in `zone` that the cursor is above, so the dragged item is inserted before it. */
function beforeElement(zone, y) {
  const items = [...zone.querySelectorAll('[data-drag-task]')].filter((el) => el.dataset.dragTask !== dragId);
  return items.find((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
}

export function initDnd() {
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('[data-drag-task]');
    if (!el) return;
    dragId = el.dataset.dragTask;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    setTimeout(() => el.classList.add('dragging'), 0);
  });

  document.addEventListener('dragover', (e) => {
    if (hasFiles(e)) {
      const z = e.target.closest?.('[data-filedrop]');
      if (z) { e.preventDefault(); z.classList.add('dropping'); }
      return;
    }
    if (!dragId) return;
    const zone = e.target.closest?.('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    clearMarks();
    zone.classList.add('over');
    const before = beforeElement(zone, e.clientY);
    before?.classList.add('drop-before');
  });

  document.addEventListener('dragleave', (e) => {
    const z = e.target.closest?.('[data-filedrop]');
    if (z && !z.contains(e.relatedTarget)) z.classList.remove('dropping');
  });

  document.addEventListener('drop', async (e) => {
    if (hasFiles(e)) {
      const z = e.target.closest?.('[data-filedrop]');
      if (z) { e.preventDefault(); z.classList.remove('dropping'); DRAG[`files-${z.dataset.filedrop}`]?.(z, [...e.dataTransfer.files]); }
      return;
    }
    if (!dragId) return;
    const zone = e.target.closest?.('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    const id = dragId;
    const before = beforeElement(zone, e.clientY);
    const beforeId = before?.dataset.dragTask || null;
    // neighbours (excluding the dragged item) decide the new rank
    const ids = [...zone.querySelectorAll('[data-drag-task]')].map((el) => el.dataset.dragTask).filter((x) => x !== id);
    const at = beforeId ? ids.indexOf(beforeId) : ids.length;
    const prev = at > 0 ? task(ids[at - 1]) : null;
    const next = at < ids.length ? task(ids[at]) : null;
    const patch = { rank: rankBetween(prev?.rank, next?.rank) };
    for (const spec of zone.dataset.drop.split(' ')) {
      const [field, value] = spec.split(':');
      patch[field] = value === 'null' ? null : value;
    }
    clearMarks(); dragId = null;
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    try { await saveTask(id, patch); } catch (err) { if (err.status !== 409) toast(err.message, 'error'); else toast('That task was just changed by someone else', 'error'); }
    changed();
  });

  document.addEventListener('dragend', () => {
    clearMarks(); dragId = null;
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  });
}
