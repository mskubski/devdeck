// DevDeck Web UI – zentraler API-Client + globaler Zustand.
export const state = { user: null, memberships: [] };

export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* leerer Body (z. B. 204) */ }
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body?.data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
export const del = (path, body) => api(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined });
