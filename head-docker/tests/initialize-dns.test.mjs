import {test} from "node:test";import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";import {tmpdir} from "node:os";import {join,resolve} from "node:path";
import {initialize,validateAddress} from "../platform/initialize.mjs";
async function root(t){const r=await mkdtemp(join(tmpdir(),"optional-dns-"));t.after(()=>rm(r,{recursive:true,force:true}));return r;}
test("new deployments allow an empty domain with MagicDNS disabled",async t=>{
 const r=await root(t);await initialize({root:r,publicUrl:"https://hs.example.com",baseDomain:"",magicDNS:false,templates:resolve("config")});
 const text=await readFile(join(r,"config/headscale/config.yaml"),"utf8");assert.match(text,/magic_dns: false/);assert.match(text,/base_domain: ""/);
});
test("enabled MagicDNS requires a safe domain before writing any files",async t=>{
 const r=await root(t);
 for(const baseDomain of ["","hs.example.com","example.com"])await assert.rejects(initialize({root:r,publicUrl:"https://hs.example.com",baseDomain,magicDNS:true,templates:resolve("config")}));
 await assert.rejects(readFile(join(r,"config/headscale/config.yaml")));
});
test("reinitialization preserves existing DNS and secrets despite new default flags",async t=>{
 const r=await root(t);const common={root:r,publicUrl:"https://hs.example.com",templates:resolve("config")};
 await initialize({...common,baseDomain:"tail.example.com"});
 const hs=await readFile(join(r,"config/headscale/config.yaml"),"utf8"),hp=await readFile(join(r,"config/headplane/config.yaml"),"utf8");
 assert.match(hs,/magic_dns: true/);
 await initialize({...common,baseDomain:"",magicDNS:false});
 assert.equal(await readFile(join(r,"config/headscale/config.yaml"),"utf8"),hs);assert.equal(await readFile(join(r,"config/headplane/config.yaml"),"utf8"),hp);
});
test("public URL validation remains strict with optional DNS",()=>{
 assert.equal(validateAddress("https://hs.example.com","",false),"https://hs.example.com");
 for(const url of ["http://hs.example.com","https://hs.example.com/prefix","https://hs.example.com:8443"])assert.throws(()=>validateAddress(url,"",false));
});
