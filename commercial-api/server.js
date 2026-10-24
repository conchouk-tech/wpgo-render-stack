import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8081);
const databaseUrl = process.env.DATABASE_URL || '';
const sessionSecret = process.env.WPGO_SESSION_SECRET || '';
const meteringSecret = process.env.WPGO_METERING_SECRET || '';
const founderEmails = new Set(String(process.env.WPGO_FOUNDER_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const devAuth = process.env.WPGO_DEV_AUTH === '1';
const appUrl = process.env.WPGO_APP_URL || 'https://wpgo-commercial-web.onrender.com';
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
const PRICE_ENV = {solo:'STRIPE_PRICE_SOLO',pro:'STRIPE_PRICE_PRO',agency:'STRIPE_PRICE_AGENCY',scale:'STRIPE_PRICE_SCALE'};

app.disable('x-powered-by');
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cache-Control','no-store');next();});
app.use((req,res,next)=> req.path === '/v1/billing/webhook' ? next() : express.json({limit:'64kb'})(req,res,next));

const pool = databaseUrl ? new Pool({connectionString:databaseUrl, ssl: databaseUrl.includes('localhost') ? false : {rejectUnauthorized:false}}) : null;
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const cleanEmail = v => String(v||'').trim().toLowerCase();
const bearer = req => {const v=req.get('authorization')||'';return v.startsWith('Bearer ')?v.slice(7).trim():'';};
function timingEqual(a,b){const aa=Buffer.from(hash(a));const bb=Buffer.from(hash(b));return crypto.timingSafeEqual(aa,bb);}
function hmac(v){return crypto.createHmac('sha256',sessionSecret || 'wpgo-dev-session').update(v).digest('base64url');}
function makeSession(a){const p=Buffer.from(JSON.stringify({id:a.id,email:a.email,exp:Date.now()+2592000000})).toString('base64url');return `wpgosess1.${p}.${hmac(p)}`;}
function readSession(token){if(!token?.startsWith('wpgosess1.'))return null;const p=token.split('.');if(p.length!==3||!timingEqual(p[2],hmac(p[1])))return null;try{const x=JSON.parse(Buffer.from(p[1],'base64url').toString());return x.exp>Date.now()?x:null;}catch{return null;}}
function planFor(account){if(account.is_founder)return PLANS.founder;return PLANS[account.plan]||PLANS.free;}
async function db(sql,args=[]){if(!pool)throw new Error('database_not_configured');return pool.query(sql,args);}

async function init(){
  if(!pool)return;
  await db(`CREATE TABLE IF NOT EXISTS accounts (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, plan text NOT NULL DEFAULT 'free', status text NOT NULL DEFAULT 'active', is_founder boolean NOT NULL DEFAULT false, stripe_customer_id text, stripe_subscription_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS login_codes (id bigserial PRIMARY KEY, email text NOT NULL, code_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
  await db(`CREATE TABLE IF NOT EXISTS usage_events (id bigserial PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, site_host text, ability text, success boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`);
  await db(`CREATE INDEX IF NOT EXISTS usage_account_time ON usage_events(account_id,created_at DESC)`);
  await db(`CREATE TABLE IF NOT EXISTS sites (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, host text NOT NULL, label text, connected_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,host))`);
  console.log('WPGo commercial schema ready');
}

async function getAccountById(id){const r=await db('SELECT * FROM accounts WHERE id=$1',[id]);return r.rows[0]||null;}
async function getOrCreateAccount(email){
  const founder=founderEmails.has(email);
  const id=crypto.randomUUID();
  const r=await db(`INSERT INTO accounts(id,email,plan,is_founder) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET is_founder=(accounts.is_founder OR EXCLUDED.is_founder), plan=CASE WHEN (accounts.is_founder OR EXCLUDED.is_founder) THEN 'founder' ELSE accounts.plan END, updated_at=now() RETURNING *`,[id,email,founder?'founder':'free',founder]);
  return r.rows[0];
}
async function auth(req,res,next){const s=readSession(bearer(req));if(!s)return res.status(401).json({error:'unauthorized'});try{const a=await getAccountById(s.id);if(!a||a.status!=='active')return res.status(401).json({error:'unauthorized'});req.account=a;next();}catch(e){res.status(503).json({error:String(e.message||e)});}}
function meteringAuth(req,res,next){const t=bearer(req);if(!meteringSecret||!t||!timingEqual(t,meteringSecret))return res.status(401).json({error:'unauthorized'});next();}

app.get('/health',(_req,res)=>res.json({ok:true,service:'wpgo-commercial-api',version:'1.0.0',database:Boolean(pool),stripe:Boolean(stripe),plans:Object.keys(PLANS)}));
app.get('/v1/plans',(_req,res)=>res.json({currency:'EUR',billing:'monthly',usage_window_hours:24,failed_actions_count:false,plans:Object.values(PLANS).filter(p=>p.id!=='founder')}));

app.post('/v1/auth/request-code',async(req,res)=>{
  try{const email=cleanEmail(req.body?.email);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:'invalid_email'});const code=String(Math.floor(100000+Math.random()*900000));await db('INSERT INTO login_codes(email,code_hash,expires_at) VALUES($1,$2,now()+interval \'10 minutes\')',[email,hash(code)]);console.log(`WPGo login code requested for ${hash(email).slice(0,12)}`);res.json({ok:true,delivery:'email-provider-required',...(devAuth?{development_code:code}:{})});}catch(e){res.status(503).json({error:String(e.message||e)});}
});
app.post('/v1/auth/verify-code',async(req,res)=>{
  try{const email=cleanEmail(req.body?.email);const code=String(req.body?.code||'');const r=await db(`UPDATE login_codes SET used_at=now() WHERE id=(SELECT id FROM login_codes WHERE email=$1 AND code_hash=$2 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1) RETURNING id`,[email,hash(code)]);if(!r.rowCount)return res.status(401).json({error:'invalid_or_expired_code'});const a=await getOrCreateAccount(email);res.json({ok:true,session_token:makeSession(a),account:{id:a.id,email:a.email,plan:planFor(a)}});}catch(e){res.status(503).json({error:String(e.message||e)});}
});
app.get('/v1/me',auth,async(req,res)=>{
  const p=planFor(req.account);const u=p.unlimited?0:Number((await db(`SELECT count(*)::int AS n FROM usage_events WHERE account_id=$1 AND success=true AND created_at>now()-interval '24 hours'`,[req.account.id])).rows[0].n);const sites=(await db('SELECT host,label,connected_at FROM sites WHERE account_id=$1 ORDER BY connected_at DESC',[req.account.id])).rows;res.json({account:{id:req.account.id,email:req.account.email,status:req.account.status},plan:p,usage:{used:u,limit:p.daily_actions,remaining:p.unlimited?null:Math.max(0,p.daily_actions-u),window_hours:24,unlimited:Boolean(p.unlimited)},sites});
});

app.post('/v1/meter/check',meteringAuth,async(req,res)=>{
  try{const a=await getAccountById(String(req.body?.account_id||''));if(!a||a.status!=='active')return res.status(403).json({allowed:false,reason:'inactive_account'});const p=planFor(a);if(p.unlimited)return res.json({allowed:true,plan:p.id,unlimited:true,remaining:null});const n=Number((await db(`SELECT count(*)::int AS n FROM usage_events WHERE account_id=$1 AND success=true AND created_at>now()-interval '24 hours'`,[a.id])).rows[0].n);res.json({allowed:n<p.daily_actions,plan:p.id,used:n,limit:p.daily_actions,remaining:Math.max(0,p.daily_actions-n)});}catch(e){res.status(503).json({error:String(e.message||e)});}
});
app.post('/v1/meter/record',meteringAuth,async(req,res)=>{
  try{const a=await getAccountById(String(req.body?.account_id||''));if(!a)return res.status(404).json({error:'account_not_found'});const success=req.body?.success!==false;if(success)await db('INSERT INTO usage_events(account_id,site_host,ability,success) VALUES($1,$2,$3,true)',[a.id,String(req.body?.site_host||'').slice(0,253),String(req.body?.ability||'').slice(0,200)]);res.json({ok:true,counted:success});}catch(e){res.status(503).json({error:String(e.message||e)});}
});
app.post('/v1/sites/connect',auth,async(req,res)=>{try{const host=String(req.body?.host||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');if(!/^[a-z0-9.-]+$/.test(host))return res.status(400).json({error:'invalid_host'});await db('INSERT INTO sites(id,account_id,host,label) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,host) DO UPDATE SET label=EXCLUDED.label',[crypto.randomUUID(),req.account.id,host,String(req.body?.label||'').slice(0,100)]);res.json({ok:true,host});}catch(e){res.status(503).json({error:String(e.message||e)});}});

app.post('/v1/billing/checkout',auth,async(req,res)=>{
  try{if(req.account.is_founder)return res.status(409).json({error:'founder_account_is_unlimited'});if(!stripe)return res.status(503).json({error:'stripe_not_configured'});const plan=String(req.body?.plan||'');if(!PRICE_ENV[plan])return res.status(400).json({error:'invalid_paid_plan'});const price=process.env[PRICE_ENV[plan]];if(!price)return res.status(503).json({error:'stripe_price_not_configured',plan});let customer=req.account.stripe_customer_id;if(!customer){const c=await stripe.customers.create({email:req.account.email,metadata:{wpgo_account_id:req.account.id}});customer=c.id;await db('UPDATE accounts SET stripe_customer_id=$1,updated_at=now() WHERE id=$2',[customer,req.account.id]);}const s=await stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price,quantity:1}],success_url:`${appUrl}/account?billing=success`,cancel_url:`${appUrl}/pricing?billing=cancelled`,metadata:{wpgo_account_id:req.account.id,wpgo_plan:plan},subscription_data:{metadata:{wpgo_account_id:req.account.id,wpgo_plan:plan}}});res.json({ok:true,url:s.url});}catch(e){res.status(503).json({error:String(e.message||e)});}
});
app.post('/v1/billing/portal',auth,async(req,res)=>{try{if(!stripe||!req.account.stripe_customer_id)return res.status(409).json({error:'no_billing_customer'});const s=await stripe.billingPortal.sessions.create({customer:req.account.stripe_customer_id,return_url:`${appUrl}/account`});res.json({ok:true,url:s.url});}catch(e){res.status(503).json({error:String(e.message||e)});}});
app.post('/v1/billing/webhook',express.raw({type:'application/json'}),async(req,res)=>{
  if(!stripe||!stripeWebhookSecret)return res.status(503).send('stripe_not_configured');let event;try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature')||'',stripeWebhookSecret);}catch{return res.status(400).send('invalid_signature');}
  try{if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){const sub=event.data.object;const accountId=sub.metadata?.wpgo_account_id;const plan=sub.metadata?.wpgo_plan;const active=['active','trialing'].includes(sub.status);if(accountId)await db(`UPDATE accounts SET plan=$1,status=$2,stripe_subscription_id=$3,updated_at=now() WHERE id=$4 AND is_founder=false`,[active&&PLANS[plan]?plan:'free',active?'active':'active',sub.id,accountId]);}res.json({received:true});}catch(e){res.status(500).json({error:String(e.message||e)});}
});

init().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`WPGo commercial API listening on ${port}`))).catch(e=>{console.error(e);process.exit(1);});
