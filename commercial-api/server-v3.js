import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import { billingMutationForEvent } from './billing-lifecycle.js';

const { Pool } = pg;
const app = express();
const VERSION = '1.5.0-rc.2';
const port = Number(process.env.PORT || 8081);
const production = process.env.NODE_ENV === 'production';
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const sessionSecret = String(process.env.WPGO_SESSION_SECRET || '');
const founderEmails = new Set(
  String(process.env.WPGO_FOUNDER_EMAILS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);
const devAuth = process.env.WPGO_DEV_AUTH === '1';
const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
const loginFrom = String(process.env.WPGO_LOGIN_FROM_EMAIL || '').trim();
const licenseValidateUrl = String(
  process.env.WPGO_LICENSE_VALIDATE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/license/validate'
).trim();
const licenseIssueUrl = String(
  process.env.WPGO_LICENSE_ISSUE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/admin/license/issue'
).trim();
const controlAdminToken = String(process.env.WPGO_CONTROL_ADMIN_TOKEN || '');
const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const PLANS = {
  free: { id: 'free', name: 'Free', monthly_eur: 0, yearly_eur: 0, daily_actions: 100, client_controls: false },
  solo: { id: 'solo', name: 'Solo', monthly_eur: 5.95, yearly_eur: 60.69, daily_actions: 750, client_controls: false },
  pro: { id: 'pro', name: 'Pro', monthly_eur: 12.95, yearly_eur: 132.09, daily_actions: 2500, client_controls: false },
  agency: { id: 'agency', name: 'Agency', monthly_eur: 24.95, yearly_eur: 254.49, daily_actions: 7500, client_controls: true },
  scale: { id: 'scale', name: 'Scale', monthly_eur: 39.95, yearly_eur: 407.49, daily_actions: 15000, client_controls: true },
  founder: { id: 'founder', name: 'Founder', monthly_eur: 0, yearly_eur: 0, daily_actions: null, client_controls: true, unlimited: true }
};
const PRICE_ENV = {
  solo: { monthly: 'STRIPE_PRICE_SOLO', yearly: 'STRIPE_PRICE_SOLO_YEARLY' },
  pro: { monthly: 'STRIPE_PRICE_PRO', yearly: 'STRIPE_PRICE_PRO_YEARLY' },
  agency: { monthly: 'STRIPE_PRICE_AGENCY', yearly: 'STRIPE_PRICE_AGENCY_YEARLY' },
  scale: { monthly: 'STRIPE_PRICE_SCALE', yearly: 'STRIPE_PRICE_SCALE_YEARLY' }
};

function requireProductionConfig() {
  if (!production) return;
  const missing = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (sessionSecret.length < 32) missing.push('WPGO_SESSION_SECRET(>=32 chars)');
  if (!controlAdminToken) missing.push('WPGO_CONTROL_ADMIN_TOKEN');
  if (!resendApiKey) missing.push('RESEND_API_KEY');
  if (!loginFrom) missing.push('WPGO_LOGIN_FROM_EMAIL');
  if (devAuth) missing.push('WPGO_DEV_AUTH must be 0');
  for (const [name, value] of [['WPGO_LICENSE_VALIDATE_URL', licenseValidateUrl], ['WPGO_LICENSE_ISSUE_URL', licenseIssueUrl]]) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') missing.push(`${name}(https)`);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) throw new Error(`production_configuration_invalid:${missing.join(',')}`);
}
requireProductionConfig();
if (!production && sessionSecret.length < 32) {
  console.warn('WPGO_SESSION_SECRET is shorter than 32 characters; development sessions are not production-safe.');
}

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: Number(process.env.WPGO_DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000
    })
  : null;

function q(text, params = []) {
  if (!pool) throw new Error('database_not_configured');
  return pool.query(text, params);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeSiteUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url.toString();
  } catch {
    return '';
  }
}

function hostFromSiteUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function accountPlan(row) {
  if (row?.is_founder || founderEmails.has(normalizeEmail(row?.email))) return PLANS.founder;
  return PLANS[row?.plan] || PLANS.free;
}

