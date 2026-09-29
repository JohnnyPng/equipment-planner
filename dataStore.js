import {apiRequest, ApiError, assetPathUrl} from './supabase.js';
import {getAccessToken} from './auth.js';

const DB_NAME = 'interior-equipment-planner';
let dbPromise;
const cacheKey = (userId, projectId) => `cloud:${userId}:${projectId}`;
const listKey = (userId) => `equipment-planner-project-list:${userId}`;

function db() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
    const request = indexedDB.open(DB_NAME,1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
async function idbGet(key) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = database.transaction('projects').objectStore('projects').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function idbPut(key,value) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = database.transaction('projects','readwrite').objectStore('projects').put(value,key);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}
async function idbDelete(key) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = database.transaction('projects','readwrite').objectStore('projects').delete(key);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

export const getLegacyProject = () => idbGet('main');
export const getCachedProject = (userId,projectId) => idbGet(cacheKey(userId,projectId));
export const putCachedProject = (userId,projectId,value) => idbPut(cacheKey(userId,projectId),value);

export async function listProjects(userId) {
  try {
    const token = await getAccessToken();
    const rows = await apiRequest(`/rest/v1/projects?select=id,name,description,updated_at,revision&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc`,{token});
    localStorage.setItem(listKey(userId),JSON.stringify(rows));
    return {rows,offline:false};
  } catch (error) {
    const cached = localStorage.getItem(listKey(userId));
    if (!cached || !(error.code==='network'||error.status>=500)) throw error;
    return {rows:JSON.parse(cached),offline:true};
  }
}

function dataUrlMime(value) {
  return /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(value || '')?.[1]?.toLowerCase() || '';
}
function extension(mime) {return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];}
async function uploadAsset(userId,projectId,entityId,value) {
  const mime = dataUrlMime(value);
  if (!mime) return '';
  const path = `${userId}/${projectId}/${entityId}-${crypto.randomUUID()}.${extension(mime)}`;
  const blob = await (await fetch(value)).blob();
  const token = await getAccessToken();
  await apiRequest(`/storage/v1/object/project-assets/${assetPathUrl(path)}`,{
    method:'POST',body:blob,token,headers:{'Content-Type':mime,'cache-control':'3600','x-upsert':'false'}
  });
  return path;
}
async function downloadAsset(path) {
  const token = await getAccessToken();
  const response = await apiRequest(`/storage/v1/object/authenticated/project-assets/${assetPathUrl(path)}`,{token,raw:true});
  const blob = await response.blob();
  return new Promise((resolve,reject) => {
    const reader = new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);
  });
}
async function hydrateSnapshot(snapshot) {
  const result = structuredClone(snapshot);
  const jobs = [];
  for (const page of result.pages || []) if (String(page.background || '').startsWith('storage:')) {
    const path = page.background.slice(8);page.backgroundAssetPath=path;
    jobs.push(downloadAsset(path).then((data)=>{page.background=data;}));
  }
  for (const device of result.devices || []) if (String(device.image || '').startsWith('storage:')) {
    const path = device.image.slice(8);device.imageAssetPath=path;
    jobs.push(downloadAsset(path).then((data)=>{device.image=data;}));
  }
  await Promise.all(jobs);
  return result;
}
async function uploadPendingAssets(userId,projectId,project) {
  for (const page of project.pages) if (dataUrlMime(page.background) && !page.backgroundAssetPath) {
    page.backgroundAssetPath = await uploadAsset(userId,projectId,page.id,page.background);
  }
  for (const device of project.devices) if (dataUrlMime(device.image) && !device.imageAssetPath) {
    device.imageAssetPath = await uploadAsset(userId,projectId,device.id,device.image);
  }
}
function cloudSnapshot(project) {
  const snapshot = structuredClone(project);
  for (const page of snapshot.pages) if (page.backgroundAssetPath) page.background=`storage:${page.backgroundAssetPath}`;
  for (const device of snapshot.devices) if (device.imageAssetPath) device.image=`storage:${device.imageAssetPath}`;
  return snapshot;
}

export async function loadProject(userId,projectId,{forceRemote=false}={}) {
  const cache = await getCachedProject(userId,projectId);
  try {
    const token = await getAccessToken();
    const rows = await apiRequest(`/rest/v1/projects?select=id,name,description,snapshot,revision,updated_at&id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,{token});
    if (!rows.length) throw new ApiError('找不到此專案或沒有存取權限',404);
    const row = rows[0];
    if (cache?.dirty && !forceRemote) return {...cache,remoteRevision:row.revision,conflict:row.revision !== cache.revision,offline:false};
    if (cache && cache.revision === row.revision && !forceRemote) return {...cache,offline:false};
    const project = await hydrateSnapshot(row.snapshot);
    const value={project,name:row.name,description:row.description,revision:row.revision,dirty:false,updatedAt:row.updated_at};
    await putCachedProject(userId,projectId,value);
    return {...value,offline:false};
  } catch (error) {
    if (cache && (error.code==='network'||error.status>=500) && !forceRemote) return {...cache,offline:true};
    throw error;
  }
}

export async function createProject(userId,name,project,description='') {
  const id = crypto.randomUUID();
  const blankPage={id:crypto.randomUUID(),name:'未命名圖面',trade:'其他',background:'',width:1200,height:800,markers:[]};
  const token = await getAccessToken();
  const rows = await apiRequest('/rest/v1/projects?select=id,revision,updated_at',{
    method:'POST',token,headers:{Prefer:'return=representation'},
    body:{id,user_id:userId,name,description,snapshot:{version:1,pages:[blankPage],devices:[],activePageId:blankPage.id},revision:0}
  });
  const row=rows[0];
  const cache={project,name,description,revision:row.revision,dirty:true,updatedAt:row.updated_at};
  await putCachedProject(userId,id,cache);
  return {id,...cache};
}

export async function saveProject(userId,projectId,project,name,description,revision) {
  await uploadPendingAssets(userId,projectId,project);
  const token = await getAccessToken();
  const rows = await apiRequest(`/rest/v1/projects?select=id,revision,updated_at&id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}&revision=eq.${revision}`,{
    method:'PATCH',token,headers:{Prefer:'return=representation'},
    body:{name,description,snapshot:cloudSnapshot(project),revision:revision+1}
  });
  if (!rows.length) throw new ApiError('此專案在其他裝置上有較新的版本',409,'conflict');
  return rows[0];
}

export async function deleteProject(userId,projectId) {
  const token=await getAccessToken();
  await apiRequest(`/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}`,{method:'DELETE',token});
  await idbDelete(cacheKey(userId,projectId));
}
