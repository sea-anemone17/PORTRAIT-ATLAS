"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const DEFAULT_CROP = {x:.24,y:.03,w:.52,h:.27};
  const state = {
    title:"새 캐릭터", base:null, items:[], crop:{...DEFAULT_CROP},
    pageSize:40, columns:6, format:"wide", theme:"light",
    repeatStanding:true, page:0, sourceSize:null
  };
  let baseImage = null, cropBounds = null, cropDrag = null;
  let thumbnailVersion = 0, thumbnailTimer = null, saveTimer = null;
  let toastTimer = null, movingId = null, busy = false, dbPromise = null;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const MAGIC = "PATLAS01";

  const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
  const id = () => (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID() : String(Date.now())+"-"+Math.random().toString(36).slice(2);
  const formatNumber = n => String(n).padStart(2,"0");
  const filename = s => (s || "portrait-atlas").trim().replace(/[\\/:*?"<>|]+/g,"_").replace(/\s+/g,"_").slice(0,70) || "portrait-atlas";
  const naturalSort = (a,b) => a.name.localeCompare(b.name,"ko",{numeric:true,sensitivity:"base"});
  const sleepFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

  function notify(message,error=false) {
    const box=$("toast");
    box.textContent=message; box.className="toast show"+(error?" error":"");
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>box.className="toast",3600);
  }

  function db() {
    if (!("indexedDB" in window)) return Promise.reject(new Error("브라우저 저장소를 사용할 수 없습니다."));
    if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open("portrait-atlas-storage",1);
      req.onupgradeneeded=()=>{
        const data=req.result;
        if(!data.objectStoreNames.contains("files")) data.createObjectStore("files",{keyPath:"id"});
        if(!data.objectStoreNames.contains("meta")) data.createObjectStore("meta",{keyPath:"key"});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    return dbPromise;
  }
  const waitTransaction=tx=>new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error("저장소 오류"));
    tx.onabort=()=>reject(tx.error||new Error("저장 취소됨"));
  });
  const requestResult=req=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  function serialMeta() {
    return {
      title:state.title, crop:{...state.crop}, pageSize:state.pageSize,
      columns:state.columns, format:state.format, theme:state.theme,
      repeatStanding:state.repeatStanding, page:state.page,
      sourceSize:state.sourceSize, baseId:state.base?.id||null,
      items:state.items.map(x=>({id:x.id,label:x.label||""}))
    };
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>saveMeta().catch(e=>console.warn("Autosave unavailable",e)),450);
  }
  async function saveMeta() {
    const data=await db(), tx=data.transaction("meta","readwrite");
    tx.objectStore("meta").put({key:"active",value:serialMeta()});
    await waitTransaction(tx);
  }
  async function putFiles(entries) {
    if(!entries.length)return;
    const data=await db(),tx=data.transaction("files","readwrite");
    const store=tx.objectStore("files");
    entries.forEach(x=>store.put({
      id:x.id,blob:x.file,name:x.name,type:x.type,
      width:x.width||null,height:x.height||null
    }));
    await waitTransaction(tx);
  }
  async function deleteFiles(ids) {
    if(!ids.length)return;
    const data=await db(),tx=data.transaction("files","readwrite");
    ids.forEach(x=>tx.objectStore("files").delete(x));
    await waitTransaction(tx);
  }
  async function clearDb() {
    const data=await db(),tx=data.transaction(["files","meta"],"readwrite");
    tx.objectStore("files").clear(); tx.objectStore("meta").clear();
    await waitTransaction(tx);
  }

  async function measure(file) {
    const bmp=await createImageBitmap(file);
    const dimensions={width:bmp.width,height:bmp.height};
    bmp.close(); return dimensions;
  }
  function suitable(file) {
    return file && (file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name));
  }
  async function setBase(file,store=true) {
    if(!suitable(file)){notify("PNG, JPG, WEBP 이미지만 지원합니다.",true);return;}
    let dimensions;
    try {dimensions=await measure(file);}catch(e){notify("기본 이미지를 읽지 못했습니다.",true);return;}
    const oldId=state.base?.id;
    if(state.base?.url) URL.revokeObjectURL(state.base.url);
    const entry={id:id(),name:file.name,type:file.type||"image/png",file,...dimensions};
    entry.url=URL.createObjectURL(file);
    state.base=entry; state.sourceSize={...dimensions};
    $("baseFileName").textContent=file.name;
    await loadBaseImage();
    render();
    queueThumbnails();
    if(store) {
      try {await putFiles([entry]); if(oldId)await deleteFiles([oldId]); scheduleSave();}
      catch(e){notify("기기 자동저장에 실패했습니다. 프로젝트 파일로 저장해 주세요.",true);}
    }
    notify("기본 스탠딩이 등록되었습니다. 얼굴 영역을 지정해 보세요.");
  }
  function loadBaseImage() {
    return new Promise(resolve=>{
      if(!state.base){baseImage=null;drawCrop();resolve();return;}
      const img=new Image();
      img.onload=()=>{baseImage=img;drawCrop();drawSample();resolve();};
      img.onerror=()=>{baseImage=null;drawCrop();resolve();};
      img.src=state.base.url;
    });
  }
  async function addFaces(files) {
    const selections=[...files].filter(suitable).sort(naturalSort);
    if(!selections.length){notify("추가할 이미지가 없습니다.",true);return;}
    const previous=new Set(state.items.map(x=>x.name+"|"+x.file.size+"|"+(x.file.lastModified||0)));
    const incoming=selections.filter(f=>!previous.has(f.name+"|"+f.size+"|"+(f.lastModified||0)));
    if(!incoming.length){notify("선택한 이미지가 모두 이미 등록되어 있습니다.");return;}
    if(!state.sourceSize) {
      try{state.sourceSize=await measure(incoming[0]);}
      catch(e){notify("이미지를 읽을 수 없습니다.",true);return;}
    }
    const additions=incoming.map(f=>({
      id:id(),name:f.name,type:f.type||"image/png",file:f,
      label:"",thumb:null
    }));
    state.items.push(...additions);
    render(); queueThumbnails();
    try{await putFiles(additions);scheduleSave();}
    catch(e){notify("자동저장 공간이 부족할 수 있습니다. 프로젝트 파일로 저장해 주세요.",true);}
    notify(additions.length+"개 포트레이트를 추가했습니다.");
  }
  function cropPixels(width,height) {
    const c=state.crop;
    const x=clamp(Math.round(c.x*width),0,width-1);
    const y=clamp(Math.round(c.y*height),0,height-1);
    const w=clamp(Math.round(c.w*width),1,width-x);
    const h=clamp(Math.round(c.h*height),1,height-y);
    return {x,y,w,h};
  }
  async function createCroppedBitmap(file,dimensions) {
    const s=dimensions||state.sourceSize||await measure(file);
    const c=cropPixels(s.width,s.height);
    return createImageBitmap(file,c.x,c.y,c.w,c.h);
  }
  function drawContained(ctx,image,x,y,w,h) {
    const iw=image.width||image.naturalWidth,ih=image.height||image.naturalHeight;
    if(!(iw>0&&ih>0))return;
    const scale=Math.min(w/iw,h/ih);
    const dw=iw*scale,dh=ih*scale;
    ctx.drawImage(image,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  }
  function updateCardThumb(item) {
    const card=[...$("cards").children].find(el=>el.dataset.id===item.id);
    const art=card?.querySelector(".expression-art");
    if(!art||!item.thumb)return;
    let img=art.querySelector("img");
    if(!img) {
      const placeholder=art.querySelector(".muted");
      if(placeholder)placeholder.remove();
      img=document.createElement("img");
      art.insertBefore(img,art.firstChild);
    }
    img.src=item.thumb;
    img.alt=item.label||"표정 미리보기";
  }
  function queueThumbnails() {
    clearTimeout(thumbnailTimer);
    const version=++thumbnailVersion;
    state.items.forEach(x=>x.thumb=null);
    renderCards(); renderPreview();
    if(!state.items.length)return;
    thumbnailTimer=setTimeout(()=>generateThumbnails(version),180);
  }
  async function generateThumbnails(version) {
    const canvas=document.createElement("canvas");
    canvas.width=240;canvas.height=240;
    const ctx=canvas.getContext("2d");
    let finished=0;
    const entries=[...state.items];
    for(const item of entries) {
      if(version!==thumbnailVersion) return;
      try {
        const bitmap=await createCroppedBitmap(item.file);
        ctx.clearRect(0,0,240,240);
        drawContained(ctx,bitmap,7,7,226,226);
        bitmap.close();
        if(version!==thumbnailVersion) return;
        item.thumb=canvas.toDataURL("image/png");
      } catch(e) {console.warn("Thumbnail failed:",item.name,e);item.thumb=null;}
      updateCardThumb(item);
      finished++;
      if(finished%5===0||finished===entries.length){
        $("cropStatus").textContent=finished===entries.length?"크롭 적용 완료 · "+finished+"장":"얼굴 추출 중 · "+finished+" / "+entries.length;
        renderPreview();
        await sleepFrame();
      }
    }
  }
  function updateCrop(c) {
    const x=clamp(Number(c.x)||0,0,.99);
    const y=clamp(Number(c.y)||0,0,.99);
    const w=clamp(Number(c.w)||0,.01,1-x);
    const h=clamp(Number(c.h)||0,.01,1-y);
    state.crop={x,y,w,h};
    setCropInputs(); drawCrop(); drawSample(); queueThumbnails(); scheduleSave();
  }
  function setCropInputs(){
    const c=state.crop;
    [["cropX",c.x],["cropY",c.y],["cropW",c.w],["cropH",c.h]].forEach(([key,val])=>{
      $(key).value=Math.round(val*100);
    });
  }
  function drawCrop() {
    const cvs=$("cropCanvas"),ctx=cvs.getContext("2d"),w=cvs.width,h=cvs.height;
    ctx.clearRect(0,0,w,h);
    $("cropEmpty").hidden=!!baseImage;
    if(!baseImage){cropBounds=null;return;}
    const scale=Math.min((w-20)/baseImage.naturalWidth,(h-20)/baseImage.naturalHeight);
    const iw=baseImage.naturalWidth*scale,ih=baseImage.naturalHeight*scale;
    const ox=(w-iw)/2,oy=(h-ih)/2;
    cropBounds={x:ox,y:oy,w:iw,h:ih};
    ctx.drawImage(baseImage,ox,oy,iw,ih);
    const c=cropDrag ? rectFromDrag(cropDrag) : state.crop;
    const rx=ox+c.x*iw,ry=oy+c.y*ih,rw=c.w*iw,rh=c.h*ih;
    ctx.fillStyle="rgba(17,21,28,.45)";
    ctx.fillRect(ox,oy,iw,Math.max(0,ry-oy));
    ctx.fillRect(ox,ry,Math.max(0,rx-ox),rh);
    ctx.fillRect(rx+rw,ry,Math.max(0,ox+iw-rx-rw),rh);
    ctx.fillRect(ox,ry+rh,iw,Math.max(0,oy+ih-ry-rh));
    ctx.strokeStyle="#f7db9b";ctx.lineWidth=3;
    ctx.strokeRect(rx,ry,rw,rh);
    ctx.lineWidth=1;ctx.strokeStyle="rgba(255,255,255,.8)";
    ctx.strokeRect(rx+4,ry+4,Math.max(0,rw-8),Math.max(0,rh-8));
  }
  function drawSample() {
    const canvas=$("sampleCanvas"),ctx=canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!baseImage)return;
    const crop=cropPixels(baseImage.naturalWidth,baseImage.naturalHeight);
    const scale=Math.min(116/crop.w,116/crop.h);
    const w=crop.w*scale,h=crop.h*scale;
    ctx.drawImage(baseImage,crop.x,crop.y,crop.w,crop.h,(120-w)/2,(120-h)/2,w,h);
  }
  function rectFromDrag(d){
    return {x:Math.min(d.x,d.x2),y:Math.min(d.y,d.y2),w:Math.abs(d.x2-d.x),h:Math.abs(d.y2-d.y)};
  }
  function toCropPoint(e){
    const c=$("cropCanvas"),rect=c.getBoundingClientRect();
    const px=(e.clientX-rect.left)*(c.width/rect.width),py=(e.clientY-rect.top)*(c.height/rect.height);
    if(!cropBounds)return null;
    return {x:clamp((px-cropBounds.x)/cropBounds.w,0,1),y:clamp((py-cropBounds.y)/cropBounds.h,0,1)};
  }
  function bindCrop(){
    const cvs=$("cropCanvas");
    cvs.addEventListener("pointerdown",e=>{
      if(!baseImage)return;
      const p=toCropPoint(e);if(!p)return;
      cropDrag={x:p.x,y:p.y,x2:p.x,y2:p.y};
      cvs.setPointerCapture(e.pointerId);
    });
    cvs.addEventListener("pointermove",e=>{
      if(!cropDrag)return;
      const p=toCropPoint(e);if(!p)return;
      cropDrag.x2=p.x;cropDrag.y2=p.y;drawCrop();
    });
    const complete=e=>{
      if(!cropDrag)return;
      const p=toCropPoint(e);
      if(p){cropDrag.x2=p.x;cropDrag.y2=p.y;}
      const rect=rectFromDrag(cropDrag);cropDrag=null;
      if(rect.w>=.015&&rect.h>=.015)updateCrop(rect);
      else drawCrop();
    };
    cvs.addEventListener("pointerup",complete);
    cvs.addEventListener("pointercancel",()=>{cropDrag=null;drawCrop();});
    ["cropX","cropY","cropW","cropH"].forEach(id=>{
      $(id).addEventListener("change",()=>{
        updateCrop({x:Number($("cropX").value)/100,y:Number($("cropY").value)/100,
          w:Number($("cropW").value)/100,h:Number($("cropH").value)/100});
      });
    });
    $("resetCrop").addEventListener("click",()=>updateCrop(DEFAULT_CROP));
  }

  const pages=()=>Math.max(1,Math.ceil(state.items.length/state.pageSize));
  const onPage=()=>state.items.slice(state.page*state.pageSize,(state.page+1)*state.pageSize);
  function renderCounts() {
    $("faceCount").textContent=state.items.length+"장";
    $("introCount").textContent=formatNumber(state.items.length);
    $("pageNumber").textContent=formatNumber(state.page+1)+" / "+formatNumber(pages());
    $("pageDescription").textContent=state.items.length?state.items.length+"개 표정 · 페이지당 "+state.pageSize+"개":"이미지를 추가하면 도감이 만들어집니다.";
    $("prevPage").disabled=state.page===0;
    $("nextPage").disabled=state.page>=pages()-1;
    $("downloadPage").disabled=busy||!state.items.length;
    $("downloadAll").disabled=busy||!state.items.length;
  }
  function node(tag,className,text) {
    const el=document.createElement(tag);
    if(className)el.className=className;
    if(text!==undefined)el.textContent=text;
    return el;
  }
  function renderPreview() {
    const host=$("pagePreview");
    host.classList.toggle("a4",state.format==="a4");
    host.replaceChildren();
    if(!state.base&&!state.items.length){
      const empty=node("div","poster-empty");
      empty.append(node("strong",null,"✳  YOUR ATLAS BEGINS HERE"),
        node("p",null,"왼쪽에서 기본 스탠딩과 표정 파일을 불러오면 이곳에 도감이 자동으로 완성됩니다."));
      host.append(empty);return;
    }
    const poster=node("div","poster"+(state.theme==="dark"?" dark":""));
    const header=node("div","poster-top");
    const heading=node("div");
    heading.append(node("div","poster-small","P O R T R A I T  /  A T L A S"),
      node("div","poster-title",state.title||"새 캐릭터"));
    header.append(heading,node("span","poster-page",formatNumber(state.page+1)+" / "+formatNumber(pages())));
    const body=node("div","poster-body"),left=node("div","poster-left");
    const standing=node("div","poster-standing");
    if(state.base && (state.repeatStanding||state.page===0)){
      const img=document.createElement("img");img.src=state.base.url;img.alt="기본 전신 스탠딩";standing.append(img);
    }else{
      standing.append(node("span","poster-small",state.base?"EXPRESSION ARCHIVE":"NO STANDING"));
    }
    left.append(standing,node("span","poster-left-label","CHARACTER / FULL STANDING"));
    const right=node("div","poster-right"),grid=node("div","poster-grid");
    const list=onPage(),rows=Math.max(1,Math.ceil(list.length/state.columns));
    grid.style.setProperty("--cols",state.columns);
    grid.style.setProperty("--rows",rows);
    for(let i=0;i<list.length;i++){
      const item=list[i],chip=node("div","face-chip");
      if(item.thumb) {
        const img=document.createElement("img");img.src=item.thumb;img.alt=item.label||item.name;chip.append(img);
      }else chip.append(node("span","muted","…"));
      chip.append(node("span",null,item.label.trim()||formatNumber(state.page*state.pageSize+i+1)));
      grid.append(chip);
    }
    right.append(grid);body.append(left,right);poster.append(header,body);host.append(poster);
  }
  function renderCards() {
    const host=$("cards");host.replaceChildren();
    if(!state.items.length){
      const empty=node("div","empty-state");
      empty.append(node("span","empty-symbol","✳"),node("strong",null,"아직 등록된 표정이 없습니다."),
        node("p",null,"표정 스탠딩 여러 장을 한 번에 추가해 주세요."));
      host.append(empty);return;
    }
    state.items.forEach((item,index)=>{
      const card=node("article","expression-card");
      card.dataset.id=item.id;
      const art=node("div","expression-art");
      if(item.thumb) {
        const img=document.createElement("img");img.src=item.thumb;img.alt=item.label||"표정 미리보기";art.append(img);
      } else art.append(node("span","muted","얼굴 추출 중…"));
      art.append(node("span","card-index",formatNumber(index+1)));
      const actions=node("div","card-actions");
      const grab=node("button","tiny-btn","⠿");grab.type="button";grab.draggable=true;grab.title="잡고 끌어 순서 변경";grab.setAttribute("aria-label","순서 드래그");
      grab.addEventListener("dragstart",e=>{movingId=item.id;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",item.id);card.classList.add("dragging");});
      grab.addEventListener("dragend",()=>{movingId=null;document.querySelectorAll(".drag-target,.dragging").forEach(el=>el.classList.remove("drag-target","dragging"));});
      actions.append(grab);
      const up=node("button","tiny-btn","↑");up.type="button";up.title="앞으로";up.disabled=index===0;
      up.addEventListener("click",()=>moveItem(index,index-1));
      const down=node("button","tiny-btn","↓");down.type="button";down.title="뒤로";down.disabled=index===state.items.length-1;
      down.addEventListener("click",()=>moveItem(index,index+1));
      const remove=node("button","tiny-btn delete","×");remove.type="button";remove.title="표정 삭제";remove.setAttribute("aria-label","표정 삭제");
      remove.addEventListener("click",()=>removeItem(item.id));
      actions.append(up,down,remove);art.append(actions);
      const body=node("div","card-body");
      const input=document.createElement("input");
      input.className="name-input";input.type="text";input.placeholder="표정 이름 입력";input.maxLength=50;input.value=item.label||"";
      input.setAttribute("aria-label",item.name+"의 표정 이름");
      input.addEventListener("input",()=>{item.label=input.value;renderPreview();scheduleSave();});
      body.append(input,node("small","file-caption",item.name));
      card.append(art,body);
      card.addEventListener("dragover",e=>{if(!movingId)return;e.preventDefault();e.dataTransfer.dropEffect="move";card.classList.add("drag-target");});
      card.addEventListener("dragleave",()=>card.classList.remove("drag-target"));
      card.addEventListener("drop",e=>{
        e.preventDefault();card.classList.remove("drag-target");
        if(!movingId)return;
        const from=state.items.findIndex(x=>x.id===movingId);
        const to=state.items.findIndex(x=>x.id===item.id);
        if(from>=0&&to>=0&&from!==to)moveItem(from,to);
        movingId=null;
      });
      host.append(card);
    });
  }
  function render(){
    state.page=clamp(state.page,0,pages()-1);
    $("projectTitle").value=state.title;
    $("pageSize").value=String(state.pageSize);
    $("columns").value=String(state.columns);
    $("format").value=state.format;
    $("theme").value=state.theme;
    $("repeatStanding").checked=state.repeatStanding;
    $("baseFileName").textContent=state.base?.name||"클릭 또는 파일을 끌어다 놓기";
    setCropInputs();renderCounts();renderPreview();renderCards();drawCrop();drawSample();
  }
  function moveItem(from,to){
    if(from===to||from<0||to<0||to>=state.items.length)return;
    const [entry]=state.items.splice(from,1);
    state.items.splice(to,0,entry);
    renderCounts();renderCards();renderPreview();scheduleSave();
  }
  async function removeItem(itemId){
    state.items=state.items.filter(x=>x.id!==itemId);
    try{await deleteFiles([itemId]);}catch(e){console.warn(e);}
    render();scheduleSave();
  }
  function updateOptions(){
    state.pageSize=Number($("pageSize").value);
    state.columns=Number($("columns").value);
    state.format=$("format").value;
    state.theme=$("theme").value;
    state.repeatStanding=$("repeatStanding").checked;
    state.page=clamp(state.page,0,pages()-1);
    renderCounts();renderPreview();scheduleSave();
  }

  function choosePalette(){
    return state.theme==="dark"
      ? {bg:"#20232c",panel:"#2c303a",tile:"#303440",text:"#f6f2ea",muted:"#c3b5a2",line:"#4c505b"}
      : {bg:"#fffdf9",panel:"#f0ece5",tile:"#f8f5f0",text:"#292c32",muted:"#9b815f",line:"#e3ddd2"};
  }
  function fillRound(ctx,x,y,w,h,r,color){
    if(w<=0||h<=0)return;
    ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,Math.min(r,w/2,h/2));ctx.fill();
  }
  function text(ctx,value,x,y,size,color,font="sans-serif",align="left",weight=500,maxWidth=undefined){
    ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline="alphabetic";
    ctx.font=weight+" "+Math.max(8,Math.round(size))+"px "+font;
    if(Number.isFinite(maxWidth))ctx.fillText(String(value),x,y,maxWidth);
    else ctx.fillText(String(value),x,y);
  }
  async function drawPage(pageIndex){
    const [w,h]=state.format==="a4"?[3508,2480]:[2560,1440];
    const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext("2d",{alpha:false});
    const p=choosePalette();
    ctx.fillStyle=p.bg;ctx.fillRect(0,0,w,h);
    const m=Math.round(w*.043),top=Math.round(h*.055);
    text(ctx,"P O R T R A I T   /   A T L A S",m,top,Math.round(h*.017),p.muted,"sans-serif","left",700);
    text(ctx,state.title||"새 캐릭터",m,top+h*.066,h*.048,p.text,"Georgia, serif","left",500,w*.78);
    text(ctx,formatNumber(pageIndex+1)+"  /  "+formatNumber(pages()),w-m,top+h*.069,h*.027,p.muted,"Georgia, serif","right",500);
    ctx.strokeStyle=p.line;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(m,h*.165);ctx.lineTo(w-m,h*.165);ctx.stroke();
    const y=h*.198,bottom=h*.94,contentH=bottom-y;
    const leftX=m,leftW=w*.292,rightX=w*.395,rightW=w-rightX-m;
    fillRound(ctx,leftX,y,leftW,contentH-h*.034,10,p.panel);
    if(state.base && (state.repeatStanding||pageIndex===0)){
      let bmp=null;
      try{bmp=await createImageBitmap(state.base.file);drawContained(ctx,bmp,leftX+18,y+18,leftW-36,contentH-h*.055-36);}
      catch(e){console.warn("Standing export failed",e);}
      finally{if(bmp)bmp.close();}
    }else text(ctx,"EXPRESSION ARCHIVE",leftX+leftW/2,y+contentH/2,h*.02,p.muted,"sans-serif","center",500);
    text(ctx,"CHARACTER  /  FULL STANDING",leftX,y+contentH-h*.006,h*.015,p.muted,"sans-serif","left",600,leftW);
    const list=state.items.slice(pageIndex*state.pageSize,(pageIndex+1)*state.pageSize);
    const cols=state.columns,rows=Math.max(1,Math.ceil(list.length/cols));
    const gap=Math.max(9,Math.round(w*.008));
    const cellW=(rightW-gap*(cols-1))/cols;
    const cellH=(contentH-gap*(rows-1))/rows;
    for(let i=0;i<list.length;i++){
      const item=list[i],col=i%cols,row=Math.floor(i/cols);
      const x=rightX+col*(cellW+gap),cy=y+row*(cellH+gap);
      fillRound(ctx,x,cy,cellW,cellH,Math.min(9,cellH*.1),p.tile);
      let bitmap=null;
      const labelH=Math.min(Math.max(22,cellH*.20),55);
      try{
        bitmap=await createCroppedBitmap(item.file);
        drawContained(ctx,bitmap,x+cellW*.06,cy+cellH*.045,cellW*.88,cellH-labelH-cellH*.08);
      }catch(e){console.warn("Expression export failed:",item.name,e);}
      finally{if(bitmap)bitmap.close();}
      const label=item.label.trim()||formatNumber(pageIndex*state.pageSize+i+1);
      const fontSize=clamp(Math.min(cellW*.095,cellH*.16),12,31);
      text(ctx,label,x+cellW/2,cy+cellH-labelH*.33,fontSize,p.text,"sans-serif","center",650,cellW-16);
    }
    return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("PNG를 만들지 못했습니다.")),"image/png"));
  }
  function download(blob,name){
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=name;
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function crc32(bytes) {
    let c=-1;
    for(const b of bytes){
      c=(c>>>8)^CRC_TABLE[(c^b)&255];
    }
    return (c^-1)>>>0;
  }
  const CRC_TABLE=(()=>{
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;
      table[n]=c>>>0;
    }
    return table;
  })();
  function zipFiles(files){
    const local=[],central=[];let offset=0,centralSize=0;
    for(const file of files){
      const name=encoder.encode(file.name),data=file.bytes,crc=crc32(data);
      const header=new Uint8Array(30+name.length),h=new DataView(header.buffer);
      h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);
      h.setUint16(6,0x0800,true);h.setUint16(8,0,true);
      h.setUint32(14,crc,true);h.setUint32(18,data.byteLength,true);h.setUint32(22,data.byteLength,true);
      h.setUint16(26,name.length,true);header.set(name,30);
      local.push(header,data);
      const record=new Uint8Array(46+name.length),r=new DataView(record.buffer);
      r.setUint32(0,0x02014b50,true);r.setUint16(4,20,true);r.setUint16(6,20,true);
      r.setUint16(8,0x0800,true);r.setUint16(10,0,true);
      r.setUint32(16,crc,true);r.setUint32(20,data.byteLength,true);r.setUint32(24,data.byteLength,true);
      r.setUint16(28,name.length,true);r.setUint32(42,offset,true);
      record.set(name,46);central.push(record);
      offset+=header.length+data.byteLength;centralSize+=record.length;
    }
    const end=new Uint8Array(22),dv=new DataView(end.buffer);
    dv.setUint32(0,0x06054b50,true);
    dv.setUint16(8,files.length,true);dv.setUint16(10,files.length,true);
    dv.setUint32(12,centralSize,true);dv.setUint32(16,offset,true);
    return new Blob([...local,...central,end],{type:"application/zip"});
  }
  async function withBusy(fn){
    if(busy)return;busy=true;renderCounts();
    try{await fn();}
    catch(e){console.error(e);notify("작업 중 오류가 발생했습니다: "+e.message,true);}
    finally{busy=false;renderCounts();}
  }
  async function downloadCurrent() {
    if(!state.items.length)return notify("표정 이미지를 먼저 추가해 주세요.",true);
    await withBusy(async()=>{
      notify("현재 페이지를 PNG로 만들고 있습니다.");
      const blob=await drawPage(state.page);
      download(blob,filename(state.title)+"_"+formatNumber(state.page+1)+".png");
      notify("PNG를 저장했습니다.");
    });
  }
  async function downloadAll() {
    if(!state.items.length)return notify("표정 이미지를 먼저 추가해 주세요.",true);
    await withBusy(async()=>{
      const files=[];
      for(let p=0;p<pages();p++){
        notify("전체 도감 제작 중 · "+(p+1)+" / "+pages()+"페이지");
        const png=await drawPage(p);
        files.push({name:filename(state.title)+"_"+formatNumber(p+1)+".png",bytes:new Uint8Array(await png.arrayBuffer())});
        await sleepFrame();
      }
      const zipped=zipFiles(files);
      download(zipped,filename(state.title)+"_ATLAS.zip");
      notify("총 "+files.length+"페이지를 ZIP으로 저장했습니다.");
    });
  }

  async function exportProject(){
    await withBusy(async()=>{
      const entries=[];
      if(state.base)entries.push({...state.base,role:"base",label:""});
      state.items.forEach(x=>entries.push({...x,role:"expression"}));
      const manifest={
        version:1,meta:serialMeta(),
        files:entries.map(x=>({
          id:x.id,role:x.role,name:x.name,type:x.type,size:x.file.size,
          width:x.width||null,height:x.height||null,label:x.label||""
        }))
      };
      const metaBytes=encoder.encode(JSON.stringify(manifest));
      const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,metaBytes.length,true);
      const data=new Blob([encoder.encode(MAGIC),length,metaBytes,...entries.map(x=>x.file)],{type:"application/octet-stream"});
      download(data,filename(state.title)+".patlas");
      notify("이미지까지 포함된 프로젝트 파일을 저장했습니다.");
    });
  }
  async function importProject(file){
    await withBusy(async()=>{
      const head=await file.slice(0,12).arrayBuffer();
      if(head.byteLength!==12||decoder.decode(new Uint8Array(head,0,8))!==MAGIC)
        throw new Error("PORTRAIT ATLAS 프로젝트 파일이 아닙니다.");
      const len=new DataView(head).getUint32(8,true);
      if(len>2000000||len===0)throw new Error("프로젝트 정보가 올바르지 않습니다.");
      const manifest=JSON.parse(await file.slice(12,12+len).text());
      if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error("지원하지 않는 프로젝트 버전입니다.");
      let offset=12+len;
      const entries=[];
      for(const entry of manifest.files){
        if(!Number.isSafeInteger(entry.size)||entry.size<0||offset+entry.size>file.size)throw new Error("이미지 데이터가 손상되었습니다.");
        const blob=file.slice(offset,offset+entry.size,entry.type||"application/octet-stream");
        entries.push({id:entry.id||id(),name:entry.name||"image.png",type:entry.type||"image/png",
          file:blob,width:entry.width,height:entry.height,label:entry.label||"",role:entry.role});
        offset+=entry.size;
      }
      if(state.base?.url)URL.revokeObjectURL(state.base.url);
      state.base=null;state.items=[];
      const meta=manifest.meta||{};
      Object.assign(state,{
        title:String(meta.title||"새 캐릭터"),
        crop:meta.crop||{...DEFAULT_CROP},
        pageSize:[12,20,30,40,48].includes(meta.pageSize)?meta.pageSize:40,
        columns:[4,5,6,8].includes(meta.columns)?meta.columns:6,
        format:meta.format==="a4"?"a4":"wide",theme:meta.theme==="dark"?"dark":"light",
        repeatStanding:meta.repeatStanding!==false,
        page:Math.max(0,Number(meta.page)||0),sourceSize:meta.sourceSize||null
      });
      for(const entry of entries) {
        if(entry.role==="base"&&!state.base){
          entry.url=URL.createObjectURL(entry.file);state.base=entry;
        }else if(entry.role==="expression")state.items.push(entry);
      }
      if(state.base&&!state.sourceSize)state.sourceSize={width:state.base.width,height:state.base.height};
      await loadBaseImage();render();queueThumbnails();
      try{await clearDb();await putFiles(entries);await saveMeta();}
      catch(e){notify("파일은 열렸지만 브라우저 자동저장에 실패했습니다.",true);return;}
      notify("프로젝트 "+state.items.length+"개 표정을 복원했습니다.");
    });
  }
  async function loadSaved(){
    try{
      const data=await db();
      const tx=data.transaction(["meta","files"],"readonly");
      const metaPromise=requestResult(tx.objectStore("meta").get("active"));
      const filesPromise=requestResult(tx.objectStore("files").getAll());
      const [stored,entries]=await Promise.all([metaPromise,filesPromise]);
      if(!stored||!stored.value)return;
      const s=stored.value,map=new Map(entries.map(x=>[x.id,x]));
      Object.assign(state,{
        title:s.title||"새 캐릭터",
        crop:s.crop||{...DEFAULT_CROP},
        pageSize:[12,20,30,40,48].includes(s.pageSize)?s.pageSize:40,
        columns:[4,5,6,8].includes(s.columns)?s.columns:6,
        format:s.format==="a4"?"a4":"wide",
        theme:s.theme==="dark"?"dark":"light",
        repeatStanding:s.repeatStanding!==false,
        page:s.page||0,sourceSize:s.sourceSize||null
      });
      const base=s.baseId?map.get(s.baseId):null;
      if(base){state.base={...base,file:base.blob,url:URL.createObjectURL(base.blob)};delete state.base.blob;}
      state.items=(s.items||[]).map(x=>{
        const f=map.get(x.id);
        return f?{...f,file:f.blob,label:x.label||"",thumb:null}:null;
      }).filter(Boolean);
      if(state.base||state.items.length){
        await loadBaseImage();render();queueThumbnails();
        notify("이전 작업을 복원했습니다.");
      }
    }catch(e){console.warn("Could not restore browser workspace",e);}
  }
  async function resetProject(){
    if((state.base||state.items.length)&&!confirm("현재 작업을 초기화할까요? 먼저 .patlas 프로젝트로 저장해 두는 것을 권장합니다."))return;
    ++thumbnailVersion;clearTimeout(thumbnailTimer);clearTimeout(saveTimer);
    if(state.base?.url)URL.revokeObjectURL(state.base.url);
    state.base=null;state.items=[];state.title="새 캐릭터";state.crop={...DEFAULT_CROP};
    state.sourceSize=null;state.page=0;state.pageSize=40;state.columns=6;
    state.format="wide";state.theme="light";state.repeatStanding=true;
    baseImage=null;$("cropStatus").textContent="";
    try{await clearDb();}catch(e){console.warn(e);}
    render();notify("새 프로젝트를 시작했습니다.");
  }
  function attachDrop(labelId,inputId,handler){
    const target=$(labelId),input=$(inputId);
    input.addEventListener("change",async()=>{
      if(input.files?.length)await handler([...input.files]);
      input.value="";
    });
    target.addEventListener("dragover",e=>{e.preventDefault();target.classList.add("dragover");});
    target.addEventListener("dragleave",()=>target.classList.remove("dragover"));
    target.addEventListener("drop",async e=>{
      e.preventDefault();target.classList.remove("dragover");
      if(e.dataTransfer.files?.length)await handler([...e.dataTransfer.files]);
    });
  }
  function init(){
    bindCrop();
    attachDrop("baseDrop","baseInput",async files=>setBase(files[0]));
    attachDrop("facesDrop","facesInput",addFaces);
    $("projectTitle").addEventListener("input",e=>{
      state.title=e.target.value;renderPreview();scheduleSave();
    });
    ["pageSize","columns","format","theme","repeatStanding"].forEach(key=>$(key).addEventListener("change",updateOptions));
    $("prevPage").addEventListener("click",()=>{state.page=Math.max(0,state.page-1);renderCounts();renderPreview();scheduleSave();});
    $("nextPage").addEventListener("click",()=>{state.page=Math.min(pages()-1,state.page+1);renderCounts();renderPreview();scheduleSave();});
    $("downloadPage").addEventListener("click",downloadCurrent);
    $("downloadAll").addEventListener("click",downloadAll);
    $("saveProject").addEventListener("click",exportProject);
    $("importProject").addEventListener("click",()=>$("projectInput").click());
    $("projectInput").addEventListener("change",async e=>{
      if(e.target.files?.[0])await importProject(e.target.files[0]);
      e.target.value="";
    });
    $("newProject").addEventListener("click",resetProject);
    $("sortByName").addEventListener("click",()=>{
      state.items.sort(naturalSort);renderCards();renderPreview();scheduleSave();notify("파일명순으로 정렬했습니다.");
    });
    $("removeAllFaces").addEventListener("click",async()=>{
      if(!state.items.length)return;
      if(!confirm("등록된 표정 "+state.items.length+"개를 모두 삭제할까요?"))return;
      ++thumbnailVersion;clearTimeout(thumbnailTimer);
      const ids=state.items.map(x=>x.id);state.items=[];state.page=0;
      try{await deleteFiles(ids);}catch(e){console.warn(e);}
      render();scheduleSave();notify("표정 목록을 비웠습니다.");
    });
    render();loadSaved();
  }
  init();
})();