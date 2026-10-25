import express from 'express';
import crypto from 'node:crypto';

const app = express();
const VERSION = '1.6.0';
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 8080);
const apiBase = String(process.env.WPGO_COMMERCIAL_API || 'https://wpgo-commercial-api.onrender.com').replace(/\/$/, '');
const csrfSecret = String(process.env.WPGO_PORTAL_CSRF_SECRET || '');
const SESSION_COOKIE = '__Host-wpgo_session';

if (production) {
  const api = new URL(apiBase);
  if (api.protocol !== 'https:') throw new Error('WPGO_COMMERCIAL_API must use HTTPS in production.');
  if (csrfSecret.length < 32) throw new Error('WPGO_PORTAL_CSRF_SECRET must be at least 32 characters in production.');
}

const plans = [
  { id: 'free', name: 'Free', monthly: 0, yearly: 0, calls: 100, desc: 'Try WPGo properly, with no payment method required.' },
  { id: 'solo', name: 'Solo', monthly: 5.95, yearly: 60.69, calls: 750, desc: 'Everyday WordPress work for individuals.', popular: true },
  { id: 'pro', name: 'Pro', monthly: 12.95, yearly: 132.09, calls: 2500, desc: 'Serious site building, WooCommerce and iterative work.' },
  { id: 'agency', name: 'Agency', monthly: 24.95, yearly: 254.49, calls: 7500, desc: 'Client work, teams and heavier multi-site days.' },
  { id: 'scale', name: 'Scale', monthly: 39.95, yearly: 407.49, calls: 15000, desc: 'High-volume workflows and automation.' }
];

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return ''; }
    }
  }
  return '';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function csrfFor(session) {
  if (!session || !csrfSecret) return '';
  return crypto.createHmac('sha256', csrfSecret).update(session).digest('base64url');
}

function validCsrf(req, session) {
  return Boolean(session && safeEqual(req.body?.csrf, csrfFor(session)));
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error'
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      data: { error: 'commercial_api_unavailable', message: String(error?.message || error) }
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeReturn(value) {
  const text = String(value || '');
  return text.startsWith('/connect?') ? text : '/account';
}

function normalizeSiteUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url;
  } catch {
    return null;
  }
}

function validPair(raw) {
  try {
    const site = normalizeSiteUrl(raw.site_url);
    const callback = new URL(String(raw.callback || ''));
    const state = String(raw.state || '');
    if (!site || callback.protocol !== 'https:' || callback.username || callback.password) return null;
    if (callback.origin !== site.origin || callback.search || callback.hash) return null;
    if (state.length < 20 || state.length > 500) return null;
    const expectedCallback = `${site.pathname}wp-json/wpgo/v1/account/pair-callback`.replace(/\/{2,}/g, '/');
    if (callback.pathname !== expectedCallback) return null;
    return {
      site_url: site.toString(),
      callback: callback.toString(),
      state
    };
  } catch {
    return null;
  }
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
      return res.status(429).send('Too many requests.');
    }
    return next();
  };
}

