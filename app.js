import {isConfigured} from './supabase.js';
import {signIn,signUp,signOut,restoreSession,currentUser} from './auth.js';
import {listProjects,loadProject as loadCloudProject,createProject,deleteProject,getLegacyProject} from './dataStore.js?v=20260930-delete-project';
import {ProjectSync} from './sync.js?v=20260930-delete-project';

const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const money = (value) => `NT$ ${Math.round(Number(value) || 0).toLocaleString('zh-TW')}`;
const clamp = (value) => Math.max(0.015, Math.min(0.985, value));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const safeImage = (value) => typeof value === 'string' && (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(value) || /^\.\/assets\/[a-z0-9_.-]+$/i.test(value)) ? value : '';
const icon = (symbol, color) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="15" fill="${color}"/><text x="40" y="53" text-anchor="middle" font-family="sans-serif" font-size="36" fill="white">${symbol}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
};

const samplePlan = {id:uid(),name:'未命名圖面',trade:'燈具',background:'',width:1200,height:800,markers:[]};
const sampleDevices = [
  {id:uid(),name:'示範｜崁燈',price:650,image:icon('◉','#d69b6c')},
  {id:uid(),name:'示範｜吸頂燈',price:1800,image:icon('✦','#4d8591')},
  {id:uid(),name:'示範｜插座',price:450,image:icon('▣','#6c8390')},
];
let project = {version:1,pages:[samplePlan],devices:sampleDevices,activePageId:samplePlan.id};
const blankProject = () => structuredClone({version:1,pages:[samplePlan],devices:sampleDevices,activePageId:samplePlan.id});
let scope = 'page';
let selected = new Set();
let activeDeviceId = null;
let editingDeviceId = null;
let pendingDeviceImage = '';
let clipboard = [];
let toastTimer = null;
let dragState = null;
let projectId = null;
let projectName = '';
let projectDescription = '';
let syncController = null;
let authMode = 'login';

const page = () => project.pages.find((item) => item.id === project.activePageId) || project.pages[0];
const device = (id) => project.devices.find((item) => item.id === id);

function validateProject(value) {
  return value && Array.isArray(value.pages) && value.pages.length > 0 && Array.isArray(value.devices)
    && value.pages.every((item) => typeof item.id === 'string' && Array.isArray(item.markers) && Number(item.width) > 0 && Number(item.height) > 0)
    && value.devices.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && Number(item.price) >= 0);
}
function scheduleSave() {
  syncController?.markDirty();
}
function showToast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3500);
}
function render() { renderPages(); renderDevices(); renderStage(); renderQuote(); }

