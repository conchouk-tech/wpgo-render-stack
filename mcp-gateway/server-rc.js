import express from 'express';
import crypto from 'node:crypto';
import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createAuthCodeStore } from './state-store.js';
import {
  normalizeScope,
  normalizeSite,
  safeHttpsUrl,
  scopesAreSupported,
  validClientMetadataUrl,
  validPkceChallenge,
  validPkceVerifier,
  validRedirectUri
} from './security.js';
import { createSiteToken, readSiteToken, resourceForSite, siteTokenFromResource } from './site-link.js';

const VERSION = '1.4.0-rc.1';
const PRODUCT_VERSION = '4.5.0-rc.1';
const port = Number(process.env.PORT || 8095);
const configuredBaseRaw = String(process.env.WPGO_MCP_PUBLIC_BASE || '').replace(/\/$/, '');
const configuredBaseUrl = configuredBaseRaw
  ? safeHttpsUrl(configuredBaseRaw, { allowLoopbackHttp: true })
  : null;
if (configuredBaseRaw && !configuredBaseUrl) {
  throw new Error('WPGO_MCP_PUBLIC_BASE must be HTTPS except for loopback development URLs.');
}
const configuredBase = configuredBaseUrl ? configuredBaseUrl.toString().replace(/\/$/, '') : '';
const rawSecret = String(process.env.WPGO_MCP_SECRET || '');
if (rawSecret.length < 32) throw new Error('WPGO_MCP_SECRET must be at least 32 characters.');
const key = crypto.createHash('sha256').update(rawSecret).digest();
const authCodes = await createAuthCodeStore();
const abilityCache = new Map();
const ABILITY_CACHE_TTL_MS = 60_000;
const ABILITY_CACHE_MAX_ENTRIES = 1000;

const BLOCKED_ABILITIES = new Set([
  'wpgo/onboarding-link', 'wpgo/create-fleet-task', 'wpgo/fleet-task-status',
  'wpgo/controller-onboarding-link', 'wpgo/controller-register-site', 'wpgo/controller-list-sites',
  'wpgo/controller-cleanup-local-credentials', 'wpgo/controller-remove-site', 'wpgo/controller-site-health',
  'wpgo/controller-command-read', 'wpgo/controller-read-ability', 'wpgo/controller-run-ability',
  'wpgo/controller-remote-approval-status', 'wpgo/controller-fleet-snapshot', 'wpgo/controller-dispatch',
  'wpgo/controller-run-status', 'wpgo/controller-list-runs'
]);

function baseUrl(req) {
  if (configuredBase) return configuredBase;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const candidate = safeHttpsUrl(`${proto}://${host}`, { allowLoopbackHttp: true });
  if (!candidate) throw new Error('Unable to determine a safe public WPGo base URL.');
  return candidate.toString().replace(/\/$/, '');
}

function legacyMcpUrl(req) {
  return `${baseUrl(req)}/mcp`;
}

function requestResource(req) {
  return `${baseUrl(req)}${req.path}`;
}

