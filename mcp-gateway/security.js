const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
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

export function safeHttpsUrl(value, { allowLoopbackHttp = false } = {}) {
  const url = parseUrl(value);
  if (!url || hasUnsafeAuthority(url)) return null;
  if (url.protocol === 'https:') return url;
  if (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

export function normalizeSite(value) {
  const url = safeHttpsUrl(value);
  if (!url) return '';
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export function validRedirectUri(value) {
  const url = safeHttpsUrl(value, { allowLoopbackHttp: true });
  if (!url || url.hash) return false;
  return true;
}

export function validClientMetadataUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return false;
  if (url.search || url.hash) return false;
  if (url.pathname === '/' || !url.pathname) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) return false;
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
