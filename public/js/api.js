// Thin wrapper around fetch for the Forge API.
let unauthorizedHandler = () => {};
export const onUnauthorized = (fn) => { unauthorizedHandler = fn; };

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    if (res.status === 401 && !path.startsWith('/auth')) unauthorizedHandler();
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

/** Upload files to a task, page or comment. */
export async function upload(targetType, targetId, files) {
  const fd = new FormData();
  fd.append('targetType', targetType);
  fd.append('targetId', targetId);
  for (const f of files) fd.append('files', f, f.name);
  const res = await fetch('/api/attachments', { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || 'Upload failed'); e.status = res.status; throw e; }
  return data;
}