function hmac(value) {
  if (!sessionSecret) throw new Error('session_secret_not_configured');
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function makeSession(account) {
  const payload = Buffer.from(JSON.stringify({
    id: account.id,
    email: account.email,
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
    nonce: crypto.randomBytes(12).toString('base64url')
  })).toString('base64url');
  return `wpgosess1.${payload}.${hmac(payload)}`;
}

function readSession(token) {
  if (!token || !token.startsWith('wpgosess1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(hmac(parts[1]));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value.exp && value.exp >= Date.now() ? value : null;
  } catch {
    return null;
  }
}

function bearer(req) {
  const value = String(req.get('authorization') || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function codeHash(email, code) {
  return crypto.createHmac('sha256', sessionSecret)
    .update(`${email}|${code}`)
    .digest('hex');
}

function createRateLimiter({ windowMs, max, maxBuckets = 20_000, key }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, state] of buckets) {
      if (state.resetAt <= now) buckets.delete(bucketKey);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = String(key?.(req) || req.ip || req.socket?.remoteAddress || 'unknown');
    let state = buckets.get(bucketKey);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, state);
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

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

async function initDb() {
  if (!pool) return;
  await q(`CREATE TABLE IF NOT EXISTS wpgo_accounts (
    id UUID PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    is_founder BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_login_codes (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE wpgo_login_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_login_codes_email_idx ON wpgo_login_codes(email, created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_usage_events (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES wpgo_accounts(id) ON DELETE CASCADE,
    site_host TEXT NOT NULL DEFAULT '',
    operation TEXT NOT NULL DEFAULT '',
    units INTEGER NOT NULL DEFAULT 1,
    success BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_usage_window_idx ON wpgo_usage_events(account_id, created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_sites (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES wpgo_accounts(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    site_host TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE wpgo_sites DROP CONSTRAINT IF EXISTS wpgo_sites_account_id_site_host_key`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS wpgo_sites_account_url_uidx ON wpgo_sites(account_id, site_url)`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_sites_account_host_idx ON wpgo_sites(account_id, site_host)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_support_tickets (
    id UUID PRIMARY KEY,
    type TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    site_url TEXT NOT NULL DEFAULT '',
    wp_version TEXT NOT NULL DEFAULT '',
    wpgo_version TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    source_ip_hash TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_support_email_idx ON wpgo_support_tickets(email, created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_stripe_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_stripe_events_received_idx ON wpgo_stripe_events(received_at DESC)`);
}

async function getOrCreateAccount(email) {
  const isFounder = founderEmails.has(email);
  const id = crypto.randomUUID();
  const result = await q(
    `INSERT INTO wpgo_accounts(id,email,plan,is_founder)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(email) DO UPDATE SET
       is_founder=wpgo_accounts.is_founder OR EXCLUDED.is_founder,
       updated_at=NOW()
     RETURNING *`,
    [id, email, isFounder ? 'founder' : 'free', isFounder]
  );
  return result.rows[0];
}

async function usageFor(account, client = pool) {
  const plan = accountPlan(account);
  if (plan.unlimited) {
    return { plan: plan.id, unlimited: true, used: 0, allowance: null, remaining: null, window_hours: 24, percent: 0 };
  }
  if (!client) throw new Error('database_not_configured');
  const result = await client.query(
    `SELECT COALESCE(SUM(units),0)::int AS used
     FROM wpgo_usage_events
     WHERE account_id=$1 AND success=TRUE AND created_at>NOW()-INTERVAL '24 hours'`,
    [account.id]
  );
  const used = Number(result.rows[0]?.used || 0);
  const allowance = plan.daily_actions;
  const remaining = Math.max(0, allowance - used);
  return {
    plan: plan.id,
    unlimited: false,
    used,
    allowance,
    remaining,
    window_hours: 24,
    percent: Math.min(100, Math.round((used / allowance) * 1000) / 10)
  };
}

async function authAccount(req, res, next) {
  try {
    const session = readSession(bearer(req));
    if (!session) return res.status(401).json({ error: 'authentication_required' });
    const result = await q(`SELECT * FROM wpgo_accounts WHERE id=$1`, [session.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'account_not_found' });
    req.account = result.rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

async function sendLoginCode(email, code, id) {
  if (devAuth && !production) return { ok: true, dev_code: code };
  if (!resendApiKey || !loginFrom) return { ok: false, error: 'email_delivery_not_configured' };
  const response = await fetchJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${resendApiKey}`,
      'idempotency-key': `wpgo-login/${id}`
    },
    body: JSON.stringify({
      from: loginFrom,
      to: [email],
      subject: 'Your WPGo sign-in code',
      text: `Your WPGo sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h2>Sign in to WPGo</h2><p>Your one-time sign-in code is:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;padding:18px 0">${code}</div><p>This code expires in 10 minutes.</p><p style="color:#667085">If you did not request this code, you can ignore this email.</p></div>`
    })
  }, 10_000);
  if (!response.ok) {
    console.error(JSON.stringify({ event: 'login_email_failed', status: response.status }));
    return { ok: false, error: 'email_delivery_failed' };
  }
  return { ok: true };
}

async function validateCommercialLicense(req) {
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: 'license_required' };
  const siteUrl = normalizeSiteUrl(req.body?.site_url || req.get('x-wpgo-site') || '');
  if (!siteUrl) return { ok: false, status: 400, error: 'site_required' };
  try {
    const response = await fetchJson(licenseValidateUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `WPGo-Commercial-API/${VERSION}`
      },
      body: JSON.stringify({ license_key: token, site_url: siteUrl })
    }, 8_000);
    const raw = response.data || {};
    const data = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!response.ok || data?.status !== 'active' || !data?.license_id) {
      return { ok: false, status: response.status || 403, error: data?.status || 'invalid_license' };
    }
    return {
      ok: true,
      license: data,
      token,
      siteUrl,
      siteHost: hostFromSiteUrl(siteUrl)
    };
  } catch {
    return { ok: false, status: 502, error: 'license_service_unavailable' };
  }
}

