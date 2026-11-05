// Event registries. Views put data-act="name" on elements and register handlers here;
// main.js listens once on the document and dispatches. This keeps views as plain templates.
export const A = {};   // click:   data-act
export const C = {};   // change:  data-change
export const I = {};   // input:   data-input
export const K = {};   // Enter:   data-enter
export const DRAG = {}; // drag and drop handlers (see views that use them)

export function go(hash) { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; }
