import {createServer,request} from "node:http";
import {connect} from "node:net";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);}
function renderTitle(page,title){const escaped=escapeHtml(title);return Buffer.from(page.toString("utf8").replace(/<title>[\s\S]*?<\/title>/i,()=>"<title>"+escaped+" · 客户端下载</title>").replace(/(<span data-site-title>)[\s\S]*?(<\/span>)/i,(_match,start,end)=>start+escaped+end));}
export function createControlGateway({homepage,resolveTitle,upstreamHost="127.0.0.1",upstreamPort=8081}){
 const page=Buffer.isBuffer(homepage)?homepage:Buffer.from(homepage);
 const sockets=new Set(),tunnels=new Set(),requests=new Set();
 const server=createServer(async(req,res)=>{
  const root=(req.url??"").split("?")[0]==="/";
  if(root&&(req.method==="GET"||req.method==="HEAD")){
   let content=page;
   if(resolveTitle){let title="连接助手";try{title=await resolveTitle();}catch{}content=renderTitle(page,title);}
   res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":content.length,"Cache-Control":"no-cache","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
   res.end(req.method==="HEAD"?undefined:content);return;
  }
  const upstream=request({hostname:upstreamHost,port:upstreamPort,method:req.method,path:req.url,headers:req.headers,agent:false},response=>{
   res.writeHead(response.statusCode??502,response.headers);
   response.on("error",()=>res.destroy());response.pipe(res);
  });
  requests.add(upstream);upstream.once("close",()=>requests.delete(upstream));
  upstream.once("error",()=>{
   if(res.destroyed)return;
   if(res.headersSent)res.destroy();
   else {res.writeHead(502,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});res.end("服务暂不可用，请稍后重试。");}
  });
  req.on("aborted",()=>upstream.destroy());
  req.on("error",()=>upstream.destroy());
  res.on("close",()=>{if(!res.writableFinished)upstream.destroy();});
  req.pipe(upstream);
 });
 // Long-lived control streams are governed by Headscale, not an extra gateway request timeout.
 server.requestTimeout=0;
 server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
 server.on("clientError",(_error,socket)=>socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
 server.on("upgrade",(req,socket,head)=>{
  if((req.url??"").split("?")[0]==="/"){socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");return;}
  socket.setTimeout(0);
  let connected=false;
  const upstream=connect(upstreamPort,upstreamHost,()=>{
   connected=true;
   let headers=req.method+" "+req.url+" HTTP/"+req.httpVersion+"\r\n";
   for(let i=0;i<req.rawHeaders.length;i+=2)headers+=req.rawHeaders[i]+": "+req.rawHeaders[i+1]+"\r\n";
   upstream.write(headers+"\r\n");
   if(head.length)upstream.write(head);
   socket.pipe(upstream);upstream.pipe(socket);
  });
  tunnels.add(upstream);
  const timer=setTimeout(()=>{upstream.destroy();socket.destroy();},10000);timer.unref?.();
  upstream.once("data",()=>clearTimeout(timer));
  upstream.once("error",()=>{
   if(!connected&&!socket.destroyed)socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
   else socket.destroy();
  });
  upstream.once("close",()=>{clearTimeout(timer);tunnels.delete(upstream);socket.destroy();});
  socket.once("error",()=>upstream.destroy());
  socket.once("close",()=>upstream.destroy());
 });
 return {server,async dispose(){
  for(const req of requests)req.destroy();
  for(const socket of tunnels)socket.destroy();
  for(const socket of sockets)socket.destroy();
  await new Promise(done=>server.close(()=>done()));
 }};
}
async function cli(){
 const homepage=await readFile(process.env.PLATFORM_PUBLIC_HOME??"/opt/560-platform/public-home/index.html");
 const {readPublicSiteTitle}=await import("/app/build/platform/network-runtime.mjs");
 const gateway=createControlGateway({homepage,resolveTitle:()=>readPublicSiteTitle()});
 gateway.server.listen(8080,"0.0.0.0",()=>console.log("[gateway] 公共下载页与控制转发已就绪。"));
 const shutdown=()=>{void gateway.dispose().then(()=>process.exit(0));};
 process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(()=>{console.error("[gateway] 启动失败。");process.exitCode=1;});