async function accountFromLicense(req) {
  const validated = await validateCommercialLicense(req);
  if (!validated.ok) return validated;
  const result = await q(`SELECT * FROM wpgo_accounts WHERE id=$1`, [validated.license.license_id]);
  if (!result.rows[0]) return { ok: false, status: 404, error: 'account_not_found' };
  return { ...validated, account: result.rows[0] };
}

async function accountSiteHosts(accountId) {
  const result = await q(
    `SELECT DISTINCT site_host FROM wpgo_sites WHERE account_id=$1 ORDER BY site_host ASC LIMIT 25`,
    [accountId]
  );
  return result.rows.map(row => String(row.site_host || '').trim().toLowerCase()).filter(Boolean);
}

async function issueLicenseForAccount(account) {
  if (!controlAdminToken) throw new Error('control_plane_admin_not_configured');
  const siteHosts = await accountSiteHosts(account.id);
  if (!siteHosts.length) {
    const error = new Error('no_registered_sites');
    error.status = 409;
    throw error;
  }
  const plan = accountPlan(account);
  const response = await fetchJson(licenseIssueUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${controlAdminToken}`,
      'user-agent': `WPGo-Commercial-API/${VERSION}`
    },
    body: JSON.stringify({
      license_id: account.id,
      status: 'active',
      plan: plan.id,
      features: ['updates', 'support', 'metering', 'account-connect'],
      site_hosts: siteHosts
    })
  }, 8_000);
  if (!response.ok || !response.data?.license_key) {
    throw new Error(response.data?.error || 'license_issue_failed');
  }
  return response.data;
}

function planState(validated) {
  const authoritative = accountPlan(validated.account);
  const tokenPlan = String(validated.license?.plan || '');
  return {
    plan: authoritative,
    token_plan: tokenPlan,
    license_refresh_required: tokenPlan !== authoritative.id
  };
}

async function consumeUsage(account, siteHost, operation, units, success) {
  if (!success) return { counted: false, usage: await usageFor(account) };
  if (!pool) throw new Error('database_not_configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [String(account.id)]);
    const before = await usageFor(account, client);
    if (!before.unlimited && before.remaining < units) {
      await client.query('ROLLBACK');
      return { counted: false, limitReached: true, usage: before };
    }
    await client.query(
      `INSERT INTO wpgo_usage_events(id,account_id,site_host,operation,units,success)
       VALUES($1,$2,$3,$4,$5,TRUE)`,
      [crypto.randomUUID(), account.id, siteHost, operation, units]
    );
    await client.query('COMMIT');
    return { counted: true, usage: await usageFor(account) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

const authRequestIpLimit = createRateLimiter({ windowMs: 60 * 60_000, max: 30 });
const authVerifyLimit = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 20,
  key: req => `${req.ip}|${normalizeEmail(req.body?.email)}`
});
const supportLimit = createRateLimiter({ windowMs: 60 * 60_000, max: 8 });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Cache-Control', 'no-store');
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use((req, res, next) => {
  if (req.path === '/v1/billing/webhook') return next();
  return express.json({ limit: '96kb' })(req, res, next);
});

app.get('/health', async (_req, res) => {
  let databaseReady = false;
  try {
    if (pool) {
      await q('SELECT 1');
      databaseReady = true;
    }
  } catch {}
  const criticalReady =
    databaseReady &&
    sessionSecret.length >= 32 &&
    Boolean(controlAdminToken) &&
    Boolean(resendApiKey && loginFrom) &&
    !devAuth;
  res.status(production && !criticalReady ? 503 : 200).json({
    ok: production ? criticalReady : databaseReady || !pool,
    service: 'wpgo-commercial-api',
    version: VERSION,
    database: databaseReady ? 'ready' : (pool ? 'unavailable' : 'not_configured'),
    session_security: sessionSecret.length >= 32 ? 'ready' : 'development_only',
    transactional_email: resendApiKey && loginFrom ? 'ready' : 'not_configured',
    control_plane: controlAdminToken ? 'ready' : 'not_configured',
    stripe: Boolean(stripe),
    stripe_webhook: Boolean(stripeWebhookSecret),
    annual_billing: true,
    support_tickets: true,
    strict_site_binding: true,
    license_refresh: true,
    authoritative_account_plan: true,
    plans: Object.keys(PLANS).filter(id => id !== 'founder')
  });
});

app.get('/v1/plans', (_req, res) => res.json({
  currency: 'EUR',
  billing: ['monthly', 'yearly'],
  yearly_discount_percent: 15,
  usage_window_hours: 24,
  failed_actions_count: false,
  plans: Object.values(PLANS).filter(plan => plan.id !== 'founder')
}));

app.post('/v1/auth/request-code', authRequestIpLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    const recent = await q(
      `SELECT COUNT(*)::int AS n FROM wpgo_login_codes WHERE email=$1 AND created_at>NOW()-INTERVAL '60 seconds'`,
      [email]
    );
    if (Number(recent.rows[0]?.n || 0) > 0) return res.status(429).json({ error: 'try_again_later' });
    const hourly = await q(
      `SELECT COUNT(*)::int AS n FROM wpgo_login_codes WHERE email=$1 AND created_at>NOW()-INTERVAL '1 hour'`,
      [email]
    );
    if (Number(hourly.rows[0]?.n || 0) >= 10) return res.status(429).json({ error: 'too_many_requests' });

    await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE email=$1 AND used_at IS NULL`, [email]);
    const code = String(crypto.randomInt(100000, 1_000_000));
    const id = crypto.randomUUID();
    await q(
      `INSERT INTO wpgo_login_codes(id,email,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,
      [id, email, codeHash(email, code)]
    );

    const delivered = await sendLoginCode(email, code, id);
    if (!delivered.ok) {
      await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1`, [id]).catch(() => {});
      return res.status(delivered.error === 'email_delivery_not_configured' ? 503 : 502).json({ error: delivered.error });
    }
    console.log(JSON.stringify({
      event: 'login_code_sent',
      email_hash: crypto.createHash('sha256').update(email).digest('hex').slice(0, 12),
      delivery: devAuth && !production ? 'development' : 'email'
    }));
    return res.json({
      ok: true,
      delivery: devAuth && !production ? 'development' : 'email',
      expires_minutes: 10,
      ...(devAuth && !production ? { dev_code: delivered.dev_code } : {})
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/auth/verify-code', authVerifyLimit, async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!validEmail(email) || !/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: 'invalid_code' });
  }
  if (!pool) return next(new Error('database_not_configured'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM wpgo_login_codes
       WHERE email=$1 AND used_at IS NULL AND expires_at>NOW()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email]
    );
    const row = selected.rows[0];
    if (!row || Number(row.attempts || 0) >= 10) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'invalid_or_expired_code' });
    }
    if (row.code_hash !== codeHash(email, code)) {
      await client.query(`UPDATE wpgo_login_codes SET attempts=attempts+1 WHERE id=$1`, [row.id]);
      await client.query('COMMIT');
      return res.status(401).json({ error: 'invalid_or_expired_code' });
    }
    await client.query(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1`, [row.id]);
    await client.query('COMMIT');

    const account = await getOrCreateAccount(email);
    const token = makeSession(account);
    return res.json({
      ok: true,
      token,
      account: {
        id: account.id,
        email: account.email,
        plan: accountPlan(account),
        usage: await usageFor(account)
      }
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    return next(error);
  } finally {
    client.release();
  }
});

app.get('/v1/account', authAccount, async (req, res, next) => {
  try {
    return res.json({
      account: {
        id: req.account.id,
        email: req.account.email,
        plan: accountPlan(req.account),
        subscription_status: req.account.subscription_status,
        usage: await usageFor(req.account)
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/v1/account/sites', authAccount, async (req, res, next) => {
  try {
    const result = await q(
      `SELECT id,site_url,site_host,label,connected_at FROM wpgo_sites WHERE account_id=$1 ORDER BY connected_at DESC`,
      [req.account.id]
    );
    return res.json({ sites: result.rows });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/account/license', authAccount, async (req, res, next) => {
  try {
    const issued = await issueLicenseForAccount(req.account);
    return res.json({ ok: true, license_key: issued.license_key, record: issued.record });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

app.post('/v1/sites/register', authAccount, async (req, res, next) => {
  try {
    const siteUrl = normalizeSiteUrl(req.body?.site_url);
    if (!siteUrl) return res.status(400).json({ error: 'invalid_site_url' });
    const host = hostFromSiteUrl(siteUrl);
    const label = cleanText(req.body?.label || host, 100);
    const id = crypto.randomUUID();
    const result = await q(
      `INSERT INTO wpgo_sites(id,account_id,site_url,site_host,label)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(account_id,site_url) DO UPDATE SET site_host=EXCLUDED.site_host,label=EXCLUDED.label
       RETURNING id,site_url,site_host,label,connected_at`,
      [id, req.account.id, siteUrl, host, label]
    );
    const issued = await issueLicenseForAccount(req.account);
    return res.json({
      ok: true,
      site: result.rows[0],
      license_key: issued.license_key,
      plan: accountPlan(req.account)
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/license/refresh', async (req, res, next) => {
  try {
    const validated = await accountFromLicense(req);
    if (!validated.ok) return res.status(validated.status).json({ ok: false, error: validated.error });
    const issued = await issueLicenseForAccount(validated.account);
    const authoritative = accountPlan(validated.account);
    return res.json({
      ok: true,
      site_url: validated.siteUrl,
      site_host: validated.siteHost,
      plan: authoritative,
      previous_token_plan: String(validated.license?.plan || ''),
      license_key: issued.license_key,
      record: issued.record
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/meter/check', async (req, res, next) => {
  try {
    const validated = await accountFromLicense(req);
    if (!validated.ok) return res.status(validated.status).json({ allowed: false, error: validated.error });
    const usage = await usageFor(validated.account);
    const state = planState(validated);
    const allowed = usage.unlimited || usage.remaining >= 1;
    return res.status(allowed ? 200 : 429).json({
      allowed,
      plan: state.plan,
      token_plan: state.token_plan,
      license_refresh_required: state.license_refresh_required,
      site_host: validated.siteHost,
      usage
    });
  } catch (error) {
    return next(error);
  }
});

async function meter(req, res, next) {
  try {
    const validated = await accountFromLicense(req);
    if (!validated.ok) return res.status(validated.status).json({ error: validated.error });
    const units = Math.max(1, Math.min(100, Number(req.body?.units || 1)));
    const operation = cleanText(req.body?.operation || '', 120);
    const success = req.body?.success !== false;
    const requestedHost = String(req.body?.site_host || '').trim().toLowerCase().replace(/^www\./, '');
    if (requestedHost && requestedHost !== validated.siteHost) {
      return res.status(409).json({ error: 'site_host_mismatch', expected_site_host: validated.siteHost });
    }
    const state = planState(validated);
    const consumed = await consumeUsage(validated.account, validated.siteHost, operation, units, success);
    if (consumed.limitReached) {
      return res.status(429).json({
        error: 'usage_limit_reached',
        plan: state.plan,
        token_plan: state.token_plan,
        license_refresh_required: state.license_refresh_required,
        usage: consumed.usage
      });
    }
    return res.json({
      ok: true,
      counted: consumed.counted,
      plan: state.plan,
      token_plan: state.token_plan,
      license_refresh_required: state.license_refresh_required,
      site_host: validated.siteHost,
      usage: consumed.usage
    });
  } catch (error) {
    return next(error);
  }
}
app.post('/v1/meter/record', meter);
app.post('/v1/meter/consume', meter);

app.post('/v1/support/ticket', supportLimit, async (req, res, next) => {
  try {
    const type = String(req.body?.type || 'contact').toLowerCase();
    if (!['contact', 'bug', 'feedback'].includes(type)) return res.status(400).json({ error: 'invalid_type' });
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    const name = cleanText(req.body?.name, 120);
    const subject = cleanText(req.body?.subject, 180);
    const message = cleanText(req.body?.message, 8000);
    if (message.length < 10) return res.status(400).json({ error: 'message_too_short' });
    const id = crypto.randomUUID();
    const ipHash = crypto.createHmac('sha256', sessionSecret)
      .update(String(req.ip || 'unknown'))
      .digest('hex')
      .slice(0, 24);
    await q(
      `INSERT INTO wpgo_support_tickets(
         id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,source_ip_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, type, email, name, subject, message,
        cleanText(req.body?.site_url, 500),
        cleanText(req.body?.wp_version, 40),
        cleanText(req.body?.wpgo_version, 40),
        cleanText(req.body?.browser, 500),
        cleanText(req.body?.severity, 40),
        ipHash
      ]
    );
    return res.status(201).json({ ok: true, ticket_id: id });
  } catch (error) {
    return next(error);
  }
});

