// In-house STUN binding responder + RFC 5766TURN allocate relay core.
// RFC 5389 STUN binding + the Allocate/Refresh/relay path (short-term creds).
const crypto = require('crypto');
const dgram = require('dgram');

const STUN_MAGIC = 0x2112A442;
const STYPE = { BIND_REQUEST:0x0001, BIND_RESPONSE:0x0101, ALLOCATE:0x0003, ALLOCATE_RESPONSE:0x0103, ALLOCATE_ERROR:0x0113, REFRESH:0x0004, REFRESH_RESPONSE:0x0104, CREATE_PERM:0x003d, CREATE_PERM_RESPONSE:0x013d, CHANNEL_BIND:0x003f, CHANNEL_BIND_RESPONSE:0x013f, SEND_IND:0x0016, DATA_IND:0x0018 };
const ATTR = { MAPPED_ADDR:0x0001, USERNAME:0x0006, MSG_INTEGRITY:0x0008, ERROR_CODE:0x0009, CHANNEL_NUMBER:0x000c, LIFETIME:0x000d, XOR_PEER_ADDRESS:0x0012, DATA:0x0013, REALM:0x0014, NONCE:0x0015, XOR_RELAYED_ADDRESS:0x0016, XOR_MAPPED_ADDRESS:0x0020 };
const MAGIC = [0x21,0x12,0xa4,0x42];

function parse(buf){ if(buf.length<20)return null; const type=buf.readUInt16BE(0);const len=buf.readUInt16BE(2);const magic=buf.readUInt32BE(4); if(magic!==STUN_MAGIC) return null; if(buf.length<20+len) return null; const txId=buf.slice(8,20); const attrs=new Map(); let pos=20;const end=20+len; while(pos+4<=end){const t=buf.readUInt16BE(pos);const l=buf.readUInt16BE(pos+2);if(l>end-pos-4)break;const v=buf.slice(pos+4,pos+4+l);if(!attrs.has(t))attrs.set(t,{type:t,length:l,value:v});pos+=4+l;if(l%4)pos+=4-l%4;}return {type,length:len,txId,attrs,raw:buf}; }
function u8str(b){return b.toString('utf8').replace(/\0+$/g,'');}
function buildHeader(t,txId,len){const b=Buffer.alloc(20);b.writeUInt16BE(t,0);b.writeUInt16BE(len,2);b.writeUInt32BE(STUN_MAGIC,4); txId.copy(b,8);return b;}
function buildAttr(t,v){const pad=v.length%4===0?0:4-v.length%4;const b=Buffer.alloc(4+v.length+pad);b.writeUInt16BE(t,0);b.writeUInt16BE(v.length,2);v.copy(b,4);return b;}
function putAddr(b,ip,port){b.writeUInt16BE(port^0x2112, 2);ip.split('.').forEach((o,i)=>b[4+i]=(Number(o)&0xff) ^ MAGIC[i]);}
function encodeXorMapped(ip,port){const b=Buffer.alloc(8);b[0]=0;b[1]=0x01;b.writeUInt16BE(port ^ 0x2112, 2);ip.split('.').forEach((o,i)=>b[4+i]=(Number(o)&0xff)^MAGIC[i]);return b;}
function encodeXorRelay(ip,port){ return encodeXorMapped(ip,port); }
function xorPeerFromBuf(b){const p=b.readUInt16BE(2)^0x2112;const i=[b[4]^0x21,b[5]^0x12,b[6]^0xa4,b[7]^0x42].join('.');return {ip:i,port:p};}

// xors encoding for attrs-less peer addr
function decodeXorRelayedAttrVal(b){return xorPeerFromBuf(b);}

const cfg={ host:process.env.TRYCORD_TURN_HOST||'0.0.0.0', port:Number(process.env.TRYCORD_TURN_PORT||3478), realm:process.env.TRYCORD_TURN_REALM||'trycord-turn', user:process.env.TRYCORD_TURN_USERNAME||'trycord', password:process.env.TRYCORD_TURN_PASSWORD||'change-me-in-production' };

const allocations=new Map();
function key4(ip,port){return ip+':'+port;}

function cleanup(){const n=Date.now();for(const[k,a] of allocations.entries()){if(n>a.expiresAt){try{a.relaySocket.close();}catch{};allocations.delete(k);}}}
setInterval(cleanup,30000);

function handleBinding(socket,parsed,rinfo){
  const xm=xorMappedAddr(rinfo.address,rinfo.port);
  const body=buildAttr(ATTR.XOR_MAPPED_ADDRESS,xm);
  const out=Buffer.alloc(20+body.length);
  out.writeUInt16BE(0x0101,0);out.writeUInt16BE(body.length,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);body.copy(out,20);
  socket.send(out,0,out.length,rinfo.port,rinfo.address);
}
function xorMappedAddr(ip,port){
  const b=Buffer.alloc(8);b[0]=0;b[1]=0x01;b.writeUInt16BE(port^0x2112,2);
  ip.split('.').forEach((o,i)=>b[4+i]=(Number(o)&0xff)^[0x21,0x12,0xa4,0x42][i]);
  return b;
}

