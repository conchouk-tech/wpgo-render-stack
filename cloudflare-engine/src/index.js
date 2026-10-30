const VERSION = '2.0.0-cloudflare';

const PLANS = Object.freeze({
  free:   { id:'free',   name:'Free',   monthly_eur:0,     yearly_eur:0,      daily_actions:100,   client_controls:false },
  solo:   { id:'solo',   name:'Solo',   monthly_eur:5.95,  yearly_eur:60.99,  daily_actions:750,   client_controls:false },
  pro:    { id:'pro',    name:'Pro',    monthly_eur:12.95, yearly_eur:132.99, daily_actions:2500,  client_controls:false },
  agency: { id:'agency', name:'Agency', monthly_eur:24.95, yearly_eur:254.99, daily_actions:7500,  client_controls:true },
  scale:  { id:'scale',  name:'Scale',  monthly_eur:39.95, yearly_eur:407.99, daily_actions:15000, client_controls:true },
  founder:{ id:'founder',name:'Founder',monthly_eur:0,     yearly_eur:0,      daily_actions:null,  client_controls:true, unlimited:true }
});

const PRICE_ENV = Object.freeze({
  solo:   { monthly:'STRIPE_PRICE_SOLO',   yearly:'STRIPE_PRICE_SOLO_YEARLY' },
  pro:    { monthly:'STRIPE_PRICE_PRO',    yearly:'STRIPE_PRICE_PRO_YEARLY' },
  agency: { monthly:'STRIPE_PRICE_AGENCY', yearly:'STRIPE_PRICE_AGENCY_YEARLY' },
  scale:  { monthly:'STRIPE_PRICE_SCALE',  yearly:'STRIPE_PRICE_SCALE_YEARLY' }
});

