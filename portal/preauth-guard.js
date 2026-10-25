import express from 'express';

const NODE_ENV = String(process.env.NODE_ENV || 'production').toLowerCase();
const configuredBase = String(process.env.WPGO_PORTAL_PUBLIC_BASE || 'https://wpgo-commercial-web.onrender.com').replace(/\/$/, '');

function canonicalOrigin() {
  try {
    const u = new URL(configuredBase);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return '';
    return u.origin;
  } catch {
    return '';
  }
}

const portalOrigin = canonicalOrigin();
if (NODE_ENV === 'production' && !portalOrigin) {
  console.error(JSON.stringify({ event: 'startup_config_invalid', missing: ['WPGO_PORTAL_PUBLIC_BASE=https://...'] }));
  process.exit(1);
}

function reject(res) {
  res.status(403)
    .set('Cache-Control', 'no-store')
    .type('text/plain')
    .send('WPGo rejected this sign-in request. Reload the WPGo sign-in page and try again.');
}

function preAuthSameOrigin(req, res, next) {
  if (!portalOrigin && NODE_ENV !== 'production') return next();

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return reject(res);

  const origin = String(req.get('origin') || '').trim();
  const referer = String(req.get('referer') || '').trim();
  const candidate = origin || referer;
  if (!candidate) return reject(res);

  try {
    const actual = new URL(candidate).origin;
    if (actual !== portalOrigin) return reject(res);
  } catch {
    return reject(res);
  }
  next();
}

// This module is loaded with Node --import before app6.js. It injects a narrow
// same-origin guard only into the two unauthenticated sign-in POST endpoints.
// Authenticated account mutations continue to use the portal's HMAC CSRF token.
const originalPost = express.application.post;
express.application.post = function wpgoHardenedPost(path, ...handlers) {
  if (path === '/start/request-code' || path === '/start/verify-code') {
    return originalPost.call(this, path, preAuthSameOrigin, ...handlers);
  }
  return originalPost.call(this, path, ...handlers);
};
