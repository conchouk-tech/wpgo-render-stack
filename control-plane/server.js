import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

const VERSION = '4.2.2';
const port = Number(process.env.PORT || 8090);
const adminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const signingKeyPath = process.env.WPGO_SIGNING_KEY_PATH || '';
const storePath = process.env.WPGO_LICENSE_STORE || '';
const auditPath = process.env.WPGO_CONTROL_AUDIT_LOG || '';
const revokedIds = new Set(String(process.env.WPGO_REVOKED_LICENSE_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
const release = {
  version: process.env.WPGO_RELEASE_VERSION || VERSION,
  package: process.env.WPGO_RELEASE_PACKAGE || '',
  sha256: (process.env.WPGO_RELEASE_SHA256 || '').toLowerCase(),
  url: process.env.WPGO_RELEASE_URL || '',
  requires: process.env.WPGO_RELEASE_REQUIRES || '6.9',
  tested: process.env.WPGO_RELEASE_TESTED || '7.1.3',
  requires_php: process.env.WPGO_RELEASE_REQUIRES_PHP || '8.0',
  name: 'WPGo',
  sections: {
    description: 'Secure WordPress automation, commerce intelligence and fleet operations.',
    changelog: process.env.WPGO_RELEASE_CHANGELOG || 'See the bundled WPGo release notes.'
  }
};

function privateKeyPemFromSeed(seedText) {
  if (!seedText) return '';
  const seed = crypto.createHash('sha256').update(String(seedText)).digest();
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
}
function loadOrCreateSigningKey() {
  const fromEnv = (process.env.WPGO_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
  if (fromEnv) return fromEnv;
  const fromSeed = privateKeyPemFromSeed(process.env.WPGO_SIGNING_SEED || '');
  if (fromSeed) return fromSeed;
  if (!signingKeyPath) return '';
  try {
    if (fs.existsSync(signingKeyPath)) return fs.readFileSync(signingKeyPath, 'utf8');
    fs.mkdirSync(path.dirname(signingKeyPath), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(signingKeyPath, pem, { mode: 0o600 });
    return pem;
  } catch (error) {
    console.error('Unable to load/create signing key:', error?.message || error);
    return '';
  }
}
const privateKeyPem = loadOrCreateSigningKey();
const publicKey = privateKeyPem ? crypto.createPublicKey(privateKeyPem) : null;

let licenses = {};
function loadStore() {
  if (storePath && fs.existsSync(storePath)) {
    try { licenses = JSON.parse(fs.readFileSync(storePath, 'utf8')) || {}; return; } catch { licenses = {}; return; }
  }
  try { licenses = JSON.parse(process.env.WPGO_LICENSES_JSON || '{}') || {}; } catch { licenses = {}; }
}
function saveStore() {
  if (!storePath) return false;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(licenses, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  return true;
}
function audit(event, details = {}) {
  if (!auditPath) return;
  try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); fs.appendFileSync(auditPath, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n', { mode: 0o600 }); } catch {}
}
loadStore();

const hits = new Map();
function rateLimited(req, limit = 120, windowMs = 60000) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now(); const state = hits.get(key) || { start: now, count: 0 };
  if (now - state.start > windowMs) { state.start = now; state.count = 0; }
  state.count += 1; hits.set(key, state); return state.count > limit;
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])]));
  return value;
}
function canonical(value) { return JSON.stringify(sortDeep(value)); }
function sign(payload) {
  if (!privateKeyPem) return { payload, signature: '', signing: 'disabled' };
  return { payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), privateKeyPem).toString('base64'), signing: 'ed25519' };
}
function publicKeyBase64() {
  if (!publicKey) return '';
  const pub = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(pub).subarray(-32).toString('base64');
}
function bearer(req) { const v = req.get('authorization') || ''; return v.startsWith('Bearer ') ? v.slice(7).trim() : ''; }
function adminAuthorized(req) {
  if (!adminToken) return false;
  const a = crypto.createHash('sha256').update(bearer(req)).digest();
  const b = crypto.createHash('sha256').update(adminToken).digest();
  return crypto.timingSafeEqual(a, b);
}
function keyRef(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }
function siteHost(siteUrl) { try { return new URL(String(siteUrl || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function normalizeHosts(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/^www\./,'')).filter(v => /^[a-z0-9.*-]+(?:\.[a-z0-9-]+)*$/.test(v)))].slice(0, 25);
}
function cleanRecord(body = {}) {
  const expires = body.expires_gmt ? new Date(body.expires_gmt) : null;
  return {
    license_id: String(body.license_id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    status: ['active','revoked','suspended'].includes(String(body.status || 'active')) ? String(body.status || 'active') : 'active',
    plan: String(body.plan || 'starter').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    expires_gmt: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : '',
    features: Array.isArray(body.features) ? [...new Set(body.features.map(v => String(v).toLowerCase().replace(/[^a-z0-9_-]/g,'')).filter(Boolean))].slice(0,100) : [],
    site_hosts: normalizeHosts(body.site_hosts),
    issued_gmt: new Date().toISOString()
  };
}
function b64urlEncode(value) { return Buffer.from(value).toString('base64url'); }
function issueToken(record) {
  if (!privateKeyPem) throw new Error('signing_not_configured');
  const payload = b64urlEncode(canonical(record));
  const signingInput = `wpgo1.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKeyPem).toString('base64url');
  return `${signingInput}.${signature}`;
}
function parseToken(token) {
  if (!publicKey || typeof token !== 'string' || !token.startsWith('wpgo1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'wpgo1') return null;
  try {
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], 'base64url');
    if (!crypto.verify(null, Buffer.from(signingInput), publicKey, signature)) return null;
    const record = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch { return null; }
}
function licenseLookup(key) {
  const stored = licenses[key];
  if (stored && typeof stored === 'object') return { record: stored, source: 'store' };
  const token = parseToken(key);
  if (token) return { record: token, source: 'signed-token' };
  return { record: null, source: 'none' };
}
function activeStatus(record, requestedSite = '') {
  if (!record) return 'invalid';
  if (record.license_id && revokedIds.has(String(record.license_id))) return 'revoked';
  if (record.status && record.status !== 'active') return String(record.status);
  if (record.expires_gmt && Date.parse(record.expires_gmt) < Date.now()) return 'expired';
  const allowed = normalizeHosts(record.site_hosts);
  const host = siteHost(requestedSite);
  if (allowed.length && !allowed.includes('*') && host && !allowed.includes(host)) return 'site_mismatch';
  return 'active';
}

app.use((req, res, next) => {
  res.set('Cache-Control','no-store');
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','no-referrer');
  res.set('X-Frame-Options','DENY');
  if (rateLimited(req)) return res.status(429).json({ error:'rate_limited' });
  next();
});
app.get('/health', (_req,res) => res.json({
  ok:true,
  service:'wpgo-control-plane',
  version:VERSION,
  signing:privateKeyPem?'ed25519':'disabled',
  persistent_store:Boolean(storePath),
  stateless_signed_licenses:Boolean(privateKeyPem),
  revocation_denylist:true,
  release_hash:Boolean(release.sha256)
}));
app.get('/v1/capabilities', (_req,res) => res.json(sign({
  version:VERSION,
  signing:privateKeyPem?'ed25519':'disabled',
  license_modes:[...(storePath?['persistent-store']:[]), ...(privateKeyPem?['signed-token']:[])],
  site_binding:true,
  revocation_denylist:true,
  signed_updates:true,
  package_hash_verification:true
})));
app.get('/v1/public-key', (_req,res) => { const key=publicKeyBase64(); if(!key)return res.status(404).json({error:'signing_not_configured'}); res.json({algorithm:'ed25519',public_key:key}); });
app.post('/v1/license/validate', (req,res) => {
  const key=String(req.body?.license_key || '').trim();
  const site=String(req.body?.site_url || '');
  const { record, source }=licenseLookup(key);
  const status=activeStatus(record, site);
  const payload={
    status,
    plan:record?.plan || '',
    expires_gmt:record?.expires_gmt || '',
    features:Array.isArray(record?.features)?record.features:[],
    license_id:record?.license_id || '',
    source,
    site_url:site,
    checked_gmt:new Date().toISOString()
  };
  audit('license_validate',{ key_ref:keyRef(key), license_id:record?.license_id || '', source, status, site_host:siteHost(site) });
  res.status(status==='invalid'?403:200).json(sign(payload));
});
app.get('/v1/update/manifest', (req,res) => {
  const key=bearer(req);
  const site=String(req.get('X-WPGo-Site') || '');
  const { record, source }=licenseLookup(key);
  const status=activeStatus(record, site);
  if(status!=='active') return res.status(403).json(sign({ status, message:'A valid active WPGo license is required for commercial updates.' }));
  if(!release.package || !/^[a-f0-9]{64}$/.test(release.sha256)) return res.status(503).json(sign({ status:'unavailable', message:'No release package with SHA-256 is configured.' }));
  audit('update_manifest',{ key_ref:keyRef(key), license_id:record?.license_id || '', source, version:release.version });
  res.json(sign(release));
});
app.get('/v1/admin/license-summary', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  const rows=Object.values(licenses).reduce((acc,r)=>{const s=activeStatus(r);acc[s]=(acc[s]||0)+1;return acc;},{});
  res.json({counts:rows,total:Object.keys(licenses).length,persistent_store:Boolean(storePath),stateless_signed_licenses:Boolean(privateKeyPem),revoked_ids:revokedIds.size});
});
app.post('/v1/admin/license/issue', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  if(!privateKeyPem) return res.status(503).json({error:'signing_not_configured'});
  const record=cleanRecord(req.body || {});
  const licenseKey=issueToken(record);
  audit('license_issue',{license_id:record.license_id,plan:record.plan,site_hosts:record.site_hosts});
  res.json({ok:true,license_key:licenseKey,key_ref:keyRef(licenseKey),record});
});
app.post('/v1/admin/license/upsert', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  if(!storePath) return res.status(409).json({error:'persistent_store_not_configured',message:'Use /v1/admin/license/issue for durable signed-token licenses without a database.'});
  const key=String(req.body?.license_key||'').trim(); if(key.length<8||key.length>4096)return res.status(400).json({error:'invalid_license_key'});
  licenses[key]=cleanRecord(req.body); saveStore(); audit('license_upsert',{key_ref:keyRef(key),license_id:licenses[key].license_id,status:licenses[key].status,plan:licenses[key].plan});
  res.json({ok:true,key_ref:keyRef(key),record:licenses[key],persisted:true});
});
app.post('/v1/admin/license/revoke', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  const key=String(req.body?.license_key||'').trim();
  if(licenses[key] && storePath){ licenses[key]={...licenses[key],status:'revoked'}; saveStore(); audit('license_revoke',{key_ref:keyRef(key),license_id:licenses[key].license_id||''}); return res.json({ok:true,key_ref:keyRef(key),persisted:true}); }
  const token=parseToken(key);
  if(token?.license_id) return res.status(409).json({error:'stateless_revocation_requires_denylist',license_id:String(token.license_id),message:'Add the license_id to WPGO_REVOKED_LICENSE_IDS and redeploy.'});
  return res.status(404).json({error:'not_found'});
});
app.post('/v1/admin/reload-store', (req,res) => { if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'}); loadStore(); res.json({ok:true,total:Object.keys(licenses).length}); });

app.listen(port,'0.0.0.0',()=>console.log(`WPGo control plane ${VERSION} listening on ${port}`));
