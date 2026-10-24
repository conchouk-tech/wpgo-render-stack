import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8081);
const databaseUrl = process.env.DATABASE_URL || '';
const sessionSecret = process.env.WPGO_SESSION_SECRET || '';
const founderEmails = new Set(String(process.env.WPGO_FOUNDER_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const devAuth = process.env.WPGO_DEV_AUTH === '1';
const licenseValidateUrl = process.env.WPGO_LICENSE_VALIDATE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/license/validate';
const licenseIssueUrl = process.env.WPGO_LICENSE_ISSUE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/admin/license/issue';
const controlAdminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const PLANS = {
  free:   {id:'free', name:'Free', monthly_eur:0, daily_actions:100, client_controls:false},
  solo:   {id:'solo', name:'Solo', monthly_eur:5.95, daily_actions:750, client_controls:false},
  pro:    {id:'pro', name:'Pro', monthly_eur:12.95, daily_actions:2500, client_controls:false},
  agency: {id:'agency', name:'Agency', monthly_eur:24.95, daily_actions:7500, client_controls:true},
  scale:  {id:'scale', name:'Scale', monthly_eur:39.95, daily_actions:15000, client_controls:true},
  founder:{id:'founder', name:'Founder', monthly_eur:0, daily_actions:null, client_controls:true, unlimited:true}
};
const STRIPE_PRICE_ENV = {
  solo:'STRIPE_PRICE_SOLO', pro:'STRIPE_PRICE_PRO', agency:'STRIPE_PRICE_AGENCY', scale:'STRIPE_PRICE_SCALE'
};

app.disable('x-powered-by');
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cache-Control','no-store');next();});
app.use((req,res,next)=>{
  if(req.path === '/v1/billing/webhook') return next();
  express.json({limit:'64kb'})(req,res,next);
});

const pool = databaseUrl ? new Pool({connectionString:databaseUrl, ssl: databaseUrl.includes('localhost') ? false : {rejectUnauthorized:false}}) : null;

function hmac(value){return crypto.createHmac('sha256',sessionSecret || 'wpgo-dev-session').update(value).digest('base64url');}
function makeSession(account){
  const payload = Buffer.from(JSON.stringify({id:account.id,email:account.email,iat:Date.now(),exp:Date.now()+1000*60*60*24*30})).toString('base64url');
  return `wpgosess1.${payload}.${hmac(payload)}`;
}
function readSession(token){
  if(!token || !token.startsWith('wpgosess1.')) return null;
  const parts=token.split('.'); if(parts.length!==3) return null;
  const expected=hmac(parts[1]);
  const a=Buffer.from(expected); const b=Buffer.from(parts[2]);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try{const p=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')); if(!p.exp || p.exp<Date.now()) return null; return p;}catch{return null;}
}
function bearer(req){const v=req.get('authorization')||'';return v.startsWith('Bearer ')?v.slice(7).trim():'';}
function codeHash(email,code){return crypto.createHash('sha256').update(`${email}|${code}|${sessionSecret}`).digest('hex');}
function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);}
function accountPlan(row){if(row?.is_founder || founderEmails.has(normalizeEmail(row?.email))) return PLANS.founder; return PLANS[row?.plan] || PLANS.free;}
async function q(text,params=[]){if(!pool) throw new Error('database_not_configured'); return pool.query(text,params);}

async function initDb(){
  if(!pool) return;
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
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
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, site_host)
  )`);
}

async function getOrCreateAccount(email){
  const isFounder = founderEmails.has(email);
  const id=crypto.randomUUID();
  const r=await q(`INSERT INTO wpgo_accounts(id,email,plan,is_founder) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET is_founder = wpgo_accounts.is_founder OR EXCLUDED.is_founder, updated_at=NOW()
    RETURNING *`,[id,email,isFounder?'founder':'free',isFounder]);
  return r.rows[0];
}
async function usageFor(account){
  const plan=accountPlan(account);
  if(plan.unlimited) return {plan:plan.id,unlimited:true,used:0,allowance:null,remaining:null,window_hours:24,percent:0};
  const r=await q(`SELECT COALESCE(SUM(units),0)::int AS used FROM wpgo_usage_events WHERE account_id=$1 AND success=TRUE AND created_at > NOW() - INTERVAL '24 hours'`,[account.id]);
  const used=Number(r.rows[0]?.used||0); const allowance=plan.daily_actions; const remaining=Math.max(0,allowance-used);
  return {plan:plan.id,unlimited:false,used,allowance,remaining,window_hours:24,percent:Math.min(100,Math.round((used/allowance)*1000)/10)};
}
async function authAccount(req,res,next){
  const s=readSession(bearer(req)); if(!s) return res.status(401).json({error:'authentication_required'});
  try{const r=await q(`SELECT * FROM wpgo_accounts WHERE id=$1`,[s.id]); if(!r.rows[0]) return res.status(401).json({error:'account_not_found'}); req.account=r.rows[0]; next();}catch(e){next(e);}
}

async function validateCommercialLicense(req){
  const token=bearer(req); if(!token) return {ok:false,status:401,error:'license_required'};
  const siteUrl=String(req.body?.site_url||req.get('x-wpgo-site')||'').slice(0,500);
  try{
    const r=await fetch(licenseValidateUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':'WPGo-Commercial-API/1.1'},body:JSON.stringify({license_key:token,site_url:siteUrl})});
    const raw=await r.json().catch(()=>({})); const data=raw?.payload && typeof raw.payload==='object'?raw.payload:raw;
    if(!r.ok || data?.status!=='active' || !data?.license_id) return {ok:false,status:r.status||403,error:data?.status||'invalid_license'};
    return {ok:true,license:data,token,siteUrl};
  }catch{return {ok:false,status:502,error:'license_service_unavailable'};}
}
async function accountFromLicense(req){
  const v=await validateCommercialLicense(req); if(!v.ok) return v;
  const r=await q(`SELECT * FROM wpgo_accounts WHERE id=$1`,[v.license.license_id]);
  if(!r.rows[0]) return {ok:false,status:404,error:'account_not_found'};
  return {...v,account:r.rows[0]};
}
async function issueLicenseForAccount(account,siteHosts=[]){
  if(!controlAdminToken) throw new Error('control_plane_admin_not_configured');
  const plan=accountPlan(account);
  const body={license_id:account.id,status:'active',plan:plan.id,features:['updates','support','metering','account-connect'],site_hosts:Array.isArray(siteHosts)?siteHosts:[]};
  const r=await fetch(licenseIssueUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','authorization':`Bearer ${controlAdminToken}`},body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok || !data?.license_key) throw new Error(data?.error||'license_issue_failed');
  return data;
}

app.get('/health',async(_req,res)=>{
  let db=false; try{if(pool){await q('SELECT 1');db=true;}}catch{}
  res.status(db||!pool?200:503).json({ok:db||!pool,service:'wpgo-commercial-api',version:'1.1.0',database:db?'ready':(pool?'unavailable':'not_configured'),stripe:Boolean(stripe),plans:Object.keys(PLANS).filter(x=>x!=='founder')});
});
app.get('/v1/plans',(_req,res)=>res.json({currency:'EUR',billing:'monthly',usage_window_hours:24,failed_actions_count:false,plans:Object.values(PLANS).filter(p=>p.id!=='founder')}));

app.post('/v1/auth/request-code',async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email); if(!validEmail(email)) return res.status(400).json({error:'invalid_email'});
    await getOrCreateAccount(email);
    await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE email=$1 AND used_at IS NULL`,[email]);
    const code=String(crypto.randomInt(100000,999999)); const id=crypto.randomUUID();
    await q(`INSERT INTO wpgo_login_codes(id,email,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,[id,email,codeHash(email,code)]);
    console.log(JSON.stringify({event:'login_code_created',email,code:devAuth?code:'[redacted]',id}));
    res.json({ok:true,delivery:'email',expires_minutes:10,...(devAuth?{dev_code:code}:{})});
  }catch(e){next(e);}
});
app.post('/v1/auth/verify-code',async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email); const code=String(req.body?.code||'').trim();
    if(!validEmail(email)||!/^[0-9]{6}$/.test(code)) return res.status(400).json({error:'invalid_code'});
    const r=await q(`SELECT * FROM wpgo_login_codes WHERE email=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,[email]);
    const row=r.rows[0]; if(!row || row.code_hash!==codeHash(email,code)) return res.status(401).json({error:'invalid_or_expired_code'});
    await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1`,[row.id]);
    const acct=await getOrCreateAccount(email); const token=makeSession(acct); const usage=await usageFor(acct);
    res.json({ok:true,token,account:{id:acct.id,email:acct.email,plan:accountPlan(acct),usage}});
  }catch(e){next(e);}
});

app.get('/v1/account',authAccount,async(req,res,next)=>{try{res.json({account:{id:req.account.id,email:req.account.email,plan:accountPlan(req.account),subscription_status:req.account.subscription_status,usage:await usageFor(req.account)}});}catch(e){next(e);}});
app.get('/v1/account/sites',authAccount,async(req,res,next)=>{try{const r=await q(`SELECT id,site_url,site_host,label,connected_at FROM wpgo_sites WHERE account_id=$1 ORDER BY connected_at DESC`,[req.account.id]);res.json({sites:r.rows});}catch(e){next(e);}});

app.post('/v1/account/license',authAccount,async(req,res,next)=>{
  try{
    const hosts=Array.isArray(req.body?.site_hosts)?req.body.site_hosts.map(v=>String(v).trim().toLowerCase()).filter(Boolean).slice(0,25):[];
    const issued=await issueLicenseForAccount(req.account,hosts);
    res.json({ok:true,license_key:issued.license_key,record:issued.record});
  }catch(e){next(e);}
});
app.post('/v1/sites/register',authAccount,async(req,res,next)=>{
  try{
    const siteUrl=String(req.body?.site_url||'').trim(); let u; try{u=new URL(siteUrl)}catch{return res.status(400).json({error:'invalid_site_url'});}
    if(u.protocol!=='https:') return res.status(400).json({error:'https_required'});
    const host=u.hostname.toLowerCase(); const label=String(req.body?.label||host).slice(0,100);
    const id=crypto.randomUUID();
    await q(`INSERT INTO wpgo_sites(id,account_id,site_url,site_host,label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,site_host) DO UPDATE SET site_url=EXCLUDED.site_url,label=EXCLUDED.label`,[id,req.account.id,u.origin+'/',host,label]);
    const issued=await issueLicenseForAccount(req.account,[host]);
    res.json({ok:true,site:{site_url:u.origin+'/',site_host:host,label},license_key:issued.license_key,plan:accountPlan(req.account)});
  }catch(e){next(e);}
});

app.post('/v1/meter/check',async(req,res,next)=>{
  try{
    const v=await accountFromLicense(req); if(!v.ok) return res.status(v.status).json({allowed:false,error:v.error});
    const usage=await usageFor(v.account);
    res.status(!usage.unlimited && usage.remaining<1?429:200).json({allowed:usage.unlimited||usage.remaining>=1,plan:accountPlan(v.account),usage});
  }catch(e){next(e);}
});
app.post('/v1/meter/record',async(req,res,next)=>{
  try{
    const v=await accountFromLicense(req); if(!v.ok) return res.status(v.status).json({error:v.error});
    const success=req.body?.success!==false; const units=Math.max(1,Math.min(100,Number(req.body?.units||1))); const op=String(req.body?.operation||'').slice(0,120); let host=String(req.body?.site_host||'').slice(0,255);
    if(!host && v.siteUrl){try{host=new URL(v.siteUrl).hostname}catch{}}
    const before=await usageFor(v.account);
    if(success && !before.unlimited && before.remaining<units) return res.status(429).json({error:'usage_limit_reached',usage:before});
    if(success) await q(`INSERT INTO wpgo_usage_events(id,account_id,site_host,operation,units,success) VALUES($1,$2,$3,$4,$5,TRUE)`,[crypto.randomUUID(),v.account.id,host,op,units]);
    res.json({ok:true,counted:success,usage:await usageFor(v.account)});
  }catch(e){next(e);}
});
app.post('/v1/meter/consume',async(req,res,next)=>{
  try{
    const v=await accountFromLicense(req); if(!v.ok) return res.status(v.status).json({error:v.error});
    const units=Math.max(1,Math.min(100,Number(req.body?.units||1))); const op=String(req.body?.operation||'').slice(0,120); const success=req.body?.success!==false; let host=String(req.body?.site_host||'').slice(0,255);
    if(!host && v.siteUrl){try{host=new URL(v.siteUrl).hostname}catch{}}
    const before=await usageFor(v.account); if(success && !before.unlimited && before.remaining<units) return res.status(429).json({error:'usage_limit_reached',usage:before});
    if(success) await q(`INSERT INTO wpgo_usage_events(id,account_id,site_host,operation,units,success) VALUES($1,$2,$3,$4,$5,TRUE)`,[crypto.randomUUID(),v.account.id,host,op,units]);
    res.json({ok:true,usage:await usageFor(v.account)});
  }catch(e){next(e);}
});

app.post('/v1/billing/checkout',authAccount,async(req,res,next)=>{
  try{
    if(!stripe) return res.status(503).json({error:'stripe_not_configured'});
    const planId=String(req.body?.plan||''); if(!['solo','pro','agency','scale'].includes(planId)) return res.status(400).json({error:'invalid_plan'});
    if(accountPlan(req.account).id==='founder') return res.status(409).json({error:'founder_is_unlimited'});
    const price=process.env[STRIPE_PRICE_ENV[planId]]; if(!price) return res.status(503).json({error:'stripe_price_not_configured',plan:planId});
    let customer=req.account.stripe_customer_id;
    if(!customer){const c=await stripe.customers.create({email:req.account.email,metadata:{wpgo_account_id:req.account.id}});customer=c.id;await q(`UPDATE wpgo_accounts SET stripe_customer_id=$1,updated_at=NOW() WHERE id=$2`,[customer,req.account.id]);}
    const portalBase=String(process.env.WPGO_PORTAL_URL||'https://wpgo-commercial-web.onrender.com').replace(/\/$/,'');
    const session=await stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price,quantity:1}],success_url:`${portalBase}/account?checkout=success`,cancel_url:`${portalBase}/pricing?checkout=cancelled`,client_reference_id:req.account.id,metadata:{wpgo_account_id:req.account.id,wpgo_plan:planId},subscription_data:{metadata:{wpgo_account_id:req.account.id,wpgo_plan:planId}}});
    res.json({url:session.url});
  }catch(e){next(e);}
});
app.post('/v1/billing/portal',authAccount,async(req,res,next)=>{try{if(!stripe) return res.status(503).json({error:'stripe_not_configured'});if(!req.account.stripe_customer_id)return res.status(409).json({error:'no_billing_account'});const portalBase=String(process.env.WPGO_PORTAL_URL||'https://wpgo-commercial-web.onrender.com').replace(/\/$/,'');const s=await stripe.billingPortal.sessions.create({customer:req.account.stripe_customer_id,return_url:`${portalBase}/account`});res.json({url:s.url});}catch(e){next(e);}});
app.post('/v1/billing/webhook',express.raw({type:'application/json'}),async(req,res)=>{
  if(!stripe || !stripeWebhookSecret) return res.status(503).send('stripe_not_configured');
  let event; try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature')||'',stripeWebhookSecret);}catch{return res.status(400).send('invalid_signature');}
  try{
    if(['checkout.session.completed','customer.subscription.created','customer.subscription.updated'].includes(event.type)){
      const obj=event.data.object; const subId=obj.subscription || obj.id; let accountId=obj.metadata?.wpgo_account_id || obj.client_reference_id || ''; let plan=obj.metadata?.wpgo_plan || '';
      if(event.type.startsWith('customer.subscription')){accountId=obj.metadata?.wpgo_account_id||'';plan=obj.metadata?.wpgo_plan||'';}
      if(accountId && PLANS[plan] && plan!=='founder') await q(`UPDATE wpgo_accounts SET plan=$1,stripe_subscription_id=$2,subscription_status='active',updated_at=NOW() WHERE id=$3`,[plan,String(subId||''),accountId]);
    }
    if(event.type==='customer.subscription.deleted'){
      const obj=event.data.object; const accountId=obj.metadata?.wpgo_account_id||''; if(accountId) await q(`UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status='cancelled',updated_at=NOW() WHERE id=$1 AND is_founder=FALSE`,[accountId]);
    }
    res.json({received:true});
  }catch(e){console.error(e);res.status(500).send('webhook_processing_failed');}
});

app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'server_error',message:devAuth?String(err?.message||err):undefined});});

initDb().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`WPGo commercial API listening on ${port}`))).catch(err=>{console.error('DB init failed',err);process.exit(1);});