function md5(s){return crypto.createHash('md5').update(s,'utf8').digest();}
function hmacSha1(key,data){return crypto.createHmac('sha1',key).update(data).digest();}

function longTermKey(user,realm,pass){ return md5(`${user}:${realm}:${pass}`); }

function indexOfBuf(hay,needle){if(needle.length===0)return 0;for(let i=0;i<=hay.length-needle.length;i++){let ok=true;for(let j=0;j<needle.length;j++)if(hay[i+j]!==needle[j]){ok=false;break;}if(ok)return i;}return -1;}

function verifyAuth(parsed,rinfo){
  const uBuf=parsed.attrs.get(ATTR.USERNAME);const rBuf=parsed.attrs.get(ATTR.REALM);const integrity=parsed.attrs.get(ATTR_MSG_INTEGRITY);
  const nonceBuf=parsed.attrs.get(ATTR.NONCE);
  const username=uBuf?u8str(uBuf.value):null;
  const realm=rBuf?u8str(rBuf.value):cfg.realm;
  if(!username||!integrity) return {ok:false};
  const password=cfg.password;
  const key=md5(`${username}:${realm}:${password}`);
  const mi=integrity.value;
  let miPos=20;const end=20+parsed.length;let found=false;
  while(miPos+4<=end&&miPos!==null){
    const t=parsed.raw.readUInt16BE(miPos);if(t===ATTR.MSG_INTEGRITY){found=true;break;}
    const l=parsed.raw.readUInt16BE(miPos+2);miPos+=4+l;if(l%4)miPos+=4-l%4;
  }
  if(!found||miPos<20) return null;
  const canonical=Buffer.alloc(miPos);parsed.raw.copy(canonical,0,0,miPos);canonical.writeUInt16BE(miPos-20,2);
  const expected=hmacSha1(key,canonical);
  if(expected.length!==mi.length) return null;
  let diff=0;for(let i=0;i<expected.length;i++)diff|=expected[i]^mi[i];
  return diff===0?{ok:true,username,realm}:null;
}

function sendAuthChallenge(sock,parsed,rinfo){
  const nonce=crypto.randomBytes(16);
  const errVal=Buffer.from([0,0,4,1]); //401
  const body=Buffer.concat([
    buildAttr(ATTR.REALM, Buffer.from(cfg.realm,'utf8')),
    buildAttr(ATTR.NONCE, nonce),
    buildAttr(ATTR.ERROR_CODE, errVal),
  ]);
  const header=Buffer.alloc(20); header.writeUInt16BE(ALLOCATE_ERROR,0); header.writeUInt16BE(body.length,2); header.writeUInt32BE(STUN_MAGIC,4); parsed.txId.copy(header,8);
  const out=Buffer.concat([header,body]); socket.send(out,0,out.length,rinfo.port,rinfo.address);
}

function sendError(errSock,parsed,code,rinfo){
  const ecBuf=Buffer.alloc(4);ecBuf[0]=0;ecBuf[1]=0;ecBuf[2]=Math.floor(code/100)&0xff;ecBuf[3]=code%100;
  const body=buildAttr(ATTR.ERROR_CODE,ecBuf);
  const header=Buffer.alloc(20);header.writeUInt16BE(ALLOCATE_ERROR,0);header.writeUInt16BE(body.length,2);header.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(header,8);
  const out=Buffer.concat([header,body]);errSock.send(out,0,out.length,rinfo.port,rinfo.address);
}

function u8str(b){return b.toString('utf8').replace(/\0+$/g,'');}

