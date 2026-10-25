import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const sessionSecret = process.env.WPGO_SESSION_SECRET || '';
const founderEmails = new Set(String(process.env.WPGO_FOUNDER_EMAILS || '').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean));
const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
const loginFrom = String(process.env.WPGO_LOGIN_FROM_EMAIL || '').trim();
const devAuth = process.env.WPGO_DEV_AUTH === '1';
const pool = databaseUrl ? new Pool({connectionString:databaseUrl, ssl:databaseUrl.includes('localhost')?false:{rejectUnauthorized:false}}) : null;
const originalPost = express.application.post;
let installed = false;
const verifyAttempts = new Map();

function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);}
function codeHash(email,code){return crypto.createHash('sha256').update(`${email}|${code}|${sessionSecret}`).digest('hex');}
async function q(text,params=[]){if(!pool)throw new Error('database_not_configured');return pool.query(text,params);}
async function getOrCreateAccount(email){
  const id=crypto.randomUUID(),isFounder=founderEmails.has(email);
  const r=await q(`INSERT INTO wpgo_accounts(id,email,plan,is_founder) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET is_founder=wpgo_accounts.is_founder OR EXCLUDED.is_founder,updated_at=NOW() RETURNING *`,
    [id,email,isFounder?'founder':'free',isFounder]);
  return r.rows[0];
}
async function invalidateCode(id){try{await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1 AND used_at IS NULL`,[id]);}catch{}}
async function sendLoginCode(email,code,id){
  if(devAuth)return {ok:true,dev_code:code};
  if(!resendApiKey||!loginFrom)return {ok:false,error:'email_delivery_not_configured'};
  const payload={
    from:loginFrom,
    to:[email],
    subject:'Your WPGo sign-in code',
    text:`Your WPGo sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
    html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h2>Sign in to WPGo</h2><p>Your one-time sign-in code is:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;padding:18px 0">${code}</div><p>This code expires in 10 minutes.</p><p style="color:#667085">If you did not request this code, you can ignore this email.</p></div>`
  };
  try{
    const r=await fetch('https://api.resend.com/emails',{
      method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${resendApiKey}`,'idempotency-key':`wpgo-login/${id}`},body:JSON.stringify(payload)
    });
    if(!r.ok){const text=await r.text().catch(()=> '');console.error(JSON.stringify({event:'login_email_failed',status:r.status,detail:text.slice(0,300)}));return{ok:false,error:'email_delivery_failed'};}
    return{ok:true};
  }catch(error){console.error(JSON.stringify({event:'login_email_failed',status:0,detail:String(error?.message||error).slice(0,300)}));return{ok:false,error:'email_delivery_failed'};}
}
async function requestCode(req,res,next){
  try{
    const email=normalizeEmail(req.body?.email);
    if(!validEmail(email))return res.status(400).json({error:'invalid_email'});
    const recent=await q(`SELECT COUNT(*)::int AS n FROM wpgo_login_codes WHERE email=$1 AND created_at>NOW()-INTERVAL '60 seconds'`,[email]);
    if(Number(recent.rows[0]?.n||0)>0)return res.status(429).json({error:'try_again_later'});
    const hourly=await q(`SELECT COUNT(*)::int AS n FROM wpgo_login_codes WHERE email=$1 AND created_at>NOW()-INTERVAL '1 hour'`,[email]);
    if(Number(hourly.rows[0]?.n||0)>=10)return res.status(429).json({error:'too_many_requests'});
    await getOrCreateAccount(email);
    await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE email=$1 AND used_at IS NULL`,[email]);
    const code=String(crypto.randomInt(100000,999999)),id=crypto.randomUUID();
    await q(`INSERT INTO wpgo_login_codes(id,email,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,[id,email,codeHash(email,code)]);
    const delivered=await sendLoginCode(email,code,id);
    if(!delivered.ok){await invalidateCode(id);return res.status(delivered.error==='email_delivery_not_configured'?503:502).json({error:delivered.error});}
    console.log(JSON.stringify({event:'login_code_sent',email_hash:crypto.createHash('sha256').update(email).digest('hex').slice(0,12),id,delivery:devAuth?'development':'email'}));
    res.json({ok:true,delivery:devAuth?'development':'email',expires_minutes:10,...(devAuth?{dev_code:delivered.dev_code}:{})});
  }catch(error){next(error);}
}
function verifyRateLimit(req,res,next){
  const email=normalizeEmail(req.body?.email),ip=String(req.ip||req.socket?.remoteAddress||'');
  const key=crypto.createHash('sha256').update(`${ip}|${email}`).digest('hex'),now=Date.now();
  const row=verifyAttempts.get(key)||{count:0,reset:now+10*60*1000};
  if(row.reset<=now){row.count=0;row.reset=now+10*60*1000;}
  row.count++;verifyAttempts.set(key,row);
  if(row.count>20)return res.status(429).json({error:'too_many_attempts'});
  next();
}
setInterval(()=>{const now=Date.now();for(const[k,v]of verifyAttempts)if(v.reset<=now)verifyAttempts.delete(k);},5*60*1000).unref();

export function installLoginEmailRouteGuard(){
  if(installed)return;installed=true;
  express.application.post=function(path,...handlers){
    if(path==='/v1/auth/request-code')return originalPost.call(this,path,requestCode);
    if(path==='/v1/auth/verify-code')return originalPost.call(this,path,verifyRateLimit,...handlers);
    return originalPost.call(this,path,...handlers);
  };
}
export function restoreLoginEmailRouteGuard(){if(!installed)return;express.application.post=originalPost;installed=false;}