function resourceMetadataUrl(resource) {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

function validateResource(resource, issuer) {
  try {
    const url = new URL(String(resource || ''));
    const base = new URL(issuer);
    if (url.origin !== base.origin || url.search || url.hash) return null;
    if (url.pathname === '/mcp') return { resource: url.toString(), site: '' };
    const match = url.pathname.match(/^\/mcp\/s\/([^/]+)$/);
    if (!match) return null;
    const site = readSiteToken(decodeURIComponent(match[1]), rawSecret);
    if (!site) return null;
    return { resource: url.toString(), site };
  } catch {
    return null;
  }
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function seal(prefix, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  return `${prefix}.${b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))}`;
}

function unseal(prefix, token) {
  if (typeof token !== 'string' || !token.startsWith(`${prefix}.`)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length + 1), 'base64url');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function secureEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function page(res, { title, body, status = 200, formAction = "'self'", scriptNonce = '' }) {
  const scriptPolicy = scriptNonce ? `; script-src 'nonce-${scriptNonce}'` : '';
  return res.status(status).type('html').set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'${scriptPolicy}`
  }).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · WPGo</title><style>
  :root{--bg:#071016;--panel:#0d1a22;--text:#f5f8fa;--muted:#a7b6bf;--line:#24404d;--mint:#76e6bc;--blue:#8abaff;--danger:#ffb2b2}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#123344 0,transparent 32%),var(--bg);color:var(--text);font:16px/1.55 Arial,sans-serif;min-height:100vh}.wrap{max-width:720px;margin:7vh auto;padding:24px}.card{background:linear-gradient(180deg,var(--panel),#09151c);border:1px solid var(--line);border-radius:20px;padding:30px;box-shadow:0 18px 50px #0005}h1{font-size:34px;line-height:1.1;margin:0 0 12px}.muted{color:var(--muted)}.tag{display:inline-block;border:1px solid #2b5260;border-radius:999px;padding:5px 10px;color:var(--mint);font-size:13px;font-weight:700;margin-bottom:18px}.steps{display:flex;gap:7px;margin:22px 0}.step{flex:1;padding:8px;border-radius:10px;background:#0b2029;color:var(--muted);font-size:12px;text-align:center}.step.on{color:#06130e;background:var(--mint);font-weight:800}.btn{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--mint),#a8f4d7);color:#06130e;font-weight:800;border:0;border-radius:11px;padding:12px 18px;cursor:pointer;text-decoration:none}.btn.secondary{background:#102630;color:var(--text);border:1px solid var(--line)}input,select{width:100%;padding:13px;border:1px solid var(--line);border-radius:10px;background:#061016;color:var(--text);font-size:15px}.row{display:flex;gap:10px}.row>*{flex:1}.provider{border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0;background:#091820}.provider strong{display:block;margin-bottom:4px}.code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:#040b0f;border:1px solid var(--line);padding:12px;border-radius:10px;word-break:break-all}.ok{color:var(--mint)}.bad{color:var(--danger)}.small{font-size:13px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}@media(max-width:600px){.wrap{margin:2vh auto;padding:14px}.card{padding:22px}.row{display:block}.steps{display:grid;grid-template-columns:1fr 1fr}}
  </style></head><body><main class="wrap"><section class="card">${body}</section></main></body></html>`);
}

function errorPage(res, req, title, message, status = 400, code = 'connection_error') {
  return page(res, {
    title,
    status,
    body: `<span class="tag">WPGo ${esc(PRODUCT_VERSION)}</span><h1>${esc(title)}</h1><p class="muted">${esc(message)}</p><p class="small">Error code: <strong>${esc(code)}</strong><br>Request ID: <strong>${esc(req.id || '')}</strong></p><div class="actions"><a class="btn secondary" href="javascript:history.back()">Go back</a></div>`
  });
}

function oauthErrorRedirect(redirectUri, issuer, error, description, state = '') {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

function authorizationRedirect(redirectUri, issuer, code, state = '') {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, headers: response.headers, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function wordpressIndex(site) {
  return fetchJson(new URL('wp-json/', site).toString(), {
    headers: { Accept: 'application/json', 'User-Agent': `WPGo-MCP/${VERSION}` }
  });
}

async function inspectWordPress(site) {
  const normalized = normalizeSite(site);
  if (!normalized) return { ready: false, code: 'invalid_site_url', message: 'Use the HTTPS address of the WordPress site.' };
  let index;
  try {
    index = await wordpressIndex(normalized);
  } catch (error) {
    return { ready: false, site: normalized, code: 'wordpress_unreachable', message: 'WPGo could not reach the WordPress REST API.', detail: String(error?.name || 'network_error') };
  }
  if (!index.ok || !index.data || typeof index.data !== 'object') {
    return { ready: false, site: normalized, code: 'wordpress_rest_unavailable', message: `WordPress REST API returned HTTP ${index.status || 0}.` };
  }
  const routes = index.data.routes || {};
  const hasWpgo = Object.keys(routes).some(route => route.startsWith('/wpgo/v1'));
  const hasApprovalProxy = Object.keys(routes).some(route => route.includes('/wpgo/v1/abilities/run'));
  const authEndpoint = safeHttpsUrl(index.data?.authentication?.['application-passwords']?.endpoints?.authorization);
  const sameOriginAuth = authEndpoint && authEndpoint.origin === new URL(normalized).origin;
  const result = {
    ready: Boolean(hasWpgo && hasApprovalProxy && sameOriginAuth),
    site: normalized,
    site_name: String(index.data.name || new URL(normalized).hostname).slice(0, 160),
    wordpress: true,
    wpgo: hasWpgo,
    approval_proxy: hasApprovalProxy,
    application_passwords: Boolean(sameOriginAuth),
    auth_endpoint: sameOriginAuth ? authEndpoint.toString() : ''
  };
  if (!hasWpgo) return { ...result, code: 'wpgo_not_detected', message: 'WPGo is not installed or its REST API is not available.' };
  if (!hasApprovalProxy) return { ...result, code: 'wpgo_update_required', message: 'This WPGo installation must be updated before AI write actions can be safely connected.' };
  if (!sameOriginAuth) return { ...result, code: 'application_passwords_unavailable', message: 'WordPress Application Password authorization is not available on this site.' };
  return result;
}

function registeredClientFromToken(clientId, redirectUri, issuer) {
  const client = unseal('wpgoclient1', clientId);
  if (!client || client.issuer !== issuer) return null;
  return Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri) ? client : null;
}

async function clientFromMetadataDocument(clientId, redirectUri) {
  if (!validClientMetadataUrl(clientId)) return null;
  const response = await fetchJson(clientId, {
    headers: { Accept: 'application/json', 'User-Agent': `WPGo-MCP/${VERSION}` }
  }, 8000);
  if (!response.ok || !response.data || typeof response.data !== 'object') return null;
  if (String(response.data.client_id || '') !== clientId) return null;
  const redirectUris = Array.isArray(response.data.redirect_uris) ? response.data.redirect_uris.map(String) : [];
  if (!redirectUris.length || redirectUris.some(uri => !validRedirectUri(uri)) || !redirectUris.includes(redirectUri)) return null;
  if (response.data.grant_types && !response.data.grant_types.includes('authorization_code')) return null;
  if (response.data.response_types && !response.data.response_types.includes('code')) return null;
  if (response.data.token_endpoint_auth_method && response.data.token_endpoint_auth_method !== 'none') return null;
  return {
    client_id: clientId,
    client_name: String(response.data.client_name || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    application_type: String(response.data.application_type || '').slice(0, 20)
  };
}

async function loadClient(clientId, redirectUri, issuer) {
  if (!clientId || clientId.length > 4096 || redirectUri.length > 4096) return null;
  return registeredClientFromToken(clientId, redirectUri, issuer) || clientFromMetadataDocument(clientId, redirectUri);
}

function cacheAbilities(cacheKey, abilities) {
  abilityCache.delete(cacheKey);
  abilityCache.set(cacheKey, { abilities, expiresAt: Date.now() + ABILITY_CACHE_TTL_MS });
  while (abilityCache.size > ABILITY_CACHE_MAX_ENTRIES) abilityCache.delete(abilityCache.keys().next().value);
}

async function fetchAbilities(auth) {
  const cacheKey = crypto.createHash('sha256').update(`${auth.site_url}|${auth.username}`).digest('hex');
  const cached = abilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    abilityCache.delete(cacheKey);
    abilityCache.set(cacheKey, cached);
    return cached.abilities;
  }
  if (cached) abilityCache.delete(cacheKey);
  const abilities = [];
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    const url = new URL('wp-json/wp-abilities/v1/abilities', auth.site_url);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(pageNumber));
    const response = await fetchJson(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: basicAuth(auth.username, auth.password),
        'User-Agent': `WPGo-MCP/${VERSION}`
      }
    });
    if (!response.ok || !Array.isArray(response.data)) {
      throw new Error(`WordPress abilities request failed (${response.status}).`);
    }
    abilities.push(...response.data);
    const totalPages = Number(response.headers.get('x-wp-totalpages') || 1);
    if (pageNumber >= totalPages || response.data.length < 100) break;
  }
  const filtered = abilities.filter(ability =>
    typeof ability?.name === 'string' && ability.name.startsWith('wpgo/') &&
    !BLOCKED_ABILITIES.has(ability.name) && !ability.name.startsWith('wpgo/controller-')
  );
  cacheAbilities(cacheKey, filtered);
  return filtered;
}

function annotations(ability) {
  return ability?.meta?.annotations && typeof ability.meta.annotations === 'object' ? ability.meta.annotations : {};
}
function isReadonly(ability) { return annotations(ability).readonly === true; }
function toolName(name) { return name.replace(/^wpgo\//, 'wpgo__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); }

function toolSchema(ability) {
  const original = ability?.input_schema && typeof ability.input_schema === 'object'
    ? structuredClone(ability.input_schema)
    : { type: 'object', additionalProperties: false };
  const readonly = isReadonly(ability);
  if (original.type === 'object' || !original.type) {
    original.type = 'object';
    if (!original.properties || typeof original.properties !== 'object') original.properties = {};
    if (!readonly) {
      original.properties.approval_id = {
        type: 'string', minLength: 8,
        description: 'WPGo approval ID. Omit on the first call. After approving the returned WordPress approval URL, retry the exact same action with this ID.'
      };
    }
    return { schema: original, unwrap: false };
  }
  const properties = { input: original };
  if (!readonly) {
    properties.approval_id = {
      type: 'string', minLength: 8,
      description: 'WPGo approval ID. Omit on the first call. After approval, retry with this ID.'
    };
  }
  return { schema: { type: 'object', properties, required: ['input'], additionalProperties: false }, unwrap: true };
}

function splitToolArgs(ability, args, unwrap) {
  const readonly = isReadonly(ability);
  const raw = args && typeof args === 'object' ? structuredClone(args) : {};
  const approvalId = !readonly ? String(raw.approval_id || '').trim() : '';
  if (!readonly) delete raw.approval_id;
  return { approvalId, input: unwrap ? raw.input : raw };
}

async function executeAbility(auth, ability, args, unwrap) {
  const { approvalId, input } = splitToolArgs(ability, args, unwrap);
  const runUrl = new URL('wp-json/wpgo/v1/abilities/run', auth.site_url);
  const body = { ability: ability.name, input };
  if (approvalId) body.approval_id = approvalId;
  const response = await fetchJson(runUrl.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: basicAuth(auth.username, auth.password),
      'User-Agent': `WPGo-MCP/${VERSION}`
    },
    body: JSON.stringify(body)
  }, 30_000);
  if (!response.ok) {
    const message = response.data?.message || response.data?.error || response.text || `WordPress returned ${response.status}`;
    return { content: [{ type: 'text', text: `WPGo action failed: ${String(message).slice(0, 4000)}` }], isError: true };
  }
  const value = response.data ?? response.text ?? null;
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value } : {})
  };
}

async function approvalStatus(auth, approvalId) {
  const id = String(approvalId || '').trim();
  if (!/^[A-Za-z0-9-]{8,}$/.test(id)) return { content: [{ type: 'text', text: 'Invalid approval ID.' }], isError: true };
  const url = new URL(`wp-json/wpgo/v1/approvals/${encodeURIComponent(id)}`, auth.site_url);
  const response = await fetchJson(url.toString(), {
    headers: { Accept: 'application/json', Authorization: basicAuth(auth.username, auth.password), 'User-Agent': `WPGo-MCP/${VERSION}` }
  });
  if (!response.ok) return { content: [{ type: 'text', text: `Could not read approval status (${response.status}).` }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }], structuredContent: response.data };
}

async function buildMcpServer(ctx) {
  const token = ctx?.authInfo?.token || '';
  const auth = unseal('wpgoaccess1', token);
  if (!auth) throw new Error('Invalid WPGo access token.');
  const abilities = await fetchAbilities(auth);
  const server = new McpServer({ name: 'WPGo', version: VERSION }, { capabilities: { tools: {} } });
  for (const ability of abilities) {
    const { schema, unwrap } = toolSchema(ability);
    const ann = annotations(ability);
    const readonly = isReadonly(ability);
    const approvalNote = readonly ? '' : ' This action is approval-gated: the first call returns a WordPress approval URL and approval_id. After the user approves it, retry the exact same tool call with approval_id.';
    server.registerTool(toolName(ability.name), {
      title: ability.label || ability.name,
      description: `${ability.description || ability.label || ability.name}${approvalNote}\nWPGo ability: ${ability.name}`,
      inputSchema: fromJsonSchema(schema),
      annotations: {
        readOnlyHint: readonly,
        destructiveHint: ann.destructive === true,
        idempotentHint: ann.idempotent === true,
        openWorldHint: false
      }
    }, async args => executeAbility(auth, ability, args, unwrap));
  }
  server.registerTool('wpgo__approval_status', {
    title: 'WPGo approval status',
    description: 'Check whether a previously requested WPGo write approval is pending, approved, rejected, expired or consumed.',
    inputSchema: fromJsonSchema({
      type: 'object', properties: { approval_id: { type: 'string', minLength: 8 } },
      required: ['approval_id'], additionalProperties: false
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => approvalStatus(auth, args?.approval_id));
  return server;
}

function createRateLimiter({ windowMs, max, maxBuckets = 10_000 }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, state] of buckets) if (state.resetAt <= now) buckets.delete(bucketKey);
  }, Math.min(windowMs, 60_000));
  timer.unref();
  return (req, res, next) => {
    const bucketKey = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    let state = buckets.get(bucketKey);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, state);
    }
    state.count += 1;
    if (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
    if (state.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    return next();
  };
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);
const oauthLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 300 });
const registrationLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });
const connectLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 120 });

async function beginWordPressApproval(req, res, flow, site) {
  const check = await inspectWordPress(site);
  console.log(JSON.stringify({
    event: 'wordpress_connection_check', request_id: req.id, site: check.site || '',
    ready: check.ready, code: check.code || 'ready', approval_proxy: check.approval_proxy === true,
    application_passwords: check.application_passwords === true
  }));
  if (!check.ready) {
    return errorPage(res, req, 'WordPress is not ready for WPGo', check.message || 'The site could not be connected.', check.code === 'wpgo_update_required' ? 409 : 400, check.code || 'site_not_ready');
  }
  const issuer = baseUrl(req);
  const appId = crypto.randomUUID();
  const nextFlow = seal('wpgoflow1', { ...flow, site: check.site, app_id: appId, exp: Math.floor(Date.now() / 1000) + 600 });
  const success = new URL('/oauth/wp/callback', issuer);
  success.searchParams.set('flow', nextFlow);
  const reject = new URL('/oauth/wp/reject', issuer);
  reject.searchParams.set('flow', nextFlow);
  const authorizeUrl = new URL(check.auth_endpoint);
  authorizeUrl.searchParams.set('app_name', 'WPGo AI Connector');
  authorizeUrl.searchParams.set('app_id', appId);
  authorizeUrl.searchParams.set('success_url', success.toString());
  authorizeUrl.searchParams.set('reject_url', reject.toString());
  console.log(JSON.stringify({ event: 'wordpress_authorization_redirect', request_id: req.id, site: check.site, auth_origin: authorizeUrl.origin }));
  return res.redirect(302, authorizeUrl.toString());
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  req.id = String(req.get('x-request-id') || crypto.randomUUID()).slice(0, 100);
  res.set('X-WPGo-Request-ID', req.id);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  const ready = authCodes.ready();
  return res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'wpgo-mcp-gateway',
    version: VERSION,
    product_version: PRODUCT_VERSION,
    mcp_url: legacyMcpUrl(req),
    oauth: true,
    oauth_code_store: authCodes.mode(),
    oauth_shared_state_required: authCodes.requiresShared(),
    protocols: ['2026-07-28', 'legacy-stateless'],
    wordpress_abilities: true,
    approval_proxy: true,
    wordpress_first_onboarding: true,
    site_specific_mcp_urls: true,
    client_id_metadata_documents: true,
    dynamic_client_registration: true
  });
});

app.get('/v1/connect/site-link', connectLimiter, async (req, res) => {
  const check = await inspectWordPress(req.query.site);
  if (!check.ready) return res.status(check.code === 'wpgo_update_required' ? 409 : 400).json({ ok: false, ...check, request_id: req.id });
  const mcpUrl = resourceForSite(baseUrl(req), check.site, rawSecret);
  return res.json({
    ok: true,
    product_version: PRODUCT_VERSION,
    site: check.site,
    site_name: check.site_name,
    mcp_url: mcpUrl,
    connection_page: `${baseUrl(req)}/connect/wordpress?site=${encodeURIComponent(check.site)}`,
    request_id: req.id
  });
});

app.get('/connect/wordpress', connectLimiter, async (req, res) => {
  const check = await inspectWordPress(req.query.site);
  if (!check.ready) return errorPage(res, req, 'This WordPress site is not ready', check.message || 'WPGo could not prepare the AI connection.', check.code === 'wpgo_update_required' ? 409 : 400, check.code || 'site_not_ready');
  const mcpUrl = resourceForSite(baseUrl(req), check.site, rawSecret);
  const nonce = crypto.randomBytes(16).toString('base64url');
  return page(res, {
    title: `Connect ${check.site_name}`,
    scriptNonce: nonce,
    body: `<span class="tag">WPGo ${esc(PRODUCT_VERSION)} · Release Candidate</span><h1>Connect your AI to ${esc(check.site_name)}</h1><p class="muted">WPGo has already identified this WordPress site. You will not need to type its address during authorization.</p><div class="steps"><div class="step on">1. WordPress ready</div><div class="step">2. Add connector</div><div class="step">3. Approve access</div><div class="step">4. Connected</div></div><div class="provider"><strong>Claude</strong><span class="muted small">Add a Custom Web connector, paste the MCP URL below, choose <b>Sign in now</b> and <b>Use Claude's published identity</b>.</span></div><div class="provider"><strong>ChatGPT or another MCP client</strong><span class="muted small">Add a remote/custom MCP connector and use the same URL. WPGo handles standards-based OAuth discovery.</span></div><label class="small">Site-specific MCP URL</label><div class="code" id="mcp-url">${esc(mcpUrl)}</div><div class="actions"><button class="btn" id="copy" type="button">Copy MCP URL</button><a class="btn secondary" href="${esc(check.site)}wp-admin/">Return to WordPress</a></div><p class="muted small" id="copy-status">This URL identifies the WordPress site but contains no WordPress password or Application Password.</p><script nonce="${nonce}">const b=document.getElementById('copy'),s=document.getElementById('copy-status'),u=document.getElementById('mcp-url').textContent;b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(u);b.textContent='Copied';s.textContent='Paste this URL into your AI client. When it asks you to sign in, WPGo will take you directly to WordPress approval.'}catch(e){s.textContent='Copy the URL manually from the box above.'}});</script>`
  });
});

