import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function resolvePublishConfig({username,token,eventName,refType,refName,imageTag,publishLatest=false}){
 if(typeof username!=='string'||!username.trim())throw new Error('请先配置 Repository Variable: DOCKERHUB_USERNAME。');
 if(typeof token!=='string'||!token.trim())throw new Error('请先配置 Repository Secret: DOCKERHUB_TOKEN。');
 const owner=username.trim();
 if(!/^[a-z0-9][a-z0-9_-]*$/.test(owner))throw new Error('DOCKERHUB_USERNAME 应为小写 Docker Hub 用户名。');
 let version,latest=false;
 if(eventName==='push'&&refType==='tag'){
  const match=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(refName??'');
  if(!match||match[4]?.split('.').some(id=>/^\d+$/.test(id)&&id.length>1&&id.startsWith('0')))throw new Error('版本标签必须为 vX.Y.Z 或 vX.Y.Z-rc.1，不含构建元数据。');
  version=refName.slice(1);latest=!match[4];
 }else if(eventName==='workflow_dispatch'){
  version=imageTag;latest=publishLatest===true;
  if(version==='latest'&&!latest)throw new Error('直接发布 latest 时，请勾选 publish_latest。');
 }else throw new Error('仅允许手动触发或推送版本标签发布镜像。');
 if(typeof version!=='string'||! /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version))throw new Error('镜像标签只能使用字母、数字、下划线、点和横线，最长128字符。');
 const image=owner+'/560-mesh';
 return {image,version,tags:[...new Set([image+':'+version,...(latest?[image+':latest']:[])])]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const config=resolvePublishConfig({
   username:process.env.DOCKERHUB_USERNAME,token:process.env.DOCKERHUB_TOKEN,
   eventName:process.env.EVENT_NAME,refType:process.env.REF_TYPE,refName:process.env.REF_NAME,
   imageTag:process.env.INPUT_IMAGE_TAG,publishLatest:process.env.INPUT_PUBLISH_LATEST==='true'
  });
  if(!process.env.GITHUB_OUTPUT)throw new Error('缺少 GITHUB_OUTPUT。');
  appendFileSync(process.env.GITHUB_OUTPUT,'username='+config.image.split('/')[0]+'\nimage='+config.image+'\nversion='+config.version+'\ntags<<MESH_IMAGE_TAGS\n'+config.tags.join('\n')+'\nMESH_IMAGE_TAGS\n');
  console.log('已验证发布配置：'+config.tags.join(', '));
 }catch(error){console.error('::error::'+error.message);process.exitCode=1;}
}