const enc = new TextEncoder();
const dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}
  });
}
function text(body, status=200, headers={}) {
  return new Response(body,{status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store',...headers}});
}
function normalizeEmail(v){ return String(v||'').trim().toLowerCase(); }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function cleanText(v,max=500){ return String(v||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max); }
function normalizeSiteUrl(value){
  try { const u=new URL(String(value||'').trim()); if(u.protocol!=='https:'||!u.hostname)return ''; return u.origin+'/'; }
  catch { return ''; }
}
function hostFromSiteUrl(value){ try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } }
function b64u(bytes){
  let s=''; for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64u(s){
  const p=String(s).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(p+'='.repeat((4-p.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function hmacBytes(secret, value){
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value)));
}
async function hmacHex(secret, value){ return [...await hmacBytes(secret,value)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function sha256Hex(value){
  const out=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)));
  return [...out].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function constantTimeEqual(a,b){
  if(a.length!==b.length)return false;
  let diff=0; for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function bearer(req){ const v=req.headers.get('authorization')||''; return v.startsWith('Bearer ')?v.slice(7).trim():''; }
function founderEmails(env){ return new Set(String(env.FOUNDER_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)); }
function planForAccount(row,env){
  if(Number(row?.is_founder)===1 || founderEmails(env).has(normalizeEmail(row?.email))) return PLANS.founder;
  return PLANS[row?.plan] || PLANS.free;
}
function publicPlan(p){
  const {id,name,monthly_eur,yearly_eur,daily_actions,client_controls,unlimited=false}=p;
  return {id,name,monthly_eur,yearly_eur,daily_actions,client_controls,unlimited};
}
function corsHeaders(req,env){
  const origin=req.headers.get('origin')||'';
  const allowed=new Set(String(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean));
  return origin&&allowed.has(origin)?{
    'access-control-allow-origin':origin,
    'vary':'Origin',
    'access-control-allow-methods':'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers':'authorization,content-type,stripe-signature',
    'access-control-max-age':'86400'
  }:{};
}
function withCors(res,req,env){
  const h=new Headers(res.headers); for(const [k,v] of Object.entries(corsHeaders(req,env)))h.set(k,v);
  h.set('x-content-type-options','nosniff'); h.set('referrer-policy','no-referrer');
  return new Response(res.body,{status:res.status,statusText:res.statusText,headers:h});
}
async function bodyJson(req){ try{return await req.json();}catch{return{};} }
async function dbFirst(env,sql,...args){ return env.DB.prepare(sql).bind(...args).first(); }
async function dbRun(env,sql,...args){ return env.DB.prepare(sql).bind(...args).run(); }
async function dbAll(env,sql,...args){ const r=await env.DB.prepare(sql).bind(...args).all(); return r.results||[]; }

async function makeSession(account,env){
  if(!env.SESSION_SECRET)throw new Error('SESSION_SECRET_not_configured');
  const payload=b64u(enc.encode(JSON.stringify({id:account.id,email:account.email,iat:Date.now(),exp:Date.now()+1000*60*60*24*30})));
  return `wpvsess1.${payload}.${b64u(await hmacBytes(env.SESSION_SECRET,payload))}`;
}
async function readSession(token,env){
  if(!token||!token.startsWith('wpvsess1.')||!env.SESSION_SECRET)return null;
  const parts=token.split('.'); if(parts.length!==3)return null;
  const expected=b64u(await hmacBytes(env.SESSION_SECRET,parts[1])); if(!constantTimeEqual(expected,parts[2]))return null;
  try { const v=JSON.parse(dec.decode(unb64u(parts[1]))); return v.exp&&v.exp>=Date.now()?v:null; } catch { return null; }
}
async function makeLicense(account,siteHosts,env){
  if(!env.LICENSE_SIGNING_SECRET)throw new Error('LICENSE_SIGNING_SECRET_not_configured');
  const p=planForAccount(account,env);
  const payload=b64u(enc.encode(JSON.stringify({license_id:account.id,plan:p.id,site_hosts:siteHosts,iat:now(),exp:now()+31536000})));
  return `wpvlic1.${payload}.${b64u(await hmacBytes(env.LICENSE_SIGNING_SECRET,payload))}`;
}
async function readLicense(token,env){
  if(!token||!token.startsWith('wpvlic1.')||!env.LICENSE_SIGNING_SECRET)return null;
  const parts=token.split('.'); if(parts.length!==3)return null;
  const expected=b64u(await hmacBytes(env.LICENSE_SIGNING_SECRET,parts[1])); if(!constantTimeEqual(expected,parts[2]))return null;
  try { const v=JSON.parse(dec.decode(unb64u(parts[1]))); return v.exp&&v.exp>=now()?v:null; } catch { return null; }
}
async function audit(env,accountId,eventType,detail=''){
  await dbRun(env,'INSERT INTO audit_events(id,account_id,event_type,detail,created_at) VALUES(?,?,?,?,?)',uuid(),accountId||null,eventType,cleanText(detail,2000),now());
}
async function getOrCreateAccount(email,env){
  const e=normalizeEmail(email),ts=now();
  let row=await dbFirst(env,'SELECT * FROM accounts WHERE email=?',e);
  const isFounder=founderEmails(env).has(e)?1:0;
  if(!row){
    const id=uuid(); await dbRun(env,'INSERT INTO accounts(id,email,plan,is_founder,created_at,updated_at) VALUES(?,?,?,?,?,?)',id,e,isFounder?'founder':'free',isFounder,ts,ts);
    row=await dbFirst(env,'SELECT * FROM accounts WHERE id=?',id);
  } else if(isFounder && Number(row.is_founder)!==1){
    await dbRun(env,'UPDATE accounts SET is_founder=1,updated_at=? WHERE id=?',ts,row.id); row={...row,is_founder:1};
  }
  return row;
}
async function accountById(id,env){ return dbFirst(env,'SELECT * FROM accounts WHERE id=?',id); }
async function usageFor(account,env){
  const p=planForAccount(account,env);
  if(p.unlimited)return {plan:p.id,unlimited:true,used:0,allowance:null,remaining:null,window_hours:24,percent:0};
  const cutoff=now()-86400;
  const row=await dbFirst(env,'SELECT COALESCE(SUM(units),0) AS used FROM usage_events WHERE account_id=? AND success=1 AND created_at>?',account.id,cutoff);
  const used=Number(row?.used||0),allowance=p.daily_actions,remaining=Math.max(0,allowance-used);
  return {plan:p.id,unlimited:false,used,allowance,remaining,window_hours:24,percent:Math.min(100,Math.round((used/allowance)*1000)/10)};
}
async function authenticatedAccount(req,env){
  const s=await readSession(bearer(req),env); if(!s)return null;
  return accountById(s.id,env);
}

async function sendLoginCode(email,code,env){
  if(String(env.DEV_AUTH||'0')==='1')return {delivery:'dev',dev_code:code};
  if(!env.RESEND_API_KEY||!env.LOGIN_FROM_EMAIL)throw new Error('transactional_email_not_configured');
  const r=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{'authorization':`Bearer ${env.RESEND_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({from:env.LOGIN_FROM_EMAIL,to:[email],subject:'Your WP Virtuoso sign-in code',html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>WP Virtuoso</h2><p>Your sign-in code is:</p><p style="font-size:30px;font-weight:700;letter-spacing:5px">${code}</p><p>This code expires in ${Number(env.LOGIN_CODE_MINUTES||10)} minutes. If you did not request it, you can ignore this email.</p></div>`})
  });
  if(!r.ok)throw new Error(`email_delivery_failed_${r.status}`);
  return {delivery:'email'};
}
async function requestCode(req,env){
  const b=await bodyJson(req),email=normalizeEmail(b.email); if(!validEmail(email))return json({error:'invalid_email'},400);
  const since=now()-900, recent=await dbFirst(env,'SELECT COUNT(*) AS n FROM login_codes WHERE email=? AND created_at>?',email,since);
  if(Number(recent?.n||0)>=5)return json({error:'rate_limited',retry_minutes:15},429);
  await getOrCreateAccount(email,env);
  await dbRun(env,'UPDATE login_codes SET used_at=? WHERE email=? AND used_at IS NULL',now(),email);
  const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%900000+100000).padStart(6,'0');
  const mins=Math.max(5,Math.min(30,Number(env.LOGIN_CODE_MINUTES||10))),id=uuid(),hash=await sha256Hex(`${email}|${code}|${env.SESSION_SECRET||''}`);
  await dbRun(env,'INSERT INTO login_codes(id,email,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)',id,email,hash,now()+mins*60,now());
  const delivery=await sendLoginCode(email,code,env); await audit(env,null,'auth_code_requested',email);
  return json({ok:true,expires_minutes:mins,...delivery});
}
async function verifyCode(req,env){
  const b=await bodyJson(req),email=normalizeEmail(b.email),code=String(b.code||'').trim();
  if(!validEmail(email)||!/^[0-9]{6}$/.test(code))return json({error:'invalid_code'},400);
  const row=await dbFirst(env,'SELECT * FROM login_codes WHERE email=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1',email,now());
  const hash=await sha256Hex(`${email}|${code}|${env.SESSION_SECRET||''}`);
  if(!row||!constantTimeEqual(String(row.code_hash||''),hash))return json({error:'invalid_or_expired_code'},401);
  await dbRun(env,'UPDATE login_codes SET used_at=? WHERE id=?',now(),row.id);
  const account=await getOrCreateAccount(email,env),token=await makeSession(account,env),usage=await usageFor(account,env); await audit(env,account.id,'auth_login');
  return json({ok:true,token,account:{id:account.id,email:account.email,plan:publicPlan(planForAccount(account,env)),subscription_status:account.subscription_status,usage}});
}