const css = `:root{--bg:#071016;--panel:#0d1a22;--text:#f5f8fa;--muted:#9fb0ba;--line:#1f3541;--mint:#76e6bc;--mint2:#a0f5d5;--blue:#8abaff;--max:1180px}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 84% 0,#133447 0,transparent 34%),linear-gradient(#071016,#09151c 72%,#071016);color:var(--text);font:16px/1.6 Inter,system-ui,-apple-system,Segoe UI,sans-serif}a{color:inherit;text-decoration:none}button,input,textarea,select{font:inherit}.nav{height:76px;display:flex;align-items:center;gap:28px;max-width:var(--max);margin:auto;padding:0 24px}.brand{display:flex;gap:10px;align-items:center;font-size:21px;font-weight:900}.mark{width:35px;height:35px;border-radius:11px;background:linear-gradient(145deg,var(--mint),var(--blue));display:grid;place-items:center;color:#06120e;font-weight:900}.nav nav{display:flex;gap:24px;margin-left:auto}.nav nav a,.ghost{font-size:14px;color:var(--muted)}.actions{display:flex;gap:10px;align-items:center}.btn{border:0;cursor:pointer;display:inline-flex;justify-content:center;align-items:center;padding:12px 17px;border-radius:12px;background:linear-gradient(135deg,var(--mint),var(--mint2));color:#04140e;font-weight:850}.btn.secondary{background:#10232d;color:var(--text);border:1px solid var(--line)}.hero{max-width:var(--max);margin:auto;padding:95px 24px 55px;text-align:center}.tag{display:inline-block;border:1px solid #28505d;background:#0c2028;color:var(--mint2);border-radius:999px;padding:6px 11px;font-size:13px;font-weight:750}.hero h1{font-size:clamp(46px,7vw,78px);line-height:1;letter-spacing:-.05em;max-width:980px;margin:24px auto}.gradient{background:linear-gradient(90deg,var(--mint2),#cde7ff);-webkit-background-clip:text;color:transparent}.hero p,.lead{color:var(--muted);font-size:19px;max-width:760px}.hero p{margin:auto}.section{max-width:var(--max);margin:auto;padding:68px 24px}.section h2{font-size:clamp(32px,5vw,50px);line-height:1.05;letter-spacing:-.035em;margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:30px}.card{border:1px solid var(--line);border-radius:20px;padding:24px;background:linear-gradient(180deg,var(--panel),#09151c)}.card h3{margin:8px 0}.card p{margin:0 0 10px;color:var(--muted)}.pricing{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:30px}.price{position:relative}.badge{position:absolute;right:12px;top:12px;background:var(--mint);color:#062015;font-weight:900;padding:3px 7px;border-radius:999px;font-size:11px}.amount{font-size:32px;font-weight:950}.calls{margin:16px 0;color:var(--mint2);font-weight:800}.formbox{max-width:680px;margin:60px auto}.field{display:block;width:100%;background:#071118;border:1px solid var(--line);border-radius:12px;padding:13px;color:var(--text);margin:7px 0 15px}.textarea{min-height:160px;resize:vertical}.msg{margin:14px 0;padding:12px;border-radius:12px;background:#0b2128;color:#cce7e1;border:1px solid #24434d}.bad{color:#ffd3d3;border-color:#6c3333;background:#241416}.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:16px}.stat{font-size:36px;font-weight:950}.site,.ticket{display:flex;justify-content:space-between;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);align-items:flex-start}.license{word-break:break-all;background:#061016;border:1px solid var(--line);padding:12px;border-radius:12px;font-family:ui-monospace,monospace;font-size:12px}.small{font-size:13px;color:var(--muted)}.choice{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.choice a{flex:1;min-width:120px}footer{max-width:var(--max);margin:70px auto 0;padding:38px 24px;border-top:1px solid var(--line);color:var(--muted)}@media(max-width:900px){.nav nav{display:none}.pricing,.grid,.dashboard{grid-template-columns:1fr 1fr}}@media(max-width:620px){.pricing,.grid,.dashboard{grid-template-columns:1fr}.hero h1{font-size:46px}.actions .ghost{display:none}}`;
const nav = `<header class="nav"><a class="brand" href="https://wpgo.vivaforte.es/"><span class="mark">W</span>WPGo</a><nav><a href="https://wpgo.vivaforte.es/features/">Features</a><a href="https://wpgo.vivaforte.es/pricing/">Pricing</a><a href="https://wpgo.vivaforte.es/docs/">Docs</a><a href="https://wpgo.vivaforte.es/security/">Security</a><a href="/support">Support</a></nav><div class="actions"><a class="ghost" href="/account">Account</a><a class="btn" href="/start">Start free</a></div></header>`;
function shell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · WPGo</title><style>${css}</style></head><body>${nav}<main>${body}</main><footer><strong>WPGo</strong> · Your AI, safely connected to WordPress. · <a href="https://wpgo.vivaforte.es/privacy/">Privacy</a> · <a href="https://wpgo.vivaforte.es/terms/">Terms</a> · © ${new Date().getFullYear()}</footer></body></html>`;
}
function msg(text, bad = false) {
  return text ? `<div class="msg${bad ? ' bad' : ''}">${esc(text)}</div>` : '';
}
function priceCards() {
  return plans.map(plan => `<div class="card price">${plan.popular ? '<span class="badge">Popular</span>' : ''}<h3>${plan.name}</h3><div><span class="amount">€${plan.monthly ? plan.monthly.toFixed(2) : '0'}</span><span class="small"> / month</span></div>${plan.id !== 'free' ? `<div class="small">or €${plan.yearly.toFixed(2)} / year · save 15%</div>` : ''}<div class="calls">${plan.calls.toLocaleString()} actions / rolling 24h</div><p>${plan.desc}</p><div class="choice">${plan.id === 'free' ? `<a class="btn" href="/start?plan=free">Start free</a>` : `<a class="btn secondary" href="/start?plan=${plan.id}&billing=monthly">Monthly</a><a class="btn" href="/start?plan=${plan.id}&billing=yearly">Yearly</a>`}</div></div>`).join('');
}

function startPage({ plan = 'free', billing = 'monthly', email = '', codeStage = false, devCode = '', notice = '', bad = false, returnTo = '/account' } = {}) {
  const chosen = plans.some(item => item.id === plan) ? plan : 'free';
  const period = billing === 'yearly' ? 'yearly' : 'monthly';
  const ret = safeReturn(returnTo);
  return shell('Start', `<section class="section"><div class="card formbox"><span class="tag">WPGo account</span><h2>${codeStage ? 'Enter your sign-in code.' : 'Start with your email.'}</h2>${chosen !== 'free' ? `<p class="lead">${esc(chosen)} · ${period === 'yearly' ? 'yearly billing, save 15%' : 'monthly billing'}</p>` : ''}${msg(notice, bad)}${!codeStage ? `<form method="post" action="/start/request-code"><input type="hidden" name="plan" value="${esc(chosen)}"><input type="hidden" name="billing" value="${period}"><input type="hidden" name="return_to" value="${esc(ret)}"><label>Email</label><input name="email" class="field" type="email" required value="${esc(email)}"><button class="btn" style="width:100%">Continue</button></form>` : `<form method="post" action="/start/verify-code"><input type="hidden" name="plan" value="${esc(chosen)}"><input type="hidden" name="billing" value="${period}"><input type="hidden" name="return_to" value="${esc(ret)}"><input type="hidden" name="email" value="${esc(email)}"><label>Six-digit code</label><input name="code" class="field" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required><button class="btn" style="width:100%">Sign in</button></form>${devCode ? `<div class="msg">Development preview code: <strong>${esc(devCode)}</strong></div>` : ''}`}</div></section>`);
}

async function accountPage(req, { notice = '', bad = false, licenseKey = '' } = {}) {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const [accountResult, sitesResult, ticketsResult] = await Promise.all([
    api('/v1/account', { token }),
    api('/v1/account/sites', { token }),
    api('/v1/support/tickets', { token })
  ]);
  if (!accountResult.ok) return null;
  const account = accountResult.data.account;
  const plan = account.plan;
  const usage = account.usage;
  const sites = sitesResult.ok ? (sitesResult.data.sites || []) : [];
  const tickets = ticketsResult.ok ? (ticketsResult.data.tickets || []) : [];
  const csrf = csrfFor(token);
  const siteHtml = sites.length
    ? sites.map(site => `<div class="site"><div><strong>${esc(site.label || site.site_host)}</strong><br><span class="small">${esc(site.site_url || site.site_host)}</span></div><form method="post" action="/account/license"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn secondary">Generate licence</button></form></div>`).join('')
    : '<p>No sites connected yet.</p>';
  const ticketHtml = tickets.length
    ? tickets.slice(0, 12).map(ticket => `<div class="ticket"><div><strong>${esc(ticket.type)} · ${esc(ticket.subject || 'No subject')}</strong><br><span class="small">${esc(ticket.email)} · ${esc(new Date(ticket.created_at).toLocaleString())}</span><p>${esc(String(ticket.message || '').slice(0, 220))}${String(ticket.message || '').length > 220 ? '…' : ''}</p></div><span class="tag">${esc(ticket.status)}</span></div>`).join('')
    : '<p>No support submissions yet.</p>';

  return shell('Account', `<section class="section"><span class="tag">WPGo Account</span><h2>${esc(account.email)}</h2>${msg(notice, bad)}<div class="dashboard"><div class="card"><h3>Plan</h3><div class="stat">${esc(plan.name)}</div><p>${usage.unlimited ? 'Unlimited founder usage' : `${Number(usage.used || 0).toLocaleString()} of ${Number(usage.allowance || 0).toLocaleString()} actions used`}</p></div><div class="card"><h3>Connected sites</h3><div class="stat">${sites.length}</div><p>Pair from WordPress or register a site manually.</p></div></div><div class="grid" style="grid-template-columns:1.2fr .8fr"><div class="card"><h3>Your sites</h3>${siteHtml}<form method="post" action="/account/sites/register" style="margin-top:18px"><input type="hidden" name="csrf" value="${esc(csrf)}"><input name="site_url" class="field" type="url" required placeholder="https://example.com"><input name="label" class="field" placeholder="Site label (optional)"><button class="btn">Connect site</button></form>${licenseKey ? `<div class="msg"><strong>Signed licence generated.</strong> Manual fallback only.</div><div class="license">${esc(licenseKey)}</div>` : ''}</div><div class="card"><h3>Billing & plan</h3><p>${plan.id === 'founder' ? 'Founder account · permanently unlimited · no billing required.' : 'Stripe manages paid subscriptions securely.'}</p>${plan.id === 'founder' ? '' : `<form method="post" action="/account/billing"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn secondary" style="width:100%;margin-top:16px">Manage billing</button></form>`}<a class="btn secondary" style="width:100%;margin-top:12px" href="https://wpgo.vivaforte.es/pricing/">Change plan</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn secondary" style="width:100%;margin-top:12px">Sign out</button></form></div></div>${plan.id === 'founder' ? `<div class="card" style="margin-top:16px"><h3>Support inbox</h3><p class="small">Founder view of recent contact, bug and feedback submissions.</p>${ticketHtml}</div>` : ''}</section>`);
}

