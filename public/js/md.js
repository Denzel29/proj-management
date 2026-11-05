// A small, safe markdown renderer for descriptions, comments and pages.
// Everything is HTML-escaped first; only the syntax below is turned into tags.
import { esc, raw } from './ui.js';
import { user, taskByKey, S } from './store.js';

function safeUrl(u) {
  const t = u.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(t)) return t;
  return '#';
}

function inline(src) {
  const codes = [];
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });

  // @[Name](user:id) mentions
  s = s.replace(/@\[([^\]]+)\]\(user:([0-9a-f-]{36})\)/gi, (_, name, id) => {
    const u = user(id);
    return `<span class="mention${u && u.id === S.me?.id ? ' me' : ''}">@${u ? esc(u.name) : name}</span>`;
  });
  // images (only same-site uploads or https), then links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const u = url.replace(/&amp;/g, '&');
    return /^(https:\/\/|\/api\/attachments\/)/.test(u) ? `<img class="md-img" alt="${alt}" src="${esc(u)}" loading="lazy">` : alt;
  });
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const p = S.pages.find((x) => x.title.toLowerCase() === title.replace(/&amp;/g, '&').toLowerCase());
    return p ? `<a class="plink" href="#/pages/${p.id}">${p.icon} ${esc(p.title)}</a>` : `<span class="plink broken" title="No page with this name">${title}</span>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return `<a href="${esc(u)}" ${u.startsWith('#') ? '' : 'target="_blank" rel="noopener noreferrer"'}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // task references such as FORGE-12
  s = s.replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, (m, key) => {
    const t = taskByKey(key);
    return t ? `<a class="tref" href="#/task/${t.id}" title="${esc(t.title)}">${key}</a>` : m;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function renderList(items) {
  let html = '', stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const tag = it.ordered ? 'ol' : 'ul';
    if (!stack.length || it.indent > stack[stack.length - 1].indent) { html += `<${tag}${it.checked !== null ? ' class="tasks"' : ''}>`; stack.push({ indent: it.indent, tag }); }
    else html += '</li>';
    html += `<li>${it.checked !== null ? `<input type="checkbox" data-md-check="${it.idx}" ${it.checked ? 'checked' : ''}>` : ''}${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/** Render markdown to a Safe HTML value. Task-list checkboxes carry data-md-check="n" (nth checkbox in the source). */
export function renderMd(src = '') {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0, checkIdx = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // code fence
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { out.push(`<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { // blockquote
      const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(q.join('\n')).replace(/\n/g, '<br>')}</blockquote>`); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) { // table
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { // lists (nested by indentation, with task items)
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3]);
        items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: task ? task[2] : m[3], checked: task ? task[1] !== ' ' : null, idx: task ? checkIdx++ : -1 });
        i++;
      }
      out.push(renderList(items)); continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = []; // paragraph: until blank line or another block starts
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|\s*\|.*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return raw(`<div class="md">${out.join('')}</div>`);
}

/** Flip the nth task-list checkbox in markdown source. */
export function toggleCheckbox(src, n) {
  let count = -1;
  return src.split('\n').map((line) => {
    if (/^\s*([-*+]|\d+\.)\s+\[( |x|X)\]\s/.test(line)) {
      count++;
      if (count === n) return line.replace(/\[( |x|X)\]/, (m, c) => (c === ' ' ? '[x]' : '[ ]'));
    }
    return line;
  }).join('\n');
}
