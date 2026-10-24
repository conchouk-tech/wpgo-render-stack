import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const VERSION = '4.1.0';
const port = Number(process.env.PORT || 8090);
const adminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const signingKeyPath = process.env.WPGO_SIGNING_KEY_PATH || '';
function loadOrCreateSigningKey() {
  const fromEnv = (process.env.WPGO_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
  if (fromEnv) return fromEnv;
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
const storePath = process.env.WPGO_LICENSE_STORE || '';
const auditPath = process.env.WPGO_CONTROL_AUDIT_LOG || '';
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
function sign(payload) {
  if (!privateKeyPem) return { payload, signature: '', signing: 'disabled' };
  const canonical = JSON.stringify(sortDeep(payload));
  return { payload, signature: crypto.sign(null, Buffer.from(canonical), privateKeyPem).toString('base64'), signing: 'ed25519' };
}
function publicKeyBase64() {
  if (!privateKeyPem) return '';
  const pub = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  return Buffer.from(pub).subarray(-32).toString('base64');
}
function bearer(req) { const v = req.get('authorization') || ''; return v.startsWith('Bearer ') ? v.slice(7) : ''; }
function adminAuthorized(req) { if(!adminToken)return false; const a=crypto.createHash('sha256').update(bearer(req)).digest(); const b=crypto.createHash('sha256').update(adminToken).digest(); return crypto.timingSafeEqual(a,b); }
function licenseRecord(key) { const item = licenses[key]; return item && typeof item === 'object' ? item : null; }
function activeStatus(record) {
  if (!record) return 'invalid';
  if (record.status && record.status !== 'active') return String(record.status);
  if (record.expires_gmt && Date.parse(record.expires_gmt) < Date.now()) return 'expired';
  return 'active';
}
function keyRef(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }
function cleanRecord(body = {}) {
  return {
    status: ['active','revoked','suspended'].includes(String(body.status || 'active')) ? String(body.status || 'active') : 'active',
    plan: String(body.plan || 'pro').slice(0, 80),
    expires_gmt: body.expires_gmt ? new Date(body.expires_gmt).toISOString() : '',
    features: Array.isArray(body.features) ? [...new Set(body.features.map(v => String(v).toLowerCase().replace(/[^a-z0-9_-]/g,'')).filter(Boolean))].slice(0,100) : []
  };
}

app.use((req, res, next) => {
  res.set('Cache-Control','no-store'); res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','no-referrer');
  if (rateLimited(req)) return res.status(429).json({ error:'rate_limited' }); next();
});
app.get('/health', (_req,res) => res.json({ ok:true, service:'wpgo-control-plane', version:VERSION, signing:privateKeyPem?'ed25519':'disabled', persistent_store:Boolean(storePath), release_hash:Boolean(release.sha256) }));
app.get('/v1/public-key', (_req,res) => { const key=publicKeyBase64(); if(!key)return res.status(404).json({error:'signing_not_configured'}); res.json({algorithm:'ed25519',public_key:key}); });
app.post('/v1/license/validate', (req,res) => {
  const key=String(req.body?.license_key || '').trim(); const record=licenseRecord(key); const status=activeStatus(record);
  const payload={ status, plan:record?.plan || '', expires_gmt:record?.expires_gmt || '', features:Array.isArray(record?.features)?record.features:[], site_url:String(req.body?.site_url||''), checked_gmt:new Date().toISOString() };
  audit('license_validate',{ key_ref:keyRef(key), status, site_host:(()=>{try{return new URL(String(req.body?.site_url||'')).hostname}catch{return''}})() });
  res.status(status==='invalid'?403:200).json(sign(payload));
});
app.get('/v1/update/manifest', (req,res) => {
  const key=bearer(req); const record=licenseRecord(key); const status=activeStatus(record);
  if(status!=='active') return res.status(403).json(sign({ status, message:'A valid active WPGo license is required for commercial updates.' }));
  if(!release.package || !/^[a-f0-9]{64}$/.test(release.sha256)) return res.status(503).json(sign({ status:'unavailable', message:'No release package with SHA-256 is configured.' }));
  audit('update_manifest',{ key_ref:keyRef(key), version:release.version });
  res.json(sign(release));
});
app.get('/v1/admin/license-summary', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  const rows=Object.values(licenses).reduce((acc,r)=>{const s=activeStatus(r);acc[s]=(acc[s]||0)+1;return acc;},{}); res.json({counts:rows,total:Object.keys(licenses).length,persistent_store:Boolean(storePath)});
});
app.post('/v1/admin/license/upsert', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  const key=String(req.body?.license_key||'').trim(); if(key.length<8||key.length>255)return res.status(400).json({error:'invalid_license_key'});
  licenses[key]=cleanRecord(req.body); saveStore(); audit('license_upsert',{key_ref:keyRef(key),status:licenses[key].status,plan:licenses[key].plan});
  res.json({ok:true,key_ref:keyRef(key),record:licenses[key]});
});
app.post('/v1/admin/license/revoke', (req,res) => {
  if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
  const key=String(req.body?.license_key||'').trim(); if(!licenses[key])return res.status(404).json({error:'not_found'});
  licenses[key]={...licenses[key],status:'revoked'}; saveStore(); audit('license_revoke',{key_ref:keyRef(key)}); res.json({ok:true,key_ref:keyRef(key)});
});
app.post('/v1/admin/reload-store', (req,res) => { if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'}); loadStore(); res.json({ok:true,total:Object.keys(licenses).length}); });

app.listen(port,'0.0.0.0',()=>console.log(`WPGo control plane ${VERSION} listening on ${port}`));