app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json({
  resource: legacyMcpUrl(req),
  authorization_servers: [baseUrl(req)],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header']
}));

app.get('/.well-known/oauth-protected-resource/mcp/s/:siteToken', (req, res) => {
  const site = readSiteToken(req.params.siteToken, rawSecret);
  if (!site) return res.status(404).json({ error: 'invalid_site_link' });
  const resource = `${baseUrl(req)}/mcp/s/${encodeURIComponent(req.params.siteToken)}`;
  return res.json({
    resource,
    authorization_servers: [baseUrl(req)],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header']
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = baseUrl(req);
  return res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  });
});

app.post('/oauth/register', registrationLimiter, (req, res) => {
  const rawRedirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
  const redirectUris = [...new Set(rawRedirectUris)].slice(0, 10);
  if (!redirectUris.length || rawRedirectUris.length > 10 || redirectUris.some(uri => !validRedirectUri(uri))) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  const grantTypes = Array.isArray(req.body?.grant_types) ? req.body.grant_types.map(String) : [];
  const responseTypes = Array.isArray(req.body?.response_types) ? req.body.response_types.map(String) : [];
  const authMethod = String(req.body?.token_endpoint_auth_method || 'none');
  if ((grantTypes.length && !grantTypes.includes('authorization_code')) || (responseTypes.length && !responseTypes.includes('code')) || authMethod !== 'none') {
    return res.status(400).json({ error: 'invalid_client_metadata' });
  }
  const inferredNative = redirectUris.some(uri => new URL(uri).protocol === 'http:');
  const requestedType = String(req.body?.application_type || '');
  const applicationType = ['native', 'web'].includes(requestedType) ? requestedType : (inferredNative ? 'native' : 'web');
  const issuer = baseUrl(req);
  const issuedAt = Math.floor(Date.now() / 1000);
  const client = {
    issuer,
    client_name: String(req.body?.client_name || 'MCP client').slice(0, 120),
    redirect_uris: redirectUris,
    application_type: applicationType,
    iat: issuedAt
  };
  const clientId = seal('wpgoclient1', client);
  res.set('Cache-Control', 'no-store');
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: client.client_name,
    redirect_uris: redirectUris,
    application_type: applicationType,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  });
});

