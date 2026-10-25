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
  ['::',128],['::1',128],['::ffff:0:0',96],['100::',64],['2001:db8::',32],['2001:10::',28],
  ['2001:20::',28],['fc00::',7],['fe80::',10],['ff00::',8]
].forEach(([ip,prefix])=>blocked.addSubnet(ip,prefix,'ipv6'));

function localSelfTest(u){
  return ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && Number(u.port || (u.protocol==='https:'?443:80)) === port;
}
async function assertPublicTarget(value){
  const u = new URL(typeof value === 'string' || value instanceof URL ? String(value) : String(value?.url || ''));
  if(localSelfTest(u))return;
  if(!['https:'].includes(u.protocol))throw new Error('WPGo outbound requests require HTTPS.');
  const records = await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!records.length)throw new Error('WPGo could not resolve the remote host.');
  for(const record of records){
    const family = record.family===6?'ipv6':'ipv4';
    if(blocked.check(record.address,family))throw new Error('WPGo refused a private or reserved network target.');
  }
}

globalThis.fetch = async (input, init) => {
  await assertPublicTarget(input);
  return nativeFetch(input, init);
};