function renderPages() {
  $('#pageList').innerHTML = project.pages.map((item, index) => `<button class="page-card ${item.id === page().id ? 'active' : ''}" data-page-id="${escapeHtml(item.id)}" type="button"><span class="page-index">${String(index + 1).padStart(2,'0')}</span><span class="page-info"><span class="page-title">${escapeHtml(item.name)}</span><span class="page-sub">${escapeHtml(item.trade || '其他')} · ${item.markers.length} 件設備</span></span></button>`).join('');
  $('#pageList').querySelectorAll('[data-page-id]').forEach((button) => button.addEventListener('click', () => {
    project.activePageId = button.dataset.pageId; selected.clear(); activeDeviceId = null; render(); scheduleSave();
  }));
}
function renderDevices() {
  const list = $('#deviceList');
  if (!project.devices.length) list.innerHTML = '<div class="quote-empty">尚無設備<br>點選下方按鈕新增</div>';
  else list.innerHTML = project.devices.map((item) => `<div class="device-card ${activeDeviceId === item.id ? 'selected' : ''}" draggable="true" data-device-id="${escapeHtml(item.id)}" title="拖曳到圖面"><img class="device-thumb" src="${escapeHtml(safeImage(item.image) || icon('＋','#92a6a0'))}" alt=""><span class="device-info"><span class="device-title">${escapeHtml(item.name)}</span><span class="device-price">${money(item.price)} / 件</span></span><button class="device-edit" type="button" aria-label="編輯 ${escapeHtml(item.name)}" title="編輯設備">⋯</button></div>`).join('');
  list.querySelectorAll('.device-card').forEach((card) => {
    card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', card.dataset.deviceId); event.dataTransfer.effectAllowed = 'copy'; });
    card.addEventListener('click', (event) => { if (event.target.closest('.device-edit')) return; activeDeviceId = activeDeviceId === card.dataset.deviceId ? null : card.dataset.deviceId; renderDevices(); $('#stageHint').textContent = activeDeviceId ? '點一下圖面放置設備；按 Esc 可取消' : '從設備庫拖曳到圖面；拖曳空白處可框選設備'; });
    card.querySelector('.device-edit').addEventListener('click', () => openDeviceDialog(card.dataset.deviceId));
  });
}
function renderStage() {
  const current = page();
  $('#pageName').value = current.name;
  $('#pageTrade').value = current.trade || '其他';
  $('#pageDimensions').textContent = current.background ? `${current.width} × ${current.height} px` : '未設定底圖';
  $('#stage').style.aspectRatio = `${current.width} / ${current.height}`;
  const bg = safeImage(current.background);
  $('#planImage').src = bg;
  $('#planImage').hidden = !bg;
  $('#emptyPlan').hidden = !!bg;
  $('#markerLayer').innerHTML = current.markers.map((marker,index) => {
    const item = device(marker.deviceId);
    if (!item) return '';
    return `<div class="marker ${selected.has(marker.id) ? 'selected' : ''}" data-marker-id="${escapeHtml(marker.id)}" data-index="${index+1}" title="${escapeHtml(item.name)}" style="left:${clamp(Number(marker.x))*100}%;top:${clamp(Number(marker.y))*100}%"><img src="${escapeHtml(safeImage(item.image) || icon('＋','#92a6a0'))}" alt="${escapeHtml(item.name)}"></div>`;
  }).join('');
  $('#selectionStatus').textContent = selected.size ? `已選取 ${selected.size} 件 · Ctrl+C 複製 · Delete 刪除` : '未選取設備';
}
function quoteData(useScope = scope) {
  const pages = useScope === 'all' ? project.pages : [page()];
  const counts = new Map();
  for (const sheet of pages) for (const marker of sheet.markers) {
    if (device(marker.deviceId)) counts.set(marker.deviceId, (counts.get(marker.deviceId) || 0) + 1);
  }
  const rows = project.devices.filter((item) => counts.has(item.id)).map((item) => ({...item,quantity:counts.get(item.id),subtotal:counts.get(item.id)*Number(item.price)}));
  return {rows,count:rows.reduce((sum,row)=>sum+row.quantity,0),total:rows.reduce((sum,row)=>sum+row.subtotal,0)};
}
function renderQuote() {
  const result = quoteData();
  document.querySelectorAll('[data-scope]').forEach((button) => button.classList.toggle('active', button.dataset.scope === scope));
  $('#totalCount').textContent = `${result.count} 件`;
  $('#grandTotal').textContent = money(result.total);
  $('#quoteRows').innerHTML = result.rows.length ? `<div class="quote-head"><span>設備</span><span style="text-align:center">數量</span><span style="text-align:right">小計</span></div>${result.rows.map((item) => `<div class="quote-row"><span class="quote-name"><img src="${escapeHtml(safeImage(item.image) || icon('＋','#92a6a0'))}" alt=""><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></span><span class="quote-qty">${item.quantity}</span><span class="quote-price">${money(item.subtotal)}</span></div>`).join('')}` : '<div class="quote-empty">圖面上還沒有設備。<br>從左側設備庫拖曳到平面圖。</div>';
}

