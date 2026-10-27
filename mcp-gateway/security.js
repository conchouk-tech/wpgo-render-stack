const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function hasUnsafeAuthority(url) {
  return Boolean(url.username || url.password || url.hash);
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  return numbers[0] === 127 && numbers.every(part => part >= 0 && part <= 255);
}

export function safeHttpsUrl(value, { allowLoopbackHttp = false } = {}) {
  const url = parseUrl(value);
  if (!url || hasUnsafeAuthority(url)) return null;
  if (url.protocol === 'https:') return url;
  if (allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

export function normalizeSite(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return '';
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export function validRedirectUri(value) {
  return Boolean(safeHttpsUrl(value, { allowLoopbackHttp: true }));
}

export function validClientMetadataUrl(value) {
  const raw = String(value || '').trim();
  const url = safeHttpsUrl(raw);
  if (!url) return false;
  if (url.search || url.hash) return false;
  if (url.pathname === '/' || !url.pathname) return false;
  const rawPath = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
  if (/(^|\/)\.{1,2}(\/|$)/.test(rawPath)) return false;
  return true;
}

export function validPkceChallenge(value) {
  return PKCE_CHALLENGE_RE.test(String(value || ''));
}

export function validPkceVerifier(value) {
  return PKCE_VERIFIER_RE.test(String(value || ''));
}

export function normalizeScope(value) {
  const scopes = String(value || '')
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);
  if (!scopes.length) return ['mcp'];
  return [...new Set(scopes)];
}

export function scopesAreSupported(scopes) {
  return Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'mcp';
}
