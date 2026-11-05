// Minimal DOM "morphing": make an existing element look like new HTML by changing only what differs,
// instead of throwing the old nodes away. Elements stay in place, so there is no flicker, no replayed
// animations, no reloaded images, and focus, scroll position and typed text are kept.

const focused = (el) => el === document.activeElement;

function syncAttrs(o, n) {
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
}

/** Form controls keep state in properties, not attributes. Never overwrite a field someone is typing in. */
function syncField(o, n) {
  if (o.nodeName === 'INPUT') {
    if (o.type === 'checkbox' || o.type === 'radio') { if (o.checked !== n.checked) o.checked = n.checked; }
    else if (!focused(o) && o.value !== n.value) o.value = n.value;
  } else if (o.nodeName === 'TEXTAREA') {
    if (!focused(o) && o.value !== n.value) o.value = n.value;
  } else if (o.nodeName === 'SELECT') {
    if (o.value !== n.value) o.value = n.value;
  }
}

function syncNode(o, n) {
  if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { o.replaceWith(n.cloneNode(true)); return; }
  if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; } // text / comment
  syncAttrs(o, n);
  syncChildren(o, n);
  syncField(o, n);
}

function syncChildren(oldParent, newParent) {
  const oldKids = [...oldParent.childNodes];
  const newKids = [...newParent.childNodes];
  newKids.forEach((n, i) => { const o = oldKids[i]; if (o) syncNode(o, n); else oldParent.appendChild(n.cloneNode(true)); });
  for (let j = oldKids.length - 1; j >= newKids.length; j--) oldKids[j].remove();
}

/** Update `target`'s contents to match `html`. */
export function morph(target, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  syncChildren(target, tpl.content);
}