app.get('/oauth/authorize', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const responseType = String(req.query.response_type || '');
  const clientId = String(req.query.client_id || '');
  const redirectUri = String(req.query.redirect_uri || '');
  const challenge = String(req.query.code_challenge || '');
  const challengeMethod = String(req.query.code_challenge_method || '');
  const state = String(req.query.state || '');
  const requestedResource = String(req.query.resource || legacyMcpUrl(req));
  const resourceInfo = validateResource(requestedResource, issuer);
  const scopes = normalizeScope(req.query.scope || 'mcp');
  if (responseType !== 'code' || !clientId || !validRedirectUri(redirectUri) || !validPkceChallenge(challenge) || challengeMethod !== 'S256' || !resourceInfo) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  if (!scopesAreSupported(scopes)) {
    return res.redirect(302, oauthErrorRedirect(redirectUri, issuer, 'invalid_scope', 'WPGo currently supports only the mcp scope.', state));
  }
  const client = await loadClient(clientId, redirectUri, issuer);
  if (!client) return res.status(400).json({ error: 'invalid_client' });
  const flow = seal('wpgoflow1', {
    issuer,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
    resource: resourceInfo.resource,
    scope: 'mcp',
    client_name: client.client_name || 'MCP client',
    exp: Math.floor(Date.now() / 1000) + 600
  });
  if (resourceInfo.site) {
    return beginWordPressApproval(req, res, unseal('wpgoflow1', flow), resourceInfo.site);
  }
  return page(res, {
    title: 'Connect WPGo',
    formAction: "'self' https:",
    body: `<span class="tag">WPGo ${esc(PRODUCT_VERSION)}</span><h1>Choose your WordPress site</h1><p class="muted">This is the compatibility connection route. For the easiest setup, start from <b>WPGo → Connect AI</b> inside WordPress so the site is selected automatically.</p><div class="steps"><div class="step">1. Site</div><div class="step on">2. Connect</div><div class="step">3. Approve</div><div class="step">4. Done</div></div><form method="post" action="/oauth/authorize/site"><input type="hidden" name="flow" value="${esc(flow)}"><label class="small">WordPress site</label><input name="site" type="url" placeholder="https://example.com" required autocomplete="url"><div class="actions"><button class="btn" type="submit">Continue to WordPress</button></div></form><p class="muted small">WPGo never asks for your normal WordPress password.</p>`
  });
});

