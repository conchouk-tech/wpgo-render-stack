import express from 'express';
import crypto from 'node:crypto';

const originalPost = express.application.post;
let installed = false;

function sortDeep(value){
  if(Array.isArray(value))return value.map(sortDeep);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortDeep(value[k])]));
  return value;
}
function canonical(value){return JSON.stringify(sortDeep(value));}
function signer(){
  const pem=String(process.env.WPGO_SIGNING_PRIVATE_KEY_PEM||'').replace(/\\n/g,'\n');
  if(!pem)return null;
  return payload=>({payload,signature:crypto.sign(null,Buffer.from(canonical(payload)),pem).toString('base64'),signing:'ed25519'});
}
function founderValidationWrapper(handler){
  return function(req,res,next){
    const sign=signer();
    if(!sign)return handler(req,res,next);
    let statusCode=200;
    const originalStatus=res.status.bind(res),originalJson=res.json.bind(res);
    res.status=code=>{statusCode=Number(code)||200;return res;};
    res.json=body=>{
      try{
        const payload=body?.payload;
        const founderMismatch=statusCode===403&&payload&&payload.plan==='founder'&&['site_mismatch','site_required'].includes(String(payload.status||''));
        if(founderMismatch){
          const repaired={...payload,status:'active',founder_unlimited_sites:true,checked_gmt:new Date().toISOString()};
          console.log(JSON.stringify({event:'founder_site_binding_bypass',license_id:String(payload.license_id||'').slice(0,80)}));
          return originalStatus(200).json(sign(repaired));
        }
      }catch(error){console.error(JSON.stringify({event:'founder_license_guard_error',message:String(error?.message||error).slice(0,300)}));}
      return originalStatus(statusCode).json(body);
    };
    return handler(req,res,next);
  };
}

export function installFounderLicenseGuard(){
  if(installed)return;installed=true;
  express.application.post=function(path,...handlers){
    if(path==='/v1/license/validate'&&handlers.length)return originalPost.call(this,path,...handlers.map(founderValidationWrapper));
    return originalPost.call(this,path,...handlers);
  };
}
export function restoreFounderLicenseGuard(){if(!installed)return;express.application.post=originalPost;installed=false;}
