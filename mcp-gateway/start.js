import crypto from 'node:crypto';
import './outbound-guard.js';
import './server-v2.js';

const port = Number(process.env.PORT || 8095);
const local = `http://127.0.0.1:${port}`;
const publicBase = String(process.env.WPGO_MCP_PUBLIC_BASE || local).replace(/\/$/,'');
const testSite = String(process.env.WPGO_MCP_TEST_SITE || '').replace(/\/$/,'');
const redisExpected = Boolean(String(process.env.REDIS_URL || '').trim());

async function request(url, options={}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data=null; try{data=text?JSON.parse(text):null;}catch{}
  return {status:r.status,ok:r.ok,text,data,headers:r.headers};
}
async function selfTest(){
  const checks={};
  try{
    const health=await request(`${local}/health`);
    checks.health=health.ok&&health.data?.ok===true;
    checks.approval_proxy=health.data?.approval_proxy===true;
    checks.oauth_state_store=!redisExpected||health.data?.oauth_code_store==='redis';
    const prm=await request(`${local}/.well-known/oauth-protected-resource/mcp`); checks.resource_metadata=prm.ok&&prm.data?.resource===`${publicBase}/mcp`;
    const asm=await request(`${local}/.well-known/oauth-authorization-server`); checks.authorization_metadata=asm.ok&&asm.data?.authorization_endpoint===`${publicBase}/oauth/authorize`&&asm.data?.token_endpoint===`${publicBase}/oauth/token`;
    const reg=await request(`${local}/oauth/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'WPGo startup self-test',redirect_uris:['https://client.example.test/callback']})});
    checks.dynamic_client_registration=reg.status===201&&typeof reg.data?.client_id==='string';
    if(checks.dynamic_client_registration){
      const verifier='wpgo-startup-verifier-012345678901234567890123456789';
      const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
      const u=new URL(`${local}/oauth/authorize`);
      u.searchParams.set('response_type','code');u.searchParams.set('client_id',reg.data.client_id);u.searchParams.set('redirect_uri','https://client.example.test/callback');u.searchParams.set('code_challenge',challenge);u.searchParams.set('code_challenge_method','S256');u.searchParams.set('resource',`${publicBase}/mcp`);u.searchParams.set('scope','mcp');
      const ar=await request(u.toString()); checks.authorization_page=ar.status===200&&ar.text.includes('Connect WPGo');
    }
    const mcp=await request(`${local}/mcp`,{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    checks.mcp_oauth_challenge=mcp.status===401&&String(mcp.headers.get('www-authenticate')||'').includes('resource_metadata=');
    if(testSite){
      const idx=await request(`${testSite}/wp-json/`);const routes=idx.data?.routes||{};
      checks.wordpress_reachable=idx.ok;
      checks.wpgo_detected=idx.ok&&Object.keys(routes).some(k=>k.startsWith('/wpgo/v1'));
      checks.application_password_auth=Boolean(idx.data?.authentication?.['application-passwords']?.endpoints?.authorization);
    }
  }catch(error){checks.exception=String(error?.message||error).slice(0,300);}
  const required=['health','approval_proxy','oauth_state_store','resource_metadata','authorization_metadata','dynamic_client_registration','authorization_page','mcp_oauth_challenge'];
  if(testSite)required.push('wordpress_reachable','wpgo_detected','application_password_auth');
  console.log(JSON.stringify({event:'wpgo_mcp_self_test',ok:required.every(k=>checks[k]===true),checks}));
}
setTimeout(()=>void selfTest(),1200);
