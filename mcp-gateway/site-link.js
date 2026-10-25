import crypto from 'node:crypto';
import { normalizeSite } from './security.js';

const SITE_TOKEN_PREFIX = 'wpgosite1';

function hmacKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

function signature(key, encodedSite) {
  return crypto.createHmac('sha256', key).update(`${SITE_TOKEN_PREFIX}.${encodedSite}`).digest('base64url');
}

function equal(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createSiteToken(site, secret) {
  const normalized = normalizeSite(site);
  if (!normalized) throw new Error('invalid_site_url');
  if (String(secret || '').length < 32) throw new Error('site_token_secret_too_short');
  const encodedSite = Buffer.from(normalized, 'utf8').toString('base64url');
  return `${SITE_TOKEN_PREFIX}.${encodedSite}.${signature(hmacKey(secret), encodedSite)}`;
}

export function readSiteToken(token, secret) {
  if (String(secret || '').length < 32) return '';
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== SITE_TOKEN_PREFIX) return '';
  const [, encodedSite, suppliedSignature] = parts;
  if (!encodedSite || encodedSite.length > 4096 || !suppliedSignature) return '';
  const expectedSignature = signature(hmacKey(secret), encodedSite);
  if (!equal(suppliedSignature, expectedSignature)) return '';
  try {
    const site = Buffer.from(encodedSite, 'base64url').toString('utf8');
    return normalizeSite(site);
  } catch {
    return '';
  }
}

export function siteTokenFromResource(resourceUrl, baseUrl, secret) {
  try {
    const resource = new URL(String(resourceUrl || ''));
    const base = new URL(String(baseUrl || ''));
    if (resource.origin !== base.origin) return '';
    const match = resource.pathname.match(/^\/mcp\/s\/([^/]+)$/);
    if (!match) return '';
    return readSiteToken(decodeURIComponent(match[1]), secret);
  } catch {
    return '';
  }
}

export function resourceForSite(baseUrl, site, secret) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return `${base}/mcp/s/${encodeURIComponent(createSiteToken(site, secret))}`;
}