function supportForm(type, { notice = '', bad = false, values = {} } = {}) {
  const config = {
    contact: { title: 'Contact WPGo', lead: 'Account, billing, setup or pre-sales question.' },
    bug: { title: 'Report a bug', lead: 'Tell us what happened, what you expected and how to reproduce it.' },
    feedback: { title: 'Share feedback', lead: 'Ideas, missing workflows and product feedback are welcome.' }
  }[type];
  return shell(config.title, `<section class="section"><div class="card formbox"><span class="tag">WPGo Support</span><h2>${config.title}</h2><p class="lead">${config.lead}</p>${msg(notice, bad)}<form method="post" action="/support/${type}"><label>Name</label><input class="field" name="name" maxlength="120" value="${esc(values.name || '')}"><label>Email *</label><input class="field" name="email" type="email" required value="${esc(values.email || '')}"><label>Subject</label><input class="field" name="subject" maxlength="180" value="${esc(values.subject || '')}">${type === 'bug' ? `<div class="grid" style="grid-template-columns:1fr 1fr"><div><label>Site URL</label><input class="field" name="site_url" type="url" value="${esc(values.site_url || '')}"></div><div><label>Severity</label><select class="field" name="severity"><option>normal</option><option>high</option><option>critical</option></select></div><div><label>WordPress version</label><input class="field" name="wp_version" value="${esc(values.wp_version || '')}"></div><div><label>WPGo version</label><input class="field" name="wpgo_version" value="${esc(values.wpgo_version || '')}"></div></div>` : ''}<label>Message *</label><textarea class="field textarea" name="message" required maxlength="8000">${esc(values.message || '')}</textarea><button class="btn" style="width:100%">Send ${type === 'bug' ? 'bug report' : type}</button></form><p class="small" style="margin-top:16px">Do not include passwords, API keys, Application Passwords or licence tokens.</p></div></section>`);
}