function pointInStage(event) {
  const bounds = $('#stage').getBoundingClientRect();
  return {x:clamp((event.clientX-bounds.left)/bounds.width),y:clamp((event.clientY-bounds.top)/bounds.height)};
}
function addMarker(deviceId, x, y) {
  if (!device(deviceId)) return;
  const marker = {id:uid(),deviceId,x:clamp(x),y:clamp(y)};
  page().markers.push(marker);
  selected = new Set([marker.id]);
  renderPages(); renderStage(); renderQuote(); scheduleSave();
}
function handleStagePointerDown(event) {
  if (event.button !== 0) return;
  const markerElement = event.target.closest('.marker');
  if (markerElement) {
    const id = markerElement.dataset.markerId;
    if (event.ctrlKey || event.metaKey || event.shiftKey) selected.has(id) ? selected.delete(id) : selected.add(id);
    else if (!selected.has(id)) selected = new Set([id]);
    renderStage();
    const start = pointInStage(event);
    const originals = page().markers.filter((item) => selected.has(item.id)).map((item) => ({id:item.id,x:item.x,y:item.y}));
    dragState = {kind:'move',start,originals,moved:false};
    $('#stage').setPointerCapture(event.pointerId);
    event.preventDefault();
  } else {
    const start = pointInStage(event);
    if (activeDeviceId) { addMarker(activeDeviceId,start.x,start.y); $('#stage').focus(); return; }
    if (!event.shiftKey) selected.clear();
    dragState = {kind:'marquee',start,additive:event.shiftKey,moved:false};
    $('#stage').setPointerCapture(event.pointerId);
    renderStage();
    $('#stage').focus();
    event.preventDefault();
  }
}
function handleStagePointerMove(event) {
  if (!dragState) return;
  const current = pointInStage(event);
  const dx = current.x - dragState.start.x;
  const dy = current.y - dragState.start.y;
  if (Math.abs(dx) + Math.abs(dy) > .004) dragState.moved = true;
  if (dragState.kind === 'move' && dragState.moved) {
    dragState.originals.forEach((original) => {
      const marker = page().markers.find((item) => item.id === original.id);
      if (marker) {marker.x=clamp(original.x+dx);marker.y=clamp(original.y+dy);}
    });
    renderStage();
  } else if (dragState.kind === 'marquee' && dragState.moved) {
    const box = $('#selectionBox');
    box.hidden = false;
    box.style.left = `${Math.min(current.x,dragState.start.x)*100}%`;
    box.style.top = `${Math.min(current.y,dragState.start.y)*100}%`;
    box.style.width = `${Math.abs(dx)*100}%`;
    box.style.height = `${Math.abs(dy)*100}%`;
  }
}
function handleStagePointerUp(event) {
  if (!dragState) return;
  if (dragState.kind === 'marquee' && dragState.moved) {
    const current = pointInStage(event);
    const left = Math.min(current.x,dragState.start.x), right = Math.max(current.x,dragState.start.x);
    const top = Math.min(current.y,dragState.start.y), bottom = Math.max(current.y,dragState.start.y);
    page().markers.forEach((item) => { if (item.x >= left && item.x <= right && item.y >= top && item.y <= bottom) selected.add(item.id); });
    renderStage();
  }
  if (dragState.kind === 'move' && dragState.moved) scheduleSave();
  $('#selectionBox').hidden = true;
  dragState = null;
}

function keyHandler(event) {
  if ($('#deviceDialog').open) return;
  if (event.target.matches('input,textarea,select') || event.target.isContentEditable) return;
  if (event.key === 'Escape') {activeDeviceId = null; selected.clear(); renderDevices(); renderStage(); $('#stageHint').textContent = '從設備庫拖曳到圖面；拖曳空白處可框選設備'; return;}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selected.size) {
    clipboard = page().markers.filter((item) => selected.has(item.id)).map((item) => ({deviceId:item.deviceId,x:item.x,y:item.y}));
    event.preventDefault(); showToast(`已複製 ${clipboard.length} 件設備`);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && clipboard.length) {
    event.preventDefault();
    const pasted = clipboard.filter((item) => device(item.deviceId)).map((item) => ({id:uid(),deviceId:item.deviceId,x:clamp(item.x+.025),y:clamp(item.y+.025)}));
    page().markers.push(...pasted); selected = new Set(pasted.map((item)=>item.id));
    clipboard = pasted.map((item) => ({deviceId:item.deviceId,x:item.x,y:item.y}));
    render(); scheduleSave(); showToast(`已貼上 ${pasted.length} 件設備`);
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) {
    event.preventDefault(); const count = selected.size;
    page().markers = page().markers.filter((item) => !selected.has(item.id)); selected.clear();
    render(); scheduleSave(); showToast(`已刪除 ${count} 件設備`);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && document.activeElement === $('#stage')) {
    event.preventDefault(); selected = new Set(page().markers.map((item)=>item.id)); renderStage();
  }
}

