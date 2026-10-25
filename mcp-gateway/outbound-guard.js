import dns from 'node:dns/promises';
import net from 'node:net';

const nativeFetch = globalThis.fetch.bind(globalThis);
const port = Number(process.env.PORT || 8095);
const blocked = new net.BlockList();
[
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
].forEach(([ip,prefix])=>blocked.addSubnet(ip,prefix,'ipv4'));
[
  ['::',128],['::1',128],['100::',64],['2001:db8::',32],['2001:10::',28],
  ['2001:20::',28],['fc00::',7],['fe80::',10],['ff00::',8]
].forEach(([ip,prefix])=>blocked.addSubnet(ip,prefix,'ipv6'));

const explicitTestPorts = new Set(
  process.env.NODE_ENV === 'test'
    ? String(process.env.WPGO_TEST_ALLOW_LOOPBACK_PORTS || '')
        .split(',')
        .map(value => Number(value.trim()))
        .filter(value => Number.isInteger(value) && value > 0 && value <= 65535)
    : []
);

function loopbackHost(hostname){
  return ['127.0.0.1','localhost','[::1]','::1'].includes(String(hostname||'').toLowerCase());
}
function localSelfTest(u){
  return loopbackHost(u.hostname) && Number(u.port || (u.protocol==='https:'?443:80)) === port;
}
function explicitRcTestTarget(u){
  if(process.env.NODE_ENV !== 'test' || !loopbackHost(u.hostname))return false;
  const targetPort=Number(u.port || (u.protocol==='https:'?443:80));
  return u.protocol==='https:' && explicitTestPorts.has(targetPort);
}
function mappedIpv4(address){
  const a=String(address||'').toLowerCase();
  let m=a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(m)return m[1];
  m=a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if(!m)return '';
  const hi=parseInt(m[1],16),lo=parseInt(m[2],16);
  return `${hi>>8}.${hi&255}.${lo>>8}.${lo&255}`;
}
async function assertPublicTarget(value){
  const u = new URL(typeof value === 'string' || value instanceof URL ? String(value) : String(value?.url || ''));
  if(localSelfTest(u) || explicitRcTestTarget(u))return;
  if(!['https:'].includes(u.protocol))throw new Error('WPGo outbound requests require HTTPS.');
  const records = await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!records.length)throw new Error('WPGo could not resolve the remote host.');
  for(const record of records){
    const mapped=mappedIpv4(record.address);
    if(mapped&&blocked.check(mapped,'ipv4'))throw new Error('WPGo refused a private or reserved network target.');
    const family=record.family===6?'ipv6':'ipv4';
    if(!mapped&&blocked.check(record.address,family))throw new Error('WPGo refused a private or reserved network target.');
  }
}

globalThis.fetch = async (input, init) => {
  await assertPublicTarget(input);
  return nativeFetch(input, init);
};