const pricingPage = shell('Pricing', `<section class="hero"><span class="tag">Pricing</span><h1>Monthly flexibility. <span class="gradient">15% off yearly.</span></h1><p>Successful WPGo actions count. Failed calls do not.</p></section><section class="section" style="padding-top:0"><div class="pricing">${priceCards()}</div></section>`);
const supportHome = shell('Support', `<section class="hero"><span class="tag">Support centre</span><h1>Get help. Report bugs. <span class="gradient">Shape WPGo.</span></h1></section><section class="section"><div class="grid"><div class="card"><h3>Contact</h3><p>Setup, billing, account and pre-sales questions.</p><a class="btn" href="/support/contact">Contact WPGo</a></div><div class="card"><h3>Bug report</h3><p>Send reproducible product issues with useful environment details.</p><a class="btn" href="/support/bug">Report a bug</a></div><div class="card"><h3>Feedback</h3><p>Tell us what WPGo should do next.</p><a class="btn" href="/support/feedback">Share feedback</a></div></div></section>`);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(createRateLimiter({ windowMs: 60_000, max: 240 }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'");
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/', (_req, res) => res.redirect(302, 'https://wpgo.vivaforte.es/'));
app.get('/pricing', (_req, res) => res.send(pricingPage));
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'wpgo-commercial-portal',
  version: VERSION,
  auth_flow: 'server-backed',
  pairing_confirmation: true,
  csrf_protection: true,
  annual_billing: true,
  support_centre: true
}));

