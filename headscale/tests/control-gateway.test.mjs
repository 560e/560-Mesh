import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer,request as httpRequest} from "node:http";
import {readFile} from "node:fs/promises";
import {connect} from "node:net";
const {createControlGateway}=await import(process.env.TEST_GATEWAY_MODULE??new URL("../../head-docker/platform/control-gateway.mjs",import.meta.url));
async function listen(server){await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));return server.address().port;}
async function fixture(t,handler){const upstream=createServer(handler);const peers=new Set();upstream.on("connection",socket=>{peers.add(socket);socket.once("close",()=>peers.delete(socket));});const port=await listen(upstream);const gateway=createControlGateway({homepage:"<h1>Public download</h1>",upstreamPort:port});const front=await listen(gateway.server);t.after(async()=>{await gateway.dispose();for(const peer of peers)peer.destroy();await new Promise(resolve=>upstream.close(resolve));});return {upstream,front};}
function request(port,path="/",method="GET",body="",headers={}){return new Promise((resolve,reject)=>{const r=httpRequest({hostname:"127.0.0.1",port,path,method,headers,agent:false},response=>{let content="";response.on("data",b=>content+=b);response.on("end",()=>resolve({status:response.statusCode,headers:response.headers,body:content}));});r.on("error",reject);r.end(body);});}
test("serves only the exact GET/HEAD root with privacy and content headers",async t=>{
 let forwarded=0;const x=await fixture(t,(_q,r)=>{forwarded++;r.writeHead(404);r.end("upstream");});
 const get=await request(x.front,"/?download=1");assert.equal(get.status,200);assert.match(get.body,/Public download/);assert.equal(get.headers["referrer-policy"],"no-referrer");assert.match(get.headers["content-security-policy"],/frame-ancestors 'none'/);
 const head=await request(x.front,"/","HEAD");assert.equal(head.status,200);assert.equal(head.body,"");assert.equal(head.headers["content-length"],String(Buffer.byteLength("<h1>Public download</h1>")));
 assert.equal(forwarded,0);assert.equal((await request(x.front,"/","POST","test")).status,404);assert.equal((await request(x.front,"/other")).status,404);
});
test("streams non-root methods, query parameters and control/auth headers unchanged",async t=>{
 const x=await fixture(t,(q,r)=>{let data="";q.on("data",b=>data+=b);q.on("end",()=>{r.setHeader("X-Control-Result","yes");r.end(JSON.stringify({method:q.method,url:q.url,host:q.headers.host,auth:q.headers.authorization,data}));});});
 const result=await request(x.front,"/api/v1/node?user=a%2Bb","POST","payload",{host:"control.example.com",authorization:"Bearer fixture"});
 assert.equal(result.status,200);assert.equal(result.headers["x-control-result"],"yes");assert.deepEqual(JSON.parse(result.body),{method:"POST",url:"/api/v1/node?user=a%2Bb",host:"control.example.com",auth:"Bearer fixture",data:"payload"});
});
test("preserves upgraded bidirectional traffic including early client/server bytes",async t=>{
 const x=await fixture(t,(_q,r)=>r.end("normal"));
 x.upstream.on("upgrade",(_q,socket,head)=>{socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\nSERVER-FIRST");if(head.length)socket.write("ECHO:"+head);socket.on("data",b=>socket.write("ECHO:"+b));});
 await new Promise((resolve,reject)=>{
  const socket=connect(x.front,"127.0.0.1");let data="",sent=false;const timer=setTimeout(()=>{socket.destroy();reject(new Error("upgrade stalled"));},2000);
  socket.on("error",reject);socket.on("connect",()=>socket.write("GET /ts2021?x=1 HTTP/1.1\r\nHost: control.example.com\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\nEARLY"));
  socket.on("data",b=>{data+=b;if(!sent&&data.includes("SERVER-FIRST")){sent=true;socket.write("LATE");}if(data.includes("ECHO:EARLY")&&data.includes("ECHO:LATE")){clearTimeout(timer);socket.destroy();resolve();}});
 });
});
test("returns a generic failure if the control backend is unavailable",async t=>{
 const gateway=createControlGateway({homepage:"hello",upstreamPort:1});const port=await listen(gateway.server);t.after(()=>gateway.dispose());
 const result=await request(port,"/health");assert.equal(result.status,502);assert.doesNotMatch(result.body,/127\.0\.0\.1|8081|stack|ECONNREFUSED/);
});

test("starts gateway between control and console while keeping legacy mode available",async()=>{
 const {platformServices}=await import(new URL("./supervisor.mjs",process.env.TEST_GATEWAY_MODULE??new URL("../../head-docker/platform/control-gateway.mjs",import.meta.url)));
 const enabled=platformServices(true),legacy=platformServices(false);
 assert.deepEqual(enabled.map(service=>service.name),["headscale","gateway","headplane"]);
 assert.equal(enabled[0].healthUrl,"http://127.0.0.1:8081/health");
 assert.equal(enabled[1].healthUrl,"http://127.0.0.1:8080/health");
 assert.deepEqual(legacy.map(service=>service.name),["headscale","headplane"]);
 assert.equal(legacy[0].healthUrl,"http://127.0.0.1:8080/health");
});

test("public homepage exposes only generic guidance and official current download links",async()=>{
 const html=await readFile(new URL("../public/client-home/index.html",import.meta.url),"utf8");
 assert.doesNotMatch(html,/headscale|headplane|adminis|560e\.com|hskey-auth|192\.168\.|<script\b|<form\b/i);
 const links=[...html.matchAll(/href="([^"]+)"/g)].map(match=>match[1]).filter(link=>!link.startsWith("#"));
 assert.ok(links.length>=5);
 for(const link of links){const url=new URL(link);assert.equal(url.protocol,"https:");assert.ok(["tailscale.com","pkgs.tailscale.com"].includes(url.hostname));}
 assert.match(html,/tailscale-setup-latest\.exe/);assert.match(html,/Tailscale-latest-macos\.pkg/);
});

test("renders a configurable public title live and escapes it as text",async t=>{
 let title="Team & Connect";const gateway=createControlGateway({homepage:'<title>连接助手 · 客户端下载</title><span data-site-title>连接助手</span>',resolveTitle:async()=>title,upstreamPort:1});const port=await listen(gateway.server);t.after(()=>gateway.dispose());
 let result=await request(port);assert.match(result.body,/<span data-site-title>Team &amp; Connect<\/span>/);
 title="<script>unsafe</script>";result=await request(port);assert.doesNotMatch(result.body,/<script>/);assert.match(result.body,/&lt;script&gt;/);
});
