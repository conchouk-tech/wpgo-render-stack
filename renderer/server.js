import express from 'express';
import { chromium } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const app = express();
const VERSION = '4.3.0';
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 8080);
const token = String(process.env.WPGO_RENDER_TOKEN || '');
const allowInsecureNoToken = process.env.WPGO_RENDER_ALLOW_NO_TOKEN === '1';
const allowAnyPublic = process.env.WPGO_RENDER_ALLOW_ANY_PUBLIC === '1';
const allowHttp = process.env.WPGO_RENDER_ALLOW_HTTP === '1' && !production;
const allowedHosts = new Set(
  String(process.env.WPGO_RENDER_ALLOWED_HOSTS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);
const allowedPorts = new Set(
  String(process.env.WPGO_RENDER_ALLOWED_PORTS || '443')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0 && value <= 65535)
);
const maxConcurrency = Math.max(1, Math.min(12, Number(process.env.WPGO_RENDER_MAX_CONCURRENCY || 3)));
const maxDnsCacheEntries = Math.max(100, Math.min(20_000, Number(process.env.WPGO_RENDER_DNS_CACHE_MAX || 5000)));
const dnsCache = new Map();
let active = 0;
let browser = null;
let browserStartupError = '';

if (production && (token.length < 32 || allowInsecureNoToken)) {
  throw new Error('production_configuration_invalid:WPGO_RENDER_TOKEN must be >=32 chars and no-token mode must be disabled');
}

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['2001:10::', 28],
  ['2001:20::', 28], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv6'));

function mappedIpv4(address) {
  const value = String(address || '').toLowerCase();
  let match = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (match) return match[1];
  match = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return '';
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isBlockedAddress(address, familyHint = 0) {
  const mapped = mappedIpv4(address);
  if (mapped) return blocked.check(mapped, 'ipv4');
  const family = familyHint === 6 || net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (!net.isIP(address)) return true;
  return blocked.check(address, family);
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(req) {
  if (!token) return allowInsecureNoToken && !production;
  return safeEqual(req.get('authorization') || '', `Bearer ${token}`);
}

function rememberDns(host, result, ttlMs) {
  dnsCache.delete(host);
  dnsCache.set(host, { ...result, expiresAt: Date.now() + ttlMs });
  while (dnsCache.size > maxDnsCacheEntries) {
    const oldest = dnsCache.keys().next().value;
    if (!oldest) break;
    dnsCache.delete(oldest);
  }
}

async function publicHost(host) {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > now) {
    dnsCache.delete(host);
    dnsCache.set(host, cached);
    return cached.ok;
  }
  if (cached) dnsCache.delete(host);

  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    const ok = Boolean(results.length) && !results.some(result => isBlockedAddress(result.address, result.family));
    rememberDns(host, { ok }, ok ? 60_000 : 15_000);
    return ok;
  } catch {
    rememberDns(host, { ok: false }, 15_000);
    return false;
  }
}

async function validateUrl(value, { main = false } = {}) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password) return false;
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return false;
    const effectivePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!allowedPorts.has(effectivePort) && !(allowHttp && effectivePort === 80)) return false;
    const host = url.hostname.toLowerCase();
    if (main && allowedHosts.size && !allowedHosts.has(host)) return false;
    if (main && !allowedHosts.size && !allowAnyPublic) return false;
    if (!await publicHost(host)) return false;
    return url;
  } catch {
    return false;
  }
}

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps'
      ]
    });
    browserStartupError = '';
    browser.on('disconnected', () => { browser = null; });
    return browser;
  } catch (error) {
    browserStartupError = String(error?.message || error).slice(0, 200);
    throw error;
  }
}

function securityHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function createRateLimiter({ windowMs, max, maxBuckets = 10_000 }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of buckets) if (state.resetAt <= now) buckets.delete(key);
  }, Math.min(windowMs, 60_000));
  timer.unref();
  return (req, res, next) => {
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    let state = buckets.get(key);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      buckets.set(key, state);
    }
    state.count += 1;
    if (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
    if (state.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'rate_limited' });
    }
    return next();
  };
}

const renderLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use((_req, res, next) => {
  securityHeaders(res);
  next();
});

app.get('/health', (_req, res) => {
  const browserReady = Boolean(browser?.isConnected());
  return res.status(browserReady ? 200 : 503).json({
    ok: browserReady,
    service: 'wpgo-renderer',
    version: VERSION,
    browser_ready: browserReady,
    active,
    max_concurrency: maxConcurrency,
    network_policy: 'public-only',
    error: browserReady ? '' : browserStartupError
  });
});

app.get('/v1/capabilities', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.json({
    service: 'wpgo-renderer',
    version: VERSION,
    javascript: true,
    network_policy: 'public-only',
    main_host_allowlist: true,
    subresource_ssrf_preflight: true,
    allowed_ports: [...allowedPorts].sort((a, b) => a - b),
    max_concurrency: maxConcurrency
  });
});

app.post('/render', renderLimiter, async (req, res) => {
  const requestId = crypto.randomUUID();
  res.set('X-WPGo-Request-ID', requestId);
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized', request_id: requestId });
  if (active >= maxConcurrency) {
    return res.status(429).json({ error: 'busy', retry_after_seconds: 2, request_id: requestId });
  }

  const url = await validateUrl(req.body?.url, { main: true });
  if (!url) return res.status(400).json({ error: 'invalid_or_disallowed_url', request_id: requestId });
  const waitMs = Math.max(0, Math.min(5000, Number(req.body?.wait_ms || 800)));
  const maxHtml = Math.max(1000, Math.min(100_000, Number(req.body?.max_html || 20_000)));
  const started = Date.now();
  active += 1;
  let context;

  try {
    const currentBrowser = await getBrowser();
    context = await currentBrowser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block'
    });
    const page = await context.newPage();
    await page.route('**/*', async route => {
      const request = route.request();
      if (['media', 'font', 'websocket'].includes(request.resourceType())) return route.abort();
      const target = await validateUrl(request.url(), { main: false });
      if (!target) return route.abort('blockedbyclient');
      return route.continue();
    });

    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const serverAddress = response ? await response.serverAddr().catch(() => null) : null;
    if (serverAddress?.ipAddress && isBlockedAddress(serverAddress.ipAddress)) {
      throw new Error('Rendered endpoint resolved to a blocked network address.');
    }
    const finalUrl = page.url();
    if (!await validateUrl(finalUrl, { main: true })) {
      throw new Error('Final navigation URL failed WPGo public-network policy.');
    }
    if (waitMs) await page.waitForTimeout(waitMs);
    const html = (await page.content()).slice(0, maxHtml);
    const title = await page.title();
    return res.json({
      html,
      title,
      renderer: 'wpgo-playwright',
      renderer_version: VERSION,
      javascript_executed: true,
      final_url: finalUrl,
      request_id: requestId,
      timings: { total_ms: Date.now() - started }
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'render_failed',
      request_id: requestId,
      message: String(error?.message || error).slice(0, 300)
    }));
    return res.status(502).json({ error: 'render_failed', request_id: requestId });
  } finally {
    active -= 1;
    if (context) await context.close().catch(() => {});
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'renderer_shutdown', signal }));
  try {
    if (browser) await browser.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen(port, '0.0.0.0', () => {
  console.log(`WPGo renderer ${VERSION} listening on ${port}`);
  void getBrowser().catch(() => {});
});