function openDeviceDialog(id = null) {
  editingDeviceId = id;
  const current = id ? device(id) : null;
  pendingDeviceImage = current?.image || '';
  $('#dialogTitle').textContent = current ? '編輯設備' : '新增設備';
  $('#deviceName').value = current?.name || '';
  $('#devicePrice').value = current?.price ?? 0;
  $('#deleteDevice').hidden = !current;
  renderDevicePreview();
  $('#deviceDialog').showModal();
  $('#deviceName').focus();
}
function renderDevicePreview() { $('#devicePreview').innerHTML = pendingDeviceImage ? `<img src="${escapeHtml(safeImage(pendingDeviceImage))}" alt="設備圖片預覽">` : '＋'; }
function closeDeviceDialog() { $('#deviceDialog').close(); editingDeviceId = null; pendingDeviceImage = ''; }
function saveDevice(event) {
  event.preventDefault();
  const name = $('#deviceName').value.trim(); const price = Number($('#devicePrice').value);
  if (!name || !Number.isFinite(price) || price < 0) return;
  const data = {name,price,image:pendingDeviceImage || icon('＋','#88a4a0')};
  if (editingDeviceId) {
    const existing=device(editingDeviceId);
    if (existing.image !== data.image) delete existing.imageAssetPath;
    Object.assign(existing,data);
  }
  else project.devices.push({id:uid(),...data});
  closeDeviceDialog(); render(); scheduleSave();
}