app.post('/oauth/authorize/site', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.body?.flow || ''));
  if (!flow || flow.issuer !== issuer) return errorPage(res, req, 'Connection expired', 'Return to your AI client and start the WPGo connection again.', 400, 'flow_expired');
  const site = normalizeSite(req.body?.site);
  if (!site) return errorPage(res, req, 'Invalid WordPress address', 'Enter the HTTPS address of the WordPress site where WPGo is installed.', 400, 'invalid_site_url');
  return beginWordPressApproval(req, res, flow, site);
});

app.get('/oauth/wp/reject', oauthLimiter, (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.query.flow || ''));
  if (!flow || flow.issuer !== issuer) return errorPage(res, req, 'Connection cancelled', 'The WordPress authorization request is no longer valid.', 400, 'flow_expired');
  return res.redirect(302, oauthErrorRedirect(flow.redirect_uri, issuer, 'access_denied', 'WordPress authorization was cancelled.', flow.state));
});

app.get('/oauth/wp/callback', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const flow = unseal('wpgoflow1', String(req.query.flow || ''));
  if (!flow || flow.issuer !== issuer) return errorPage(res, req, 'Connection expired', 'Return to your AI client and connect WPGo again.', 400, 'flow_expired');
  const siteReturned = normalizeSite(req.query.site_url);
  const username = String(req.query.user_login || '');
  const password = String(req.query.password || '');
  if (!siteReturned || siteReturned !== flow.site || !username || username.length > 255 || password.length < 12 || password.length > 512) {
    return res.redirect(302, oauthErrorRedirect(flow.redirect_uri, issuer, 'access_denied', 'WordPress did not return a valid authorization.', flow.state));
  }
  const auth = { site_url: flow.site, username, password };
  try {
    if (!(await fetchAbilities(auth)).length) throw new Error('No WPGo abilities found.');
  } catch {
    return res.redirect(302, oauthErrorRedirect(flow.redirect_uri, issuer, 'access_denied', 'WPGo could not verify the WordPress connection.', flow.state));
  }
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 300_000;
  const payload = seal('wpgocode1', { ...flow, username, password, exp: Math.floor(expiresAt / 1000) });
  try {
    await authCodes.put(code, { payload, expiresAt });
  } catch {
    return res.redirect(302, oauthErrorRedirect(flow.redirect_uri, issuer, 'temporarily_unavailable', 'WPGo could not securely complete the connection. Please try again.', flow.state));
  }
  console.log(JSON.stringify({ event: 'oauth_wordpress_authorized', request_id: req.id, site: flow.site, client_name: String(flow.client_name || '').slice(0, 100) }));
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, authorizationRedirect(flow.redirect_uri, issuer, code, flow.state));
});