app.get('/v1/support/tickets', authAccount, async (req, res, next) => {
  try {
    const founder = accountPlan(req.account).id === 'founder';
    const result = founder
      ? await q(`SELECT id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,status,created_at FROM wpgo_support_tickets ORDER BY created_at DESC LIMIT 100`)
      : await q(
          `SELECT id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,status,created_at
           FROM wpgo_support_tickets WHERE email=$1 ORDER BY created_at DESC LIMIT 50`,
          [normalizeEmail(req.account.email)]
        );
    return res.json({ tickets: result.rows });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/billing/checkout', authAccount, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const planId = String(req.body?.plan || '');
    if (!['solo', 'pro', 'agency', 'scale'].includes(planId)) return res.status(400).json({ error: 'invalid_plan' });
    if (accountPlan(req.account).id === 'founder') return res.status(409).json({ error: 'founder_is_unlimited' });
    if (req.account.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(String(req.account.subscription_status || ''))) {
      return res.status(409).json({ error: 'subscription_already_exists', use_billing_portal: true });
    }

    const billing = String(req.body?.billing || 'monthly') === 'yearly' ? 'yearly' : 'monthly';
    const envName = PRICE_ENV[planId]?.[billing];
    const price = envName ? process.env[envName] : '';
    if (!price) return res.status(503).json({ error: 'stripe_price_not_configured', plan: planId, billing });

    let customer = req.account.stripe_customer_id;
    if (!customer) {
      const created = await stripe.customers.create({
        email: req.account.email,
        metadata: { wpgo_account_id: req.account.id }
      });
      customer = created.id;
      await q(`UPDATE wpgo_accounts SET stripe_customer_id=$1,updated_at=NOW() WHERE id=$2`, [customer, req.account.id]);
    }

    const portalBase = String(process.env.WPGO_PORTAL_URL || 'https://wpgo-commercial-web.onrender.com').replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      success_url: `${portalBase}/account?checkout=success`,
      cancel_url: `${portalBase}/pricing?checkout=cancelled`,
      client_reference_id: req.account.id,
      metadata: { wpgo_account_id: req.account.id, wpgo_plan: planId, wpgo_billing: billing },
      subscription_data: {
        metadata: { wpgo_account_id: req.account.id, wpgo_plan: planId, wpgo_billing: billing }
      }
    });
    return res.json({ url: session.url, plan: planId, billing });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/billing/portal', authAccount, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    if (!req.account.stripe_customer_id) return res.status(409).json({ error: 'no_billing_account' });
    const portalBase = String(process.env.WPGO_PORTAL_URL || 'https://wpgo-commercial-web.onrender.com').replace(/\/$/, '');
    const session = await stripe.billingPortal.sessions.create({
      customer: req.account.stripe_customer_id,
      return_url: `${portalBase}/account`
    });
    return res.json({ url: session.url });
  } catch (error) {
    return next(error);
  }
});

