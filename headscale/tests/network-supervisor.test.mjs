import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root=process.env.PLATFORM_DEPLOYMENT_ROOT??new URL("../../head-docker/",import.meta.url).pathname;
const {supervise,supervisePlatform}=await import(pathToFileURL(join(root,"platform/supervisor.mjs")));
async function fixture(t,name="service"){
 const root=await mkdtemp(join(tmpdir(),"hs-supervisor-network-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));
 return {name,command:process.execPath,args:[new URL("./fixtures/service.mjs",import.meta.url).pathname,JSON.stringify({name,marker:join(root,"events"),port})],healthUrl:"http://127.0.0.1:"+port+"/health"};
}
const opts={pollIntervalMs:10,readyTimeoutMs:1000,stopTimeoutMs:300,log:()=>{}};
test("acknowledges readiness only after services are healthy",async t=>{
 const service=await fixture(t),stop=new AbortController();let ready=0;
 const timer=setTimeout(()=>stop.abort(),700);t.after(()=>clearTimeout(timer));
 const code=await supervise([service],{...opts,signal:stop.signal,onReady:async()=>{ready++;stop.abort()}});
 assert.equal(code,0);assert.equal(ready,1);
});
test("controlled config change restarts processes and acknowledges the new revision",async t=>{
 const service=await fixture(t),stop=new AbortController();let request="one",rounds=0;const acknowledgments=[];
 const runtime={
  prepare:async()=>({revision:request,requestedRevision:request,configPath:"/tmp/config",pending:request==="two"}),
  revision:async()=>request,
  healthy:async c=>{acknowledgments.push(c.revision);if(c.revision==="one")request="two";else stop.abort()},
  failed:async()=>assert.fail("healthy candidate must not fail"),
  rejectPending:async()=>false,
 };
 const timer=setTimeout(()=>stop.abort(),2500);t.after(()=>clearTimeout(timer));
 assert.equal(await supervisePlatform([service],{...opts,runtime,signal:stop.signal,settingsPollMs:20}),0);
 assert.deepEqual(acknowledgments,["one","two"]);
});
test("failed new configuration falls back instead of retrying the broken revision forever",async t=>{
 const good=await fixture(t);const stop=new AbortController();let failed=false;const seen=[];
 const runtime={
  prepare:async()=>({revision:failed?"old":"new",requestedRevision:"new",configPath:"/tmp/config",pending:!failed}),
  revision:async()=>"new",
  healthy:async c=>{seen.push(c.revision);stop.abort()},
  failed:async c=>{seen.push("failed:"+c.revision);failed=true},
  rejectPending:async()=>false,
 };
 const services=()=>failed?[good]:[{name:"missing",command:"/not/a/command",healthUrl:"http://127.0.0.1:1"}];
 const timer=setTimeout(()=>stop.abort(),2000);t.after(()=>clearTimeout(timer));
 assert.equal(await supervisePlatform(services,{...opts,runtime,signal:stop.signal,settingsPollMs:20}),0);
 assert.deepEqual(seen,["failed:new","old"]);
});