app.post('/oauth/token', oauthLimiter, async (req, res) => {
  const issuer = baseUrl(req);
  const grant = String(req.body?.grant_type || '');
  const clientId = String(req.body?.client_id || '');
  const requestedResource = String(req.body?.resource || legacyMcpUrl(req));
  const resourceInfo = validateResource(requestedResource, issuer);
  res.set('Cache-Control', 'no-store');
  if (!clientId || clientId.length > 4096) return res.status(400).json({ error: 'invalid_client' });
  if (!resourceInfo) return res.status(400).json({ error: 'invalid_target' });

  if (grant === 'authorization_code') {
    const code = String(req.body?.code || '');
    const verifier = String(req.body?.code_verifier || '');
    const redirectUri = String(req.body?.redirect_uri || '');
    if (!code || code.length > 512 || !validPkceVerifier(verifier) || !validRedirectUri(redirectUri)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    let stored;
    try { stored = await authCodes.take(code); }
    catch { return res.status(503).json({ error: 'temporarily_unavailable' }); }
    const row = stored?.payload ? unseal('wpgocode1', stored.payload) : null;
    if (!row || stored.expiresAt < Date.now() || row.issuer !== issuer || row.resource !== resourceInfo.resource || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!secureEqual(expected, row.code_challenge)) return res.status(400).json({ error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    const base = {
      issuer,
      client_id: clientId,
      site_url: row.site,
      username: row.username,
      password: row.password,
      resource: resourceInfo.resource,
      scopes: ['mcp']
    };
    return res.json({
      access_token: seal('wpgoaccess1', { ...base, iat: now, exp: now + 3600 }),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: seal('wpgorefresh1', { ...base, iat: now, exp: now + 86400 * 30 }),
      scope: 'mcp'
    });
  }

  if (grant === 'refresh_token') {
    const refreshToken = String(req.body?.refresh_token || '');
    const row = unseal('wpgorefresh1', refreshToken);
    if (!row || row.issuer !== issuer || row.resource !== resourceInfo.resource || row.client_id !== clientId || !Array.isArray(row.scopes) || !row.scopes.includes('mcp')) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    return res.json({
      access_token: seal('wpgoaccess1', { ...row, iat: now, exp: now + 3600 }),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'mcp'
    });
  }
  return res.status(400).json({ error: 'unsupported_grant_type' });
});

async function mcpAuth(req, res, next) {
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const row = unseal('wpgoaccess1', token);
  const issuer = baseUrl(req);
  const resource = requestResource(req);
  const resourceInfo = validateResource(resource, issuer);
  if (!resourceInfo) return res.status(404).json({ error: 'invalid_resource' });
  const metadata = resourceMetadataUrl(resourceInfo.resource);
  if (!row || row.issuer !== issuer || row.resource !== resourceInfo.resource) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="invalid_token"`);
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (!Array.isArray(row.scopes) || !row.scopes.includes('mcp')) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="mcp"`);
    return res.status(403).json({ error: 'insufficient_scope' });
  }
  if (resourceInfo.site && normalizeSite(row.site_url) !== resourceInfo.site) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="invalid_token"`);
    return res.status(401).json({ error: 'site_binding_mismatch' });
  }
  req.auth = {
    token,
    clientId: row.client_id,
    scopes: ['mcp'],
    expiresAt: row.exp,
    resource: new URL(resourceInfo.resource),
    resourceMetadataUrl: new URL(metadata)
  };
  return next();
}

app.all('/mcp', mcpAuth, (req, res) => void nodeMcpHandler(req, res, req.body));
app.all('/mcp/s/:siteToken', (req, res, next) => {
  const site = readSiteToken(req.params.siteToken, rawSecret);
  if (!site) return res.status(404).json({ error: 'invalid_site_link' });
  return mcpAuth(req, res, next);
}, (req, res) => void nodeMcpHandler(req, res, req.body));

app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    event: 'gateway_error',
    request_id: req.id || '',
    path: req.path,
    message: String(err?.message || err).slice(0, 500)
  }));
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'server_error', request_id: req.id || '' });
});

const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`WPGo MCP gateway ${VERSION} / product ${PRODUCT_VERSION} listening on ${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'gateway_shutdown', signal }));
  httpServer.close(async () => {
    await authCodes.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