app.get('/start', (req, res) => res.send(startPage({
  plan: String(req.query.plan || 'free'),
  billing: String(req.query.billing || 'monthly'),
  returnTo: String(req.query.return_to || '/account')
})));

app.post('/start/request-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const plan = String(req.body.plan || 'free');
  const billing = String(req.body.billing || 'monthly');
  const returnTo = safeReturn(req.body.return_to);
  const result = await api('/v1/auth/request-code', { method: 'POST', body: { email } });
  if (!result.ok) {
    return res.status(result.status).send(startPage({
      plan, billing, email, returnTo,
      notice: result.data.error || 'Could not create sign-in code.',
      bad: true
    }));
  }
  return res.send(startPage({
    plan, billing, email, returnTo, codeStage: true,
    devCode: result.data.dev_code || '',
    notice: result.data.dev_code ? 'Your development sign-in code is ready below.' : 'Check your email for your WPGo code.'
  }));
});

app.post('/start/verify-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const plan = String(req.body.plan || 'free');
  const billing = String(req.body.billing || 'monthly');
  const returnTo = safeReturn(req.body.return_to);
  const result = await api('/v1/auth/verify-code', { method: 'POST', body: { email, code } });
  if (!result.ok) {
    return res.status(result.status).send(startPage({
      plan, billing, email, returnTo, codeStage: true,
      notice: 'That code is invalid or expired.',
      bad: true
    }));
  }
  const token = result.data.token;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  if (returnTo !== '/account') return res.redirect(303, returnTo);
  if (plan !== 'free' && plan !== 'founder') {
    const billingResult = await api('/v1/billing/checkout', { method: 'POST', body: { plan, billing }, token });
    if (billingResult.ok && billingResult.data.url) return res.redirect(303, billingResult.data.url);
    return res.redirect(303, `/account?notice=${encodeURIComponent(billingResult.data.error || 'Billing is not configured yet.')}`);
  }
  return res.redirect(303, '/account');
});

app.get('/connect', (req, res) => {
  const pair = validPair(req.query);
  if (!pair) {
    return res.status(400).send(shell('Connect', '<section class="section"><div class="card formbox"><h2>Invalid pairing request</h2><p>Start again from WordPress → Tools → WPGo.</p></div></section>'));
  }
  const token = cookie(req, SESSION_COOKIE);
  const returnTo = `/connect?site_url=${encodeURIComponent(pair.site_url)}&callback=${encodeURIComponent(pair.callback)}&state=${encodeURIComponent(pair.state)}`;
  if (!token) return res.redirect(302, `/start?return_to=${encodeURIComponent(returnTo)}`);
  const csrf = csrfFor(token);
  const host = new URL(pair.site_url).host;
  return res.send(shell('Connect', `<section class="section"><div class="card formbox"><span class="tag">Secure pairing</span><h2>Connect ${esc(host)}?</h2><p class="lead">WPGo will register this WordPress site to your account and return a signed licence directly to it.</p><form method="post" action="/connect"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="site_url" value="${esc(pair.site_url)}"><input type="hidden" name="callback" value="${esc(pair.callback)}"><input type="hidden" name="state" value="${esc(pair.state)}"><button class="btn" style="width:100%">Connect this site</button></form><p class="small" style="margin-top:16px">Only continue if you recognise this site.</p></div></section>`));
});

app.post('/connect', async (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return res.redirect(303, '/start');
  if (!validCsrf(req, token)) return res.status(403).send(shell('Connect', '<section class="section"><div class="card formbox"><h2>Connection expired</h2><p>Start pairing again from WordPress.</p></div></section>'));
  const pair = validPair(req.body);
  if (!pair) return res.status(400).send(shell('Connect', '<section class="section"><div class="card formbox"><h2>Invalid pairing request</h2><p>Start again from WordPress → Tools → WPGo.</p></div></section>'));
  const registration = await api('/v1/sites/register', {
    method: 'POST',
    body: { site_url: pair.site_url, label: new URL(pair.site_url).host },
    token
  });
  if (!registration.ok) {
    return res.status(registration.status).send(shell('Connect', `<section class="section"><div class="card formbox"><h2>Could not connect site</h2>${msg(registration.data.error || registration.data.message || 'Pairing failed.', true)}</div></section>`));
  }
  const nonce = crypto.randomBytes(18).toString('base64url');
  res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action https:; base-uri 'none'; frame-ancestors 'none'`);
  return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting WPGo</title><style>${css}</style></head><body><main><section class="section"><div class="card formbox"><span class="tag">Secure pairing</span><h2>Finishing connection…</h2><p class="lead">Your signed licence is being returned directly to WordPress.</p><form id="pair" method="post" action="${esc(pair.callback)}"><input type="hidden" name="state" value="${esc(pair.state)}"><input type="hidden" name="license_key" value="${esc(registration.data.license_key || '')}"><button class="btn" type="submit">Finish connection</button></form></div></section></main><script nonce="${nonce}">document.getElementById('pair').submit();</script></body></html>`);
});

