import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePublishConfig } from '../../.github/scripts/dockerhub-config.mjs';

const base={username:'demo-owner',token:'dummy-token-for-tests',eventName:'push',refType:'tag',refName:'v1.2.3'};
test('a stable version tag publishes its version and latest',()=>{
 assert.deepEqual(resolvePublishConfig(base),{image:'demo-owner/560-mesh',version:'1.2.3',tags:['demo-owner/560-mesh:1.2.3','demo-owner/560-mesh:latest']});
});
test('a prerelease never overwrites latest automatically',()=>{
 assert.deepEqual(resolvePublishConfig({...base,refName:'v1.2.3-rc.1'}).tags,['demo-owner/560-mesh:1.2.3-rc.1']);
});
test('manual publishing uses an explicit tag and optional latest',()=>{
 const manual={...base,eventName:'workflow_dispatch',imageTag:'edge'};
 assert.deepEqual(resolvePublishConfig(manual).tags,['demo-owner/560-mesh:edge']);
 assert.deepEqual(resolvePublishConfig({...manual,publishLatest:true}).tags,['demo-owner/560-mesh:edge','demo-owner/560-mesh:latest']);
});
test('ordinary branches and pull requests cannot resolve publication tags',()=>{
 assert.throws(()=>resolvePublishConfig({...base,refType:'branch',refName:'main'}));
 assert.throws(()=>resolvePublishConfig({...base,eventName:'pull_request'}));
});
test('missing credentials fail before building without echoing a token',()=>{
 for(const value of [{username:''},{token:''},{username:'  '},{token:'  '}]){
  assert.throws(()=>resolvePublishConfig({...base,...value}),error=>!error.message.includes(base.token));
 }
 assert.ok(!JSON.stringify(resolvePublishConfig(base)).includes(base.token));
});
test('invalid namespaces and non-version tag refs are rejected',()=>{
 for(const username of ['Bad/owner','evil\nowner','UPPER','-owner'])assert.throws(()=>resolvePublishConfig({...base,username}));
 for(const refName of ['vlatest','v01.2.3','v1.2','v1.2.3+build','v1.2.3-01'])assert.throws(()=>resolvePublishConfig({...base,refName}));
});
test('manual tags reject injected output, registry separators and excessive length',()=>{
 for(const imageTag of ['','a\nother=value','../../bad','v1:evil','a'.repeat(129)]){
  assert.throws(()=>resolvePublishConfig({...base,eventName:'workflow_dispatch',imageTag}));
 }
 assert.throws(()=>resolvePublishConfig({...base,eventName:'workflow_dispatch',imageTag:'latest'}));
 assert.deepEqual(resolvePublishConfig({...base,eventName:'workflow_dispatch',imageTag:'latest',publishLatest:true}).tags,['demo-owner/560-mesh:latest']);
});
test('CLI writes only bounded public outputs to the GitHub output file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mesh-dockerhub-')),output=join(dir,'output');
 try{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../../.github/scripts/dockerhub-config.mjs',import.meta.url))],{
   env:{...process.env,EVENT_NAME:'workflow_dispatch',REF_TYPE:'branch',REF_NAME:'main',DOCKERHUB_USERNAME:'demo-owner',DOCKERHUB_TOKEN:base.token,INPUT_IMAGE_TAG:'edge',INPUT_PUBLISH_LATEST:'false',GITHUB_OUTPUT:output},
   encoding:'utf8'
  });
  assert.equal(child.status,0,child.stderr);
  const text=readFileSync(output,'utf8');
  assert.match(text,/username=demo-owner\n/);
  assert.match(text,/image=demo-owner\/560-mesh\n/);
  assert.match(text,/tags<<MESH_IMAGE_TAGS\ndemo-owner\/560-mesh:edge\nMESH_IMAGE_TAGS\n/);
  assert.ok(!(text+child.stdout+child.stderr).includes(base.token));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