async function stripeCall(env,path,{method='GET',params=null}={}){
  if(!env.STRIPE_SECRET_KEY)throw new Error('stripe_not_configured');
  const headers={'authorization':`Bearer ${env.STRIPE_SECRET_KEY}`}; let body;
  if(params){ const form=new URLSearchParams(); for(const [k,v] of Object.entries(params)){ if(v===undefined||v===null)continue; form.append(k,String(v)); } body=form.toString(); headers['content-type']='application/x-www-form-urlencoded'; }
  const r=await fetch(`https://api.stripe.com${path}`,{method,headers,body});
  const data=await r.json().catch(()=>({})); if(!r.ok)throw new Error(data?.error?.message||`stripe_${r.status}`); return data;
}
async function ensureStripeCustomer(account,env){
  if(account.stripe_customer_id)return account.stripe_customer_id;
  const c=await stripeCall(env,'/v1/customers',{method:'POST',params:{email:account.email,'metadata[wpv_account_id]':account.id}});
  await dbRun(env,'UPDATE accounts SET stripe_customer_id=?,updated_at=? WHERE id=?',c.id,now(),account.id); return c.id;
}
function priceIdFor(plan,billing,env){ const key=PRICE_ENV[plan]?.[billing]; return key?env[key]:''; }
async function createBillingPortal(account,env){
  if(!account.stripe_customer_id)throw new Error('no_billing_account');
  const base=String(env.PUBLIC_SITE_URL||'').replace(/\/$/,'');
  return stripeCall(env,'/v1/billing_portal/sessions',{method:'POST',params:{customer:account.stripe_customer_id,return_url:`${base}/account/`}});
}
async function checkout(req,env,account){
  const b=await bodyJson(req),planId=String(b.plan||''),billing=String(b.billing||'monthly')==='yearly'?'yearly':'monthly';
  if(!['solo','pro','agency','scale'].includes(planId))return json({error:'invalid_plan'},400);
  if(planForAccount(account,env).id==='founder')return json({error:'account_is_unlimited'},409);
  if(account.stripe_subscription_id && ['active','trialing','past_due','unpaid'].includes(String(account.subscription_status||''))){
    try { const portal=await createBillingPortal(account,env); return json({error:'existing_subscription',manage_url:portal.url},409); }
    catch { return json({error:'existing_subscription'},409); }
  }
  const price=priceIdFor(planId,billing,env); if(!price)return json({error:'stripe_price_not_configured',plan:planId,billing},503);
  const customer=await ensureStripeCustomer(account,env),base=String(env.PUBLIC_SITE_URL||'').replace(/\/$/,'');
  const session=await stripeCall(env,'/v1/checkout/sessions',{method:'POST',params:{
    mode:'subscription',customer,'line_items[0][price]':price,'line_items[0][quantity]':1,
    success_url:`${base}/account/?checkout=success`,cancel_url:`${base}/pricing/?checkout=cancelled`,client_reference_id:account.id,
    'metadata[wpv_account_id]':account.id,'metadata[wpv_plan]':planId,'metadata[wpv_billing]':billing,
    'subscription_data[metadata][wpv_account_id]':account.id,'subscription_data[metadata][wpv_plan]':planId,'subscription_data[metadata][wpv_billing]':billing,
    allow_promotion_codes:'true'
  }});
  await audit(env,account.id,'billing_checkout_created',`${planId}:${billing}`);
  return json({url:session.url,plan:planId,billing});
}
async function billingSummary(account,env){
  if(!account.stripe_customer_id)return {configured:Boolean(env.STRIPE_SECRET_KEY),customer:false,subscription:null,invoices:[]};
  let subscription=null;
  if(account.stripe_subscription_id){ try{ subscription=await stripeCall(env,`/v1/subscriptions/${encodeURIComponent(account.stripe_subscription_id)}`); }catch{} }
  let invoices=[];
  try{
    const x=await stripeCall(env,`/v1/invoices?customer=${encodeURIComponent(account.stripe_customer_id)}&limit=12`);
    invoices=(x.data||[]).map(i=>({id:i.id,status:i.status,currency:i.currency,total:i.total,amount_paid:i.amount_paid,hosted_invoice_url:i.hosted_invoice_url,invoice_pdf:i.invoice_pdf,created:i.created}));
  }catch{}
  return {configured:Boolean(env.STRIPE_SECRET_KEY),customer:true,subscription:subscription?{id:subscription.id,status:subscription.status,current_period_end:subscription.current_period_end,cancel_at_period_end:subscription.cancel_at_period_end}:null,invoices};
}
function stripeSignatureParts(header){
  const out={t:null,v1:[]}; for(const part of String(header||'').split(',')){ const [k,v]=part.split('='); if(k==='t')out.t=Number(v); if(k==='v1')out.v1.push(v); } return out;
}
async function verifyStripeWebhook(raw,header,env){
  if(!env.STRIPE_WEBHOOK_SECRET)return false; const p=stripeSignatureParts(header); if(!p.t||!p.v1.length||Math.abs(now()-p.t)>300)return false;
  const expected=await hmacHex(env.STRIPE_WEBHOOK_SECRET,`${p.t}.${raw}`); return p.v1.some(v=>constantTimeEqual(v,expected));
}
function invoiceSubscriptionId(obj){ return String(obj?.subscription||obj?.parent?.subscription_details?.subscription||''); }
async function stripeWebhook(req,env){
  const raw=await req.text(); if(!await verifyStripeWebhook(raw,req.headers.get('stripe-signature'),env))return text('invalid_signature',400);
  let event; try{event=JSON.parse(raw);}catch{return text('invalid_json',400);}
  const seen=await dbFirst(env,'SELECT event_id FROM stripe_events WHERE event_id=?',event.id); if(seen)return json({received:true,duplicate:true});
  await dbRun(env,'INSERT INTO stripe_events(event_id,event_type,received_at) VALUES(?,?,?)',event.id,event.type,now());
  const obj=event.data?.object||{};
  try{
    if(event.type==='checkout.session.completed'){
      const accountId=obj.metadata?.wpv_account_id||obj.client_reference_id||'',plan=obj.metadata?.wpv_plan||'';
      if(accountId&&PLANS[plan]&&plan!=='founder')await dbRun(env,'UPDATE accounts SET plan=?,stripe_subscription_id=?,subscription_status=?,updated_at=? WHERE id=? AND is_founder=0',plan,String(obj.subscription||''),'active',now(),accountId);
    }
    if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated'){
      const accountId=obj.metadata?.wpv_account_id||'',plan=obj.metadata?.wpv_plan||'',status=cleanText(obj.status||'active',40);
      if(accountId&&PLANS[plan]&&plan!=='founder')await dbRun(env,'UPDATE accounts SET plan=?,stripe_subscription_id=?,subscription_status=?,subscription_current_period_end=?,updated_at=? WHERE id=? AND is_founder=0',plan,String(obj.id||''),status,Number(obj.current_period_end||0)||null,now(),accountId);
    }
    if(event.type==='customer.subscription.deleted'){
      const accountId=obj.metadata?.wpv_account_id||'';
      if(accountId)await dbRun(env,"UPDATE accounts SET plan='free',stripe_subscription_id=NULL,subscription_status='cancelled',subscription_current_period_end=NULL,updated_at=? WHERE id=? AND is_founder=0",now(),accountId);
    }
    if(event.type==='invoice.payment_failed'){
      const sub=invoiceSubscriptionId(obj); if(sub)await dbRun(env,"UPDATE accounts SET subscription_status='past_due',updated_at=? WHERE stripe_subscription_id=? AND is_founder=0",now(),sub);
    }
    if(event.type==='invoice.paid'){
      const sub=invoiceSubscriptionId(obj); if(sub)await dbRun(env,"UPDATE accounts SET subscription_status='active',updated_at=? WHERE stripe_subscription_id=? AND is_founder=0",now(),sub);
    }
    await dbRun(env,'UPDATE stripe_events SET processed_at=? WHERE event_id=?',now(),event.id); return json({received:true});
  }catch(e){ return text(`webhook_processing_failed:${String(e.message||e)}`,500); }
}