app.post('/v1/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(503).send('stripe_not_configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', stripeWebhookSecret);
  } catch {
    return res.status(400).send('invalid_signature');
  }

  let claimed = false;
  try {
    const claim = await q(
      `INSERT INTO wpgo_stripe_events(event_id,event_type) VALUES($1,$2)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [String(event.id || ''), String(event.type || '')]
    );
    claimed = Boolean(claim.rows[0]);
    if (!claimed) return res.json({ received: true, duplicate: true });

    const mutation = billingMutationForEvent(event);
    if (mutation.kind === 'set_subscription') {
      await q(
        `UPDATE wpgo_accounts SET plan=$1,stripe_subscription_id=$2,subscription_status=$3,updated_at=NOW()
         WHERE id=$4 AND is_founder=FALSE`,
        [mutation.plan, mutation.subscription_id, mutation.status, mutation.account_id]
      );
    } else if (mutation.kind === 'cancel_subscription') {
      if (mutation.account_id) {
        await q(
          `UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status=$1,updated_at=NOW()
           WHERE id=$2 AND is_founder=FALSE`,
          [mutation.status, mutation.account_id]
        );
      } else if (mutation.subscription_id) {
        await q(
          `UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status=$1,updated_at=NOW()
           WHERE stripe_subscription_id=$2 AND is_founder=FALSE`,
          [mutation.status, mutation.subscription_id]
        );
      }
    } else if (mutation.kind === 'set_subscription_status') {
      await q(
        `UPDATE wpgo_accounts SET subscription_status=$1,updated_at=NOW()
         WHERE stripe_subscription_id=$2 AND is_founder=FALSE`,
        [mutation.status, mutation.subscription_id]
      );
    }

    await q(`UPDATE wpgo_stripe_events SET processed_at=NOW() WHERE event_id=$1`, [String(event.id || '')]);
    console.log(JSON.stringify({ event: 'stripe_webhook_processed', stripe_event: event.type, mutation: mutation.kind }));
    return res.json({ received: true, duplicate: false, mutation: mutation.kind });
  } catch (error) {
    if (claimed) await q(`DELETE FROM wpgo_stripe_events WHERE event_id=$1 AND processed_at IS NULL`, [String(event?.id || '')]).catch(() => {});
    console.error(JSON.stringify({ event: 'stripe_webhook_error', type: event?.type || '', message: String(error?.message || error).slice(0, 300) }));
    return res.status(500).send('webhook_processing_failed');
  }
});

app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    event: 'commercial_api_error',
    path: req.path,
    message: String(err?.message || err).slice(0, 500)
  }));
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
  return res.status(500).json({
    error: 'server_error',
    ...(devAuth && !production ? { message: String(err?.message || err) } : {})
  });
});

await initDb();
const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`WPGo commercial API ${VERSION} listening on ${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'commercial_api_shutdown', signal }));
  httpServer.close(async () => {
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