function readFileAsDataUrl(file) { return new Promise((resolve,reject) => {const reader = new FileReader();reader.onload = () => resolve(reader.result);reader.onerror = () => reject(reader.error);reader.readAsDataURL(file);}); }
function imageDimensions(src) {return new Promise((resolve,reject) => {const image = new Image();image.onload = () => resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror = reject;image.src = src;});}
async function fileToPlans(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const pdfjs = await import('./assets/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = './assets/pdf.worker.mjs';
    const pdf = await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    const plans = [];
    for (let index=1; index<=pdf.numPages; index++) {
      const pdfPage = await pdf.getPage(index);
      const base = pdfPage.getViewport({scale:1});
      const viewport = pdfPage.getViewport({scale:Math.min(2,1800/Math.max(base.width,base.height))});
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width);canvas.height = Math.ceil(viewport.height);
      await pdfPage.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      plans.push({name:`${file.name.replace(/\.pdf$/i,'')} · 第 ${index} 頁`,background:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height});
      pdfPage.cleanup();
    }
    await pdf.destroy();
    return plans;
  }
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('請選擇 PNG、JPG、WebP 或 PDF');
  const background = await readFileAsDataUrl(file);
  const dimensions = await imageDimensions(background);
  return [{name:file.name.replace(/\.[^.]+$/,''),background,...dimensions}];
}
async function importPlans(files, replace = false) {
  if (!files.length) return;
  $('#saveStatus').textContent = '讀取圖面中…';
  try {
    const all = [];
    for (const file of files) all.push(...await fileToPlans(file));
    if (replace) {
      const target = page();
      Object.assign(target,{background:all[0].background,width:all[0].width,height:all[0].height});
      delete target.backgroundAssetPath;
      if (!target.name || target.name === '未命名圖面') target.name = all[0].name;
      all.slice(1).forEach((item) => project.pages.push({id:uid(),trade:target.trade,markers:[],...item}));
    } else {
      all.forEach((item) => project.pages.push({id:uid(),trade:'其他',markers:[],...item}));
      project.activePageId = project.pages[project.pages.length-all.length].id;
    }
    selected.clear(); render(); scheduleSave(); showToast(`已加入 ${all.length} 張圖面`);
  } catch (error) { console.error(error); showToast(error.message || '圖面讀取失敗'); $('#saveStatus').textContent = '圖面讀取失敗'; }
}
function download(filename, type, content) { const blob = new Blob([content],{type});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function csvCell(value) { return `"${String(value ?? '').replace(/"/g,'""')}"`; }
function exportCsv() {
  const lines = [['圖面','工種','設備名稱','單價','數量','小計']];
  for (const sheet of project.pages) {
    const counts = new Map();
    sheet.markers.forEach((item) => counts.set(item.deviceId,(counts.get(item.deviceId)||0)+1));
    project.devices.filter((item)=>counts.has(item.id)).forEach((item) => lines.push([sheet.name,sheet.trade,item.name,item.price,counts.get(item.id),item.price*counts.get(item.id)]));
  }
  lines.push(['','','總計','',quoteData('all').count,quoteData('all').total]);
  download('設備數量與報價.csv','text/csv;charset=utf-8','\ufeff'+lines.map((row)=>row.map(csvCell).join(',')).join('\r\n'));
}
function buildPrintSheet() {
  const sections = project.pages.map((sheet) => {
    const counts = new Map();sheet.markers.forEach((item)=>counts.set(item.deviceId,(counts.get(item.deviceId)||0)+1));
    const rows = project.devices.filter((item)=>counts.has(item.id)).map((item)=>({item,quantity:counts.get(item.id)}));
    const markers = sheet.markers.map((item,index)=>{const product=device(item.deviceId);return product ? `<span style="position:absolute;left:${clamp(item.x)*100}%;top:${clamp(item.y)*100}%;transform:translate(-50%,-50%);width:19px;height:19px;background:#fff;border:1px solid #d5744e;border-radius:4px;display:grid;place-items:center"><img src="${escapeHtml(safeImage(product.image))}" style="width:16px;height:16px;object-fit:contain"></span>` : '';}).join('');
    const plan = safeImage(sheet.background) ? `<div style="position:relative;width:100%;aspect-ratio:${sheet.width}/${sheet.height};max-height:120mm;margin-top:3mm"><img class="print-plan" src="${escapeHtml(safeImage(sheet.background))}" style="width:100%;height:100%;object-fit:fill">${markers}</div>` : '';
    return `<div class="print-section"><h2>${escapeHtml(sheet.name)}｜${escapeHtml(sheet.trade)}</h2>${plan}<table><thead><tr><th>設備</th><th>單價</th><th>數量</th><th>小計</th></tr></thead><tbody>${rows.map(({item,quantity})=>`<tr><td>${escapeHtml(item.name)}</td><td>${money(item.price)}</td><td>${quantity}</td><td>${money(quantity*item.price)}</td></tr>`).join('') || '<tr><td colspan="4">尚無設備</td></tr>'}</tbody></table></div>`;
  }).join('');
  $('#printSheet').innerHTML = `<h1>設備配置與報價單</h1><div class="print-meta">列印日期：${new Date().toLocaleDateString('zh-TW')}　｜　共 ${project.pages.length} 張圖面</div>${sections}<div class="print-total">設備總計　${money(quoteData('all').total)}</div><div class="print-note">設備金額依單價與配置數量計算；未含施工、稅金及其他費用。</div>`;
}

function setScreen(name) {
  $('#authScreen').hidden=name!=='auth';
  $('#projectScreen').hidden=name!=='projects';
  $('#appShell').hidden=name!=='editor';
}
function syncStatus(status,error) {
  const labels={synced:'☁ 已同步',pending:'○ 等待同步',syncing:'↻ 同步中…',failed:'⚠ 尚未同步',offline:'○ 離線模式，尚未同步',conflict:'⚠ 雲端版本較新', 'cache-error':'⚠ 本機暫存失敗'};
  $('#saveStatus').textContent=labels[status] || status;
  $('#saveStatus').title=error?.message || '';
  $('#resolveConflict').hidden=status!=='conflict';
  if(status==='failed' && error) showToast(error.message);
}
async function showProjects() {
  syncController?.stop();syncController=null;projectId=null;
  setScreen('projects');
  $('#projectAccount').textContent=currentUser()?.email || '';
  $('#projectStatus').textContent='載入專案中…';
  try {
    const result=await listProjects(currentUser().id);
    $('#projectStatus').textContent=result.offline?'目前離線；顯示此裝置已快取的專案。':'';
    $('#projectCards').innerHTML=result.rows.length ? result.rows.map((row)=>`<div class="project-card-row"><button class="project-card" type="button" data-project-id="${escapeHtml(row.id)}"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.description || '設備配置專案')}</small></span><small>${new Date(row.updated_at).toLocaleDateString('zh-TW')}</small></button><button class="project-delete" type="button" data-delete-id="${escapeHtml(row.id)}" aria-label="刪除專案：${escapeHtml(row.name)}">刪除</button></div>`).join('') : '<div class="project-empty">尚無專案。請在下方建立或匯入備份。</div>';
    $('#projectCards').querySelectorAll('[data-project-id]').forEach((button)=>button.addEventListener('click',()=>openProject(button.dataset.projectId)));
    $('#projectCards').querySelectorAll('[data-delete-id]').forEach((button)=>button.addEventListener('click',async()=>{
      const row=result.rows.find((item)=>item.id===button.dataset.deleteId);
      if(!row || !confirm(`確定要永久刪除「${row.name}」？\n此專案的圖面、設備及報價資料將無法復原。`))return;
      button.disabled=true;button.textContent='刪除中…';
      try {
        const outcome=await deleteProject(currentUser().id,row.id);
        await showProjects();
        if(outcome.warning)$('#projectStatus').textContent=`專案已刪除，但${outcome.warning}。`;
        else showToast(`已刪除「${row.name}」`);
      } catch(error) {
        $('#projectStatus').textContent=`刪除失敗：${error.message}`;
        button.disabled=false;button.textContent='刪除';
      }
    }));
  } catch(error) {$('#projectStatus').textContent=error.message;$('#projectCards').innerHTML='';}
  try {$('#importLegacy').hidden=!validateProject(await getLegacyProject());}
  catch {$('#importLegacy').hidden=true;}
}
async function openProject(id,{forceRemote=false}={}) {
  $('#projectStatus').textContent='載入圖面中…';
  try {
    const loaded=await loadCloudProject(currentUser().id,id,{forceRemote});
    if(!validateProject(loaded.project))throw new Error('專案資料格式不正確，請從 JSON 備份還原');
    syncController?.stop();
    project=loaded.project;projectId=id;projectName=loaded.name;projectDescription=loaded.description || '';
    selected.clear();activeDeviceId=null;scope='page';
    $('#currentProjectName').value=projectName;
    $('#accountEmail').textContent=currentUser().email;
    syncController=new ProjectSync({userId:currentUser().id,projectId:id,
      getState:()=>({project,name:projectName,description:projectDescription}),
      revision:loaded.revision,dirty:loaded.dirty,conflicted:loaded.conflict,
      onStatus:syncStatus,onConflict:()=>showToast('雲端已有較新版本。請先備份本機資料，再決定是否載入雲端版本。')});
    if(loaded.offline)syncStatus('offline');
    render();setScreen('editor');
  } catch(error) {$('#projectStatus').textContent=error.message;showToast(error.message);}
}
async function createAndOpen(name,data=blankProject(),description='') {
  if(!validateProject(data))throw new Error('備份檔格式不正確');
  const copy=structuredClone(data);
  copy.pages.forEach((item)=>delete item.backgroundAssetPath);
  copy.devices.forEach((item)=>delete item.imageAssetPath);
  const created=await createProject(currentUser().id,name.trim(),copy,description);
  await openProject(created.id);
  syncController?.markDirty();
}
async function leaveAccount() {
  syncController?.stop();syncController=null;projectId=null;
  await signOut();
  $('#authPassword').value='';$('#authMessage').textContent='';
  setScreen('auth');
}

$('#addPage').addEventListener('click', () => {const item={id:uid(),name:'未命名圖面',trade:'其他',background:'',width:1200,height:800,markers:[]};project.pages.push(item);project.activePageId=item.id;selected.clear();render();scheduleSave();$('#pageName').focus();$('#pageName').select();});
$('#uploadPlans').addEventListener('click',()=>$('#planFile').click());
$('#emptyUpload').addEventListener('click',()=>$('#replaceFile').click());
$('#replacePlan').addEventListener('click',()=>$('#replaceFile').click());
$('#planFile').addEventListener('change',async(event)=>{await importPlans([...event.target.files]);event.target.value='';});
$('#replaceFile').addEventListener('change',async(event)=>{await importPlans([...event.target.files],true);event.target.value='';});
$('#pageName').addEventListener('input',(event)=>{page().name=event.target.value||'未命名圖面';renderPages();scheduleSave();});
$('#pageTrade').addEventListener('input',(event)=>{page().trade=event.target.value||'其他';renderPages();scheduleSave();});
$('#deletePage').addEventListener('click',()=>{const target=page();if(!confirm(`刪除「${target.name}」及其 ${target.markers.length} 件設備配置？`))return;project.pages=project.pages.filter((item)=>item.id!==target.id);if(!project.pages.length)project.pages.push({id:uid(),name:'未命名圖面',trade:'其他',background:'',width:1200,height:800,markers:[]});project.activePageId=project.pages[0].id;selected.clear();render();scheduleSave();});
$('#addDevice').addEventListener('click',()=>openDeviceDialog());
$('#addDeviceBottom').addEventListener('click',()=>openDeviceDialog());
$('#closeDialog').addEventListener('click',closeDeviceDialog);
$('#cancelDialog').addEventListener('click',closeDeviceDialog);
$('#deviceForm').addEventListener('submit',saveDevice);
$('#chooseDeviceImage').addEventListener('click',()=>$('#deviceImageFile').click());
$('#deviceImageFile').addEventListener('change',async(event)=>{const file=event.target.files[0];if(file){pendingDeviceImage=await readFileAsDataUrl(file);renderDevicePreview();}event.target.value='';});
$('#deleteDevice').addEventListener('click',()=>{const item=device(editingDeviceId);const used=project.pages.reduce((sum,sheet)=>sum+sheet.markers.filter((marker)=>marker.deviceId===item.id).length,0);if(!confirm(`刪除「${item.name}」？圖面上的 ${used} 個配置也會一併刪除。`))return;project.devices=project.devices.filter((record)=>record.id!==item.id);project.pages.forEach((sheet)=>sheet.markers=sheet.markers.filter((marker)=>marker.deviceId!==item.id));selected.clear();closeDeviceDialog();render();scheduleSave();});
$('#stage').addEventListener('pointerdown',handleStagePointerDown);
$('#stage').addEventListener('pointermove',handleStagePointerMove);
$('#stage').addEventListener('pointerup',handleStagePointerUp);
$('#stage').addEventListener('pointercancel',()=>{$('#selectionBox').hidden=true;dragState=null;});
$('#stage').addEventListener('dragover',(event)=>{event.preventDefault();event.dataTransfer.dropEffect='copy';});
$('#stage').addEventListener('drop',(event)=>{event.preventDefault();const id=event.dataTransfer.getData('text/plain');const point=pointInStage(event);addMarker(id,point.x,point.y);});
document.addEventListener('keydown',keyHandler);
document.querySelectorAll('[data-scope]').forEach((button)=>button.addEventListener('click',()=>{scope=button.dataset.scope;renderQuote();}));
$('#exportCsv').addEventListener('click',exportCsv);
$('#printQuote').addEventListener('click',()=>{buildPrintSheet();window.print();});
$('#exportProject').addEventListener('click',()=>download(`${projectName || '設備規劃'}-backup.json`,'application/json;charset=utf-8',JSON.stringify({...project,name:projectName,description:projectDescription})));
$('#exportPortable').addEventListener('click',async()=>{try{
  const response=await fetch('./portable-template.html');if(!response.ok)throw new Error('無法讀取可攜版範本');
  const template=await response.text();const doc=new DOMParser().parseFromString(template,'text/html');
  const bytes=new TextEncoder().encode(JSON.stringify(project));let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  doc.querySelector('#embeddedProject').textContent=btoa(binary);
  download(`${projectName || '設備規劃'}-可攜版.html`,'text/html;charset=utf-8','<!doctype html>\n'+doc.documentElement.outerHTML);
  showToast('已下載包含目前資料的可攜版 HTML');
}catch(error){showToast(error.message);}});
$('#importProject').addEventListener('click',()=>$('#backupFile').click());
$('#importBackupHome').addEventListener('click',()=>$('#backupFile').click());
$('#backupFile').addEventListener('change',async(event)=>{const file=event.target.files[0];if(!file)return;try{
  const text=await file.text();let imported;
  if(/\.html?$/i.test(file.name)){
    const doc=new DOMParser().parseFromString(text,'text/html');const encoded=doc.querySelector('#embeddedProject')?.textContent.trim();
    if(!encoded)throw new Error('此 HTML 沒有內嵌專案資料。請先在舊版工具按「下載可攜版」。');
    imported=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))));
  }else imported=JSON.parse(text);
  if(!validateProject(imported))throw new Error('備份檔格式不正確');
  const name=prompt('新專案名稱',imported.name || file.name.replace(/\.(json|html?)$/i,''));if(!name?.trim())return;
  await createAndOpen(name,imported,imported.description || '');showToast('備份已建立為新雲端專案');
}catch(error){showToast(error.message||'匯入失敗');}finally{event.target.value='';}});
$('#importLegacy').addEventListener('click',async()=>{try{const legacy=await getLegacyProject();if(!validateProject(legacy))throw new Error('找不到舊資料');const name=prompt('舊資料的新專案名稱','從此瀏覽器匯入');if(!name?.trim())return;await createAndOpen(name,legacy);showToast('舊資料已建立為雲端專案');}catch(error){showToast(error.message);}});
$('#newProjectForm').addEventListener('submit',async(event)=>{event.preventDefault();const name=$('#newProjectName').value.trim();if(!name)return;try{await createAndOpen(name);$('#newProjectName').value='';}catch(error){$('#projectStatus').textContent=error.message;}});
$('#myProjects').addEventListener('click',async()=>{await syncController?.flush();showProjects();});
$('#currentProjectName').addEventListener('input',(event)=>{projectName=event.target.value || '未命名專案';scheduleSave();});
$('#signOut').addEventListener('click',leaveAccount);
$('#signOutHome').addEventListener('click',leaveAccount);
$('#resolveConflict').addEventListener('click',async()=>{if(!confirm('載入雲端版本會捨棄這台裝置尚未同步的修改。請先備份 JSON。確定載入？'))return;await openProject(projectId,{forceRemote:true});});
$('#authMode').addEventListener('click',()=>{authMode=authMode==='login'?'signup':'login';$('#authSubmit').textContent=authMode==='login'?'登入':'建立帳號';$('#authMode').textContent=authMode==='login'?'還沒有帳號？建立帳號':'已有帳號？登入';$('#authMessage').textContent='';});
$('#authForm').addEventListener('submit',async(event)=>{event.preventDefault();$('#authMessage').textContent='處理中…';try{const email=$('#authEmail').value.trim();const password=$('#authPassword').value;if(authMode==='signup'){const result=await signUp(email,password);if(result.needsConfirmation){$('#authMessage').textContent='請到信箱確認帳號，再回來登入。';return;}}else await signIn(email,password);$('#authPassword').value='';await showProjects();}catch(error){$('#authMessage').textContent=error.message;}});

async function start() {
  $('#configNotice').hidden=isConfigured;
  $('#authSubmit').disabled=!isConfigured;
  if(!isConfigured){setScreen('auth');return;}
  const user=await restoreSession();
  if(user)await showProjects();else setScreen('auth');
}
start();