async function validateLicenseToken(token,siteUrl,env){
  const lic=await readLicense(token,env); if(!lic)return {ok:false,status:401,error:'invalid_license'};
  const account=await accountById(lic.license_id,env); if(!account)return {ok:false,status:404,error:'account_not_found'};
  const normalized=normalizeSiteUrl(siteUrl); if(!normalized)return {ok:false,status:400,error:'site_required'};
  const host=hostFromSiteUrl(normalized),allowed=Array.isArray(lic.site_hosts)?lic.site_hosts:[];
  if(allowed.length&&!allowed.includes(host))return {ok:false,status:403,error:'site_not_licensed'};
  return {ok:true,account,license:lic,siteUrl:normalized,siteHost:host,plan:planForAccount(account,env)};
}
async function licenseValidate(req,env){
  const b=await bodyJson(req),token=String(b.license_key||bearer(req)||''),siteUrl=b.site_url||req.headers.get('x-wpv-site')||req.headers.get('x-wpgo-site')||'';
  const v=await validateLicenseToken(token,siteUrl,env); if(!v.ok)return json({status:'invalid',error:v.error},v.status);
  return json({status:'active',license_id:v.account.id,plan:v.plan.id,site_hosts:v.license.site_hosts||[],features:['updates','support','metering','account-connect'],expires_at:v.license.exp});
}
async function licenseIssueAdmin(req,env){
  const token=bearer(req); if(!env.ADMIN_TOKEN||!constantTimeEqual(token,env.ADMIN_TOKEN))return json({error:'unauthorized'},401);
  const b=await bodyJson(req),account=await accountById(String(b.license_id||''),env); if(!account)return json({error:'account_not_found'},404);
  const hosts=Array.isArray(b.site_hosts)?b.site_hosts.map(x=>String(x).trim().toLowerCase()).filter(Boolean).slice(0,100):[];
  const license_key=await makeLicense(account,hosts,env); return json({license_key,record:{license_id:account.id,status:'active',plan:planForAccount(account,env).id,site_hosts:hosts}});
}
async function accountLicense(account,req,env){
  const b=await bodyJson(req),hosts=Array.isArray(b.site_hosts)?b.site_hosts.map(x=>String(x).trim().toLowerCase()).filter(Boolean).slice(0,100):[];
  return json({ok:true,license_key:await makeLicense(account,hosts,env),record:{license_id:account.id,status:'active',plan:planForAccount(account,env).id,site_hosts:hosts}});
}
async function registerSite(account,req,env){
  const b=await bodyJson(req),siteUrl=normalizeSiteUrl(b.site_url); if(!siteUrl)return json({error:'invalid_site_url'},400);
  const host=hostFromSiteUrl(siteUrl),label=cleanText(b.label||host,100),ts=now(),existing=await dbFirst(env,'SELECT id FROM sites WHERE account_id=? AND site_host=?',account.id,host);
  if(existing)await dbRun(env,'UPDATE sites SET site_url=?,label=?,updated_at=? WHERE id=?',siteUrl,label,ts,existing.id);
  else await dbRun(env,'INSERT INTO sites(id,account_id,site_url,site_host,label,connected_at,updated_at) VALUES(?,?,?,?,?,?,?)',uuid(),account.id,siteUrl,host,label,ts,ts);
  const license_key=await makeLicense(account,[host],env); await audit(env,account.id,'site_registered',host);
  return json({ok:true,site:{site_url:siteUrl,site_host:host,label},license_key,plan:publicPlan(planForAccount(account,env))});
}
async function deleteSite(account,id,env){
  const row=await dbFirst(env,'SELECT * FROM sites WHERE id=? AND account_id=?',id,account.id); if(!row)return json({error:'site_not_found'},404);
  await dbRun(env,'DELETE FROM sites WHERE id=? AND account_id=?',id,account.id); await audit(env,account.id,'site_removed',row.site_host); return json({ok:true});
}
async function licenseRefresh(req,env){
  const b=await bodyJson(req),siteUrl=b.site_url||req.headers.get('x-wpv-site')||req.headers.get('x-wpgo-site')||'';
  const v=await validateLicenseToken(bearer(req),siteUrl,env); if(!v.ok)return json({ok:false,error:v.error},v.status);
  const license_key=await makeLicense(v.account,[v.siteHost],env); return json({ok:true,site_url:v.siteUrl,site_host:v.siteHost,plan:publicPlan(v.plan),previous_token_plan:v.license.plan,license_key});
}
async function meter(req,env,record){
  const b=await bodyJson(req),siteUrl=b.site_url||req.headers.get('x-wpv-site')||req.headers.get('x-wpgo-site')||'';
  const v=await validateLicenseToken(bearer(req),siteUrl,env); if(!v.ok)return json({allowed:false,error:v.error},v.status);
  const before=await usageFor(v.account,env),units=Math.max(1,Math.min(100,Number(b.units||1))),success=b.success!==false,op=cleanText(b.operation,120);
  if(!before.unlimited && success && before.remaining<units)return json({allowed:false,error:'usage_limit_reached',plan:publicPlan(v.plan),usage:before},429);
  if(record&&success)await dbRun(env,'INSERT INTO usage_events(id,account_id,site_host,operation,units,success,created_at) VALUES(?,?,?,?,?,?,?)',uuid(),v.account.id,v.siteHost,op,units,1,now());
  const usage=record?await usageFor(v.account,env):before;
  return json({ok:true,allowed:usage.unlimited||usage.remaining>=1,counted:Boolean(record&&success),plan:publicPlan(v.plan),token_plan:v.license.plan,license_refresh_required:v.license.plan!==v.plan.id,site_host:v.siteHost,usage});
}