function handleAllocate(sock,parsed,rinfo){
  const auth=verifyAuth(parsed,rinfo);
  if(!auth){sendAuthChallenge(sock,parsed,rinfo);return;}
  const key=rinfo.address+':'+rinfo.port;
  if(allocations.has(key)){const a=allocations.get(key);try{a.relay.close();}catch{};allocations.delete(key);}
  const alloc={ key, client:{ip:rinfo.address,port:rinfo.port},
                peers:new Set(), channels:new Map(),
                created:Date.now(), expires:Date.now()+600000, lifetime:600000, relay:null,relayPort:0,relayIp:null };
  const relay=dgram.createSocket('udp4');
  alloc.relaySocket=relay;
  allocations.set(key,alloc);
  relay.bind(0,'0.0.0.0',()=>{
    const inf=relay.address();
    alloc.relayIp=inf.address; alloc.relayPort=inf.port; alloc.relaySocket=relay;
    // build XOR-RELAYED-ADDRESS
    const xra=Buffer.alloc(8);xra[0]=0;xra[1]=0x01;xra.writeUInt16BE(alloc.relayPort^(STUN_MAGIC>>>16),2);alloc.relayIp.split('.').forEach((o,i)=>xra[4+i]= (Number(o)||0) ^ [0x21,0x12,0xa4,0x42][i]);
    const lifetimeBuf=Buffer.alloc(4); lifetimeBuf.writeUInt32BE(alloc.lifetime,0);
    const body=Buffer.concat([buildAttr(ATTR.LIFETIME,lifetimeBuf),buildAttr(ATTR.XOR_RELAYED_ADDRESS,xra)]);
    const header=Buffer.alloc(20);header.writeUInt16BE(ALLOCATE_RESPONSE,0);header.writeUInt16BE(body.length,2);header.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(header,8);
    const out=Buffer.concat([header,body]);socket.send(out,0,out.length,rinfo.port,rinfo.address);
    relay.on('message',(data,peer)=>{
      if(!allocations.has(key))return;
      if(alloc.peers.size>0 && !alloc.peers.has(peer.address+':'+peer.port))return;
      const xpeer=Buffer.alloc(8);xpeer[0]=0;xpeer[1]=0x01;xpeer.writeUInt16BE(peer.port^(STUN_MAGIC>>>16),2);peer.address.split('.').forEach((o,i)=>xpeer[4+i]=(Number(o)||0)^[0x21,0x12,0xa4,0x42][i]);
      const bodyBuf=Buffer.concat([buildAttr(ATTR.XOR_PEER_ADDRESS,xpeer),buildAttr(ATTR.DATA,data)]);
      const header=Buffer.alloc(20);header.writeUInt16BE(DATA_INDICATION,0);header.writeUInt16BE(bodyBuf.length,2);header.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(header,8);
      const ind=Buffer.concat([header,bodyBuf]);
      try{socket.send(ind,0,ind.length,rinfo.port,rinfo.address);}catch(e){}
    });
    relay.on('error',()=>{});
  });
  relay.on('error',()=>{});
  alloc.relaySocket=relay;
}

function handleRefresh(socket,parsed,rinfo){
  const alloc=allocations.get(rinfo.address+':'+rinfo.port);
  if(!alloc){sendError(socket,parsed.txId,437,rinfo);return;}
  const newLife=(parsed.attrs.get(ATTR.LIFETIME)
    ?parsed.attrs.get(ATTR.LIFETIME).value.readUInt32BE(0):alloc.lifetime);
  alloc.lifetime=Math.min(Math.max(newLife,600),3600);
  alloc.expiresAt=Date.now()+alloc.lifetime*1000;
  const lifetimeBuf=Buffer.alloc(4);lifetimeBuf.writeUInt32BE(alloc.lifetime,0);
  const body=buildAttr(ATTR.LIFETIME,lifetimeBuf);
  const out=Buffer.alloc(20+body.length);out.writeUInt16BE(REFRESH_RESP,0);out.writeUInt16BE(body.length,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);body.copy(out,20);socket.send(out,0,out.length,rinfo.port,rinfo.address);
}

function handleCreatePermission(socket,parsed,rinfo){
  const alloc=allocations.get(rinfo.address+':'+rinfo.port);
  if(!alloc){sendError(socket,parsed.txId,437,rinfo);return;}
  const peerBuf=parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  if(!peerBuf){sendError(socket,parsed.txId,400,rinfo);return;}
  const b=peerBuf.value;
  const port=b.readUInt16BE(2)^0x2112;
  const ip=[b[4]^0x21,b[5]^0x12,b[6]^0xa4,b[7]^0x42].join('.');
  alloc.peers.add(ip+':'+port);
  const out=Buffer.alloc(20);out.writeUInt16BE(CREATE_PERM_RESPONSE,0);out.writeUInt16BE(0,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);socket.send(out,0,out.length,rinfo.port,rinfo.address);
}

function handleChannelBind(socket,parsed,rinfo){
  const alloc=allocations.get(rinfo.address+':'+rinfo.port);
  if(!alloc){sendError(socket,parsed.txId,437,rinfo);return;}
  const chanBuf=parsed.attrs.get(ATTR.CHANNEL_NUMBER);const peerBuf=parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  if(!chanBuf||!peerBuf){sendError(socket,parsed.txId,400,rinfo);return;}
  const chan=chanBuf.value.readUInt16BE(0);
  const pb=peerBuf.value;
  const peerIp=[pb[4]^0x21,pb[5]^0x12,pb[6]^0xa4,pb[7]^0x42].join('.');
  const peerPort=pb.readUInt16BE(2)^0x2112;
  alloc.peers.add(peerIp+':'+peerPort);
  alloc.channels.set(chan, peerIp+':'+peerPort);
  const out=Buffer.alloc(20);out.writeUInt16BE(CH_BIND_RESPONSE,0);out.writeUInt16BE(0,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);
  socket.send(out,0,out.length,rinfo.port,rinfo.address);
}