app.get('/account', async (req, res) => {
  const page = await accountPage(req, { notice: String(req.query.notice || '') });
  if (!page) return res.redirect(302, '/start');
  return res.send(page);
});

app.post('/account/sites/register', async (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return res.redirect(303, '/start');
  if (!validCsrf(req, token)) return res.status(403).send('Invalid request.');
  const result = await api('/v1/sites/register', {
    method: 'POST',
    body: { site_url: String(req.body.site_url || ''), label: String(req.body.label || '') },
    token
  });
  const page = await accountPage(req, {
    notice: result.ok ? 'Site connected successfully.' : (result.data.error || 'Could not connect site.'),
    bad: !result.ok,
    licenseKey: result.ok ? result.data.license_key : ''
  });
  return res.status(result.ok ? 200 : result.status).send(page);
});

app.post('/account/license', async (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return res.redirect(303, '/start');
  if (!validCsrf(req, token)) return res.status(403).send('Invalid request.');
  const result = await api('/v1/account/license', { method: 'POST', body: {}, token });
  const page = await accountPage(req, {
    notice: result.ok ? 'New signed licence generated.' : (result.data.error || 'Could not generate licence.'),
    bad: !result.ok,
    licenseKey: result.ok ? result.data.license_key : ''
  });
  return res.status(result.ok ? 200 : result.status).send(page);
});

app.post('/account/billing', async (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return res.redirect(303, '/start');
  if (!validCsrf(req, token)) return res.status(403).send('Invalid request.');
  const result = await api('/v1/billing/portal', { method: 'POST', body: {}, token });
  if (result.ok && result.data.url) return res.redirect(303, result.data.url);
  return res.redirect(303, `/account?notice=${encodeURIComponent(result.data.error || 'Billing is not configured yet.')}`);
});

app.get('/support', (_req, res) => res.send(supportHome));
for (const type of ['contact', 'bug', 'feedback']) {
  app.get(`/support/${type}`, (_req, res) => res.send(supportForm(type)));
  app.post(`/support/${type}`, async (req, res) => {
    const body = {
      type,
      name: String(req.body.name || ''),
      email: String(req.body.email || ''),
      subject: String(req.body.subject || ''),
      message: String(req.body.message || ''),
      site_url: String(req.body.site_url || ''),
      wp_version: String(req.body.wp_version || ''),
      wpgo_version: String(req.body.wpgo_version || ''),
      severity: String(req.body.severity || ''),
      browser: String(req.get('user-agent') || '')
    };
    const result = await api('/v1/support/ticket', { method: 'POST', body });
    if (!result.ok) {
      return res.status(result.status).send(supportForm(type, {
        notice: result.data.error || 'Could not submit this form.',
        bad: true,
        values: body
      }));
    }
    return res.send(supportForm(type, { notice: `Thank you. Your ticket ID is ${result.data.ticket_id}.` }));
  });
}

app.post('/logout', (req, res) => {
  const token = cookie(req, SESSION_COOKIE);
  if (!token || !validCsrf(req, token)) return res.status(403).send('Invalid request.');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res.redirect(303, 'https://wpgo.vivaforte.es/');
});

app.use((req, res) => res.status(404).send(shell('Not found', '<section class="section"><div class="card formbox"><h2>Page not found</h2><a class="btn" href="https://wpgo.vivaforte.es/">Go to WPGo</a></div></section>')));
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ event: 'portal_error', path: req.path, message: String(err?.message || err).slice(0, 300) }));
  if (res.headersSent) return next(err);
  return res.status(500).send(shell('Error', '<section class="section"><div class="card formbox"><h2>Something went wrong</h2><p>Please try again.</p></div></section>'));
});

const server = app.listen(port, '0.0.0.0', () => console.log(`WPGo commercial portal ${VERSION} listening on ${port}`));
function shutdown(signal) {
  console.log(JSON.stringify({ event: 'portal_shutdown', signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