async function supportTicket(req,env){
  const b=await bodyJson(req),type=String(b.type||'contact').toLowerCase(),email=normalizeEmail(b.email),message=cleanText(b.message,8000);
  if(!['contact','bug','feedback'].includes(type))return json({error:'invalid_type'},400); if(!validEmail(email))return json({error:'invalid_email'},400); if(message.length<10)return json({error:'message_too_short'},400);
  const source=await sha256Hex(`${req.headers.get('cf-connecting-ip')||''}|${env.SESSION_SECRET||''}`),id=uuid();
  await dbRun(env,'INSERT INTO support_tickets(id,type,email,name,subject,message,site_url,wp_version,wpvirtuoso_version,browser,severity,status,source_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,type,email,cleanText(b.name,120),cleanText(b.subject,180),message,cleanText(b.site_url,500),cleanText(b.wp_version,40),cleanText(b.wpvirtuoso_version||b.wpgo_version,40),cleanText(b.browser,500),cleanText(b.severity,40),'open',source.slice(0,24),now());
  return json({ok:true,ticket_id:id},201);
}

async function route(req,env){
  const url=new URL(req.url),path=url.pathname.replace(/\/+$/,'')||'/';
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(req,env)});
  if(path==='/health'&&req.method==='GET')return json({ok:true,service:'wp-virtuoso-engine',version:VERSION,database:true,stripe:Boolean(env.STRIPE_SECRET_KEY),email:Boolean(env.RESEND_API_KEY||String(env.DEV_AUTH||'0')==='1'),plans:Object.keys(PLANS).filter(x=>x!=='founder')});
  if(path==='/v1/plans'&&req.method==='GET')return json({currency:'EUR',billing:['monthly','yearly'],usage_window_hours:24,failed_actions_count:false,plans:Object.values(PLANS).filter(p=>p.id!=='founder').map(publicPlan)});
  if(path==='/v1/auth/request-code'&&req.method==='POST')return requestCode(req,env);
  if(path==='/v1/auth/verify-code'&&req.method==='POST')return verifyCode(req,env);
  if(path==='/v1/license/validate'&&req.method==='POST')return licenseValidate(req,env);
  if(path==='/v1/admin/license/issue'&&req.method==='POST')return licenseIssueAdmin(req,env);
  if(path==='/v1/license/refresh'&&req.method==='POST')return licenseRefresh(req,env);
  if(path==='/v1/meter/check'&&req.method==='POST')return meter(req,env,false);
  if((path==='/v1/meter/record'||path==='/v1/meter/consume')&&req.method==='POST')return meter(req,env,true);
  if(path==='/v1/billing/webhook'&&req.method==='POST')return stripeWebhook(req,env);
  if(path==='/v1/support/ticket'&&req.method==='POST')return supportTicket(req,env);

  const account=await authenticatedAccount(req,env);
  if(path.startsWith('/v1/account')||path.startsWith('/v1/sites')||path.startsWith('/v1/billing')){
    if(!account)return json({error:'authentication_required'},401);
  }
  if(path==='/v1/account'&&req.method==='GET')return json({account:{id:account.id,email:account.email,plan:publicPlan(planForAccount(account,env)),subscription_status:account.subscription_status,subscription_current_period_end:account.subscription_current_period_end,usage:await usageFor(account,env)}});
  if(path==='/v1/account/sites'&&req.method==='GET')return json({sites:await dbAll(env,'SELECT id,site_url,site_host,label,connected_at,updated_at FROM sites WHERE account_id=? ORDER BY connected_at DESC',account.id)});
  if(path==='/v1/account/license'&&req.method==='POST')return accountLicense(account,req,env);
  if(path==='/v1/sites/register'&&req.method==='POST')return registerSite(account,req,env);
  const siteDelete=path.match(/^\/v1\/account\/sites\/([a-zA-Z0-9-]+)$/); if(siteDelete&&req.method==='DELETE')return deleteSite(account,siteDelete[1],env);
  if(path==='/v1/account/billing'&&req.method==='GET')return json(await billingSummary(account,env));
  if(path==='/v1/billing/checkout'&&req.method==='POST')return checkout(req,env,account);
  if(path==='/v1/billing/portal'&&req.method==='POST'){
    try{const s=await createBillingPortal(account,env);return json({url:s.url});}catch(e){return json({error:String(e.message||e)},e.message==='no_billing_account'?409:503);}
  }
  return json({error:'not_found'},404);
}

export default {
  async fetch(req,env){
    try { return withCors(await route(req,env),req,env); }
    catch(e){ console.error(e); return withCors(json({error:'server_error',message:String(env.DEV_AUTH||'0')==='1'?String(e.message||e):undefined},500),req,env); }
  }
};