function handleSendIndication(socket,parsed,rinfo){
  const alloc=allocations.get(rinfo.address+':'+rinfo.port);
  if(!alloc||!alloc.relaySocket){return;}
  const peerBuf=parsed.attrs.get(ATTR.XOR_PEER_ADDRESS);
  const dataBuf=parsed.attrs.get(ATTR.DATA);
  if(!peerBuf||!dataBuf){return;}
  const pb=peerBuf.value;
  const peerIp=[pb[4]^0x21,pb[5]^0x12,pb[6]^0xa4,pb[7]^0x42].join('.');
  const peerPort=pb.readUInt16BE(2)^0x2112;
  const peerKey=peerIp+':'+peerPort;
  if(alloc.peers.size>0 && !alloc.peers.has(peerKey)){return;}
  try{alloc.relaySocket.send(dataBuf.value,0,dataBuf.value.length,peerPort,peerIp);}catch(e){}
}

function sendAuthChallenge(socket,parsed,rinfo){
  const body=Buffer.concat([
    buildAttr(ATTR.REALM, Buffer.from(cfg.realm,'utf8')),
    buildAttr(ATTR.NONCE, crypto.randomBytes(16)),
    buildAttr(ATTR.ERROR_CODE, Buffer.from([0,0,4,1])), // 401
  ]);
  const out=Buffer.alloc(20+body.length);
  out.writeUInt16BE(ALLOCATE_ERROR,0);out.writeUInt16BE(body.length,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);body.copy(out,20);
  socket.send(out,0,out.length,rinfo.port,rinfo.address);
}

function start(config){
  const host=(config&&config.host)||'0.0.0.0';
  const port=(config&&config.port)||3478;
  const socket=dgram.createSocket('udp4');
  socket.on('message',(buf,rinfo)=>{
    const parsed=parse(buf);
    if(!parsed) return;
    switch(parsed.type){
      case 0x0001:
        {
          const xma=Buffer.alloc(8);xma[0]=0;xma[1]=0x01;xma.writeUInt16BE(rinfo.port ^ (STUN_MAGIC>>>16),2);rinfo.address.split('.').forEach((o,i)=>xma[4+i]=(Number(o)||0)^[0x21,0x12,0xa4,0x42][i]);
          const body=buildAttr(ATTR.XOR_MAPPED_ADDRESS,xma);
          const out=Buffer.alloc(20+body.length);out.writeUInt16BE(0x0101,0);out.writeUInt16BE(body.length,2);out.writeUInt32BE(STUN_MAGIC,4);parsed.txId.copy(out,8);body.copy(out,20);
          socket.send(out,0,out.length,rinfo.port,rinfo.address);
        } break;
      case ALLOCATE_REQUEST: handleAllocate(socket,parsed,rinfo); break;
      case REFRESH_REQUEST: handleRefresh(socket,parsed,rinfo); break;
      case CREATE_PERM_REQUEST: handleCreatePermission(socket,parsed,rinfo); break;
      case CHANNEL_BIND_REQUEST: handleChannelBind(socket,parsed,rinfo); break;
      case SEND_INDICATION: handleSendIndication(socket,parsed,rinfo); break;
    }
  });
  socket.on('error', (e)=>console.error('[turn] socket error',e&&e.message));
  const ivl=setInterval(()=>{
    const now=Date.now();
    for(const [k,a] of allocations.entries()){if(now>a.expiresAt){try{a.relaySocket.close();}catch{};allocations.delete(k);}}
  },30000);
  socket.bind(port,host,()=>console.log('[turn] STUN/TURN UDP on',host+':'+port));
  return {stop(){clearInterval(ivl);try{socket.close();}catch{}}};
}

function stopServer(){ /* noop */ }

// credential issuance for HTTP control plane
function issueCredentials(username) {
  // Short-term HMAC credential signed by secret key
  const expiry = Math.floor(Date.now()/1000)+3600;
  const secret = Buffer.from(process.env.TRYCORD_TURN_SECRET||'change-me-in-production-must-be-consistent','utf8');
  const key = crypto.createHmac('sha1', secret).update(`${expiry}:${username}`).digest('base64');
  return { username: `${expiry}:${username}`, password: key, ttl: 3600 };
}

if (require.main===module){
  const s=start({port:Number(process.env.TRYCORD_TURN_PORT||3478),host:process.env.TRYCORD_TURN_HOST||'0.0.0.0'});
  process.on('SIGTERM',()=>{s.stop();process.exit(0);});
  process.on('SIGINT',()=>{s.stop();process.exit(0);});
}

function stop(){/*noop*/}
module.exports = { start, stop, issueCredentials };