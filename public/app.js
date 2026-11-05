'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const workspace=$('#workspace'),sidebar=$('.sidebar'),handle=$('#sidebar-handle'),promptInput=$('#prompt'),form=$('#composer'),dock=$('#composer-dock'),generate=$('#generate-button');
let attachments=[],running=false,planning=false,timer=null,selectedTemplate=null,toastTimer;
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;

function setTheme(theme){document.documentElement.dataset.theme=theme;const dark=theme==='dark';$('#theme-toggle').setAttribute('aria-pressed',String(dark));$('#theme-toggle').setAttribute('aria-label',`Switch to ${dark?'light':'dark'} theme`);$('#theme-label').textContent=dark?'Dark appearance':'Light appearance';$('meta[name="theme-color"]').content=dark?'#09090b':'#e4e4e7';try{localStorage.setItem('create-theme',theme)}catch{}}
setTheme(document.documentElement.dataset.theme||'light');
$('#theme-toggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
const mobileLayout=matchMedia('(max-width:760px)');
let menuScrollY=null;
function syncMobileMenu(open){
  const mobile=mobileLayout.matches;
  if(mobile&&open&&menuScrollY===null){menuScrollY=window.scrollY;document.body.style.top=-menuScrollY+'px'}
  document.body.classList.toggle('mobile-menu-open',mobile&&open);
  if((!mobile||!open)&&menuScrollY!==null){const y=menuScrollY;menuScrollY=null;document.body.style.removeProperty('top');window.scrollTo({top:y,behavior:'instant'})}
  sidebar.inert=document.body.classList.contains('pricing-open')||(mobile&&!open);workspace.inert=mobile&&open;
  $('#mobile-menu-button').setAttribute('aria-expanded',String(mobile&&open));
}
function setSidebar(open,{focus=true}={}){
  sidebar.classList.toggle('expanded',open);sidebar.style.removeProperty('--sidebar');
  handle.setAttribute('aria-expanded',String(open));handle.setAttribute('aria-label',open?'Collapse sidebar':'Expand sidebar');
  syncMobileMenu(open);
  if(focus&&mobileLayout.matches)requestAnimationFrame(()=>{if(mobileLayout.matches&&sidebar.classList.contains('expanded')===open)(open?$('#sidebar-close'):$('#mobile-menu-button')).focus({preventScroll:true})});
}
$('#mobile-menu-button').addEventListener('click',()=>setSidebar(true));
$('#sidebar-close').addEventListener('click',()=>setSidebar(false));
$('#sidebar-scrim').addEventListener('click',()=>setSidebar(false));
sidebar.addEventListener('transitionend',e=>{if(e.target===sidebar&&e.propertyName==='transform'&&mobileLayout.matches&&sidebar.classList.contains('expanded')&&!sidebar.contains(document.activeElement))$('#sidebar-close').focus({preventScroll:true})});
mobileLayout.addEventListener('change',()=>{setSidebar(false,{focus:false});resetCardMotion();requestAnimationFrame(updatePrompt)});
syncMobileMenu(sidebar.classList.contains('expanded'));
// ResizeObserver also follows the animated width, keeping labels in sync with the panel.
new ResizeObserver(([entry])=>{const width=entry.borderBoxSize?.[0]?.inlineSize??sidebar.getBoundingClientRect().width;const mobile=matchMedia('(max-width:760px)').matches;const collapsed=mobile?56:68,expanded=mobile?224:248;const t=Math.max(0,Math.min(1,(width-collapsed-12)/(expanded-collapsed-36)));sidebar.style.setProperty('--label-opacity',(t*t*(3-2*t)).toFixed(4));$('.sidebar-footer').inert=t<.8;$('.session-section-heading').setAttribute('aria-hidden',String(t<.5));}).observe(sidebar);
let drag=null,suppressClick=false;
handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,width:sidebar.getBoundingClientRect().width,moved:false,open:sidebar.classList.contains('expanded')};handle.setPointerCapture(e.pointerId)});
handle.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x;if(Math.abs(dx)>4)drag.moved=true;if(drag.moved){sidebar.classList.add('dragging');sidebar.style.setProperty('--sidebar',Math.min(280,Math.max(matchMedia('(max-width:760px)').matches?56:68,drag.width+dx))+'px')}});
function endDrag(){if(!drag)return;if(drag.moved){const open=sidebar.getBoundingClientRect().width>145;sidebar.classList.remove('dragging');setSidebar(open);suppressClick=true;setTimeout(()=>suppressClick=false,100)}drag=null}
handle.addEventListener('pointerup',endDrag);handle.addEventListener('pointercancel',endDrag);handle.addEventListener('click',()=>{if(!suppressClick)setSidebar(!sidebar.classList.contains('expanded'))});

// A fixed design-space preserves the Figma card composition; the canvas scales as a whole.
new ResizeObserver(([entry])=>{const {width,height}=entry.contentRect;const scale=Math.min(1,(width-40)/1176,(height-40)/798);workspace.style.setProperty('--stage-scale',Math.max(.23,scale));}).observe(workspace);
const cards=$$('.float-card'),greeting=$('.greeting');
// Animate a separate transform layer so pointer parallax remains independent.
if(!reduceMotion){cards.forEach((card,i)=>{const x=parseFloat(card.style.getPropertyValue('--x')),y=parseFloat(card.style.getPropertyValue('--y')),w=parseFloat(card.style.getPropertyValue('--w')),h=parseFloat(card.style.getPropertyValue('--h'));const dx=mobileLayout.matches?0:588-x-w/2,dy=mobileLayout.matches?16:399-y-h/2;const keyframes=Array.from({length:61},(_,j)=>{const t=j/60;const remaining=j===60?0:Math.exp(-9.6*t)*(Math.cos(7.2*t)+(4/3)*Math.sin(7.2*t));const fade=Math.max(0,Math.min(1,(t-.06)/.94));return {offset:t,translate:`${dx*remaining}px ${dy*remaining}px`,scale:String(1-.12*remaining),opacity:fade*fade*(3-2*fade)};});card.animate(keyframes,{duration:760,delay:i*12,easing:'linear',fill:'backwards'});});}
// Global parallax and local attraction use independent, frame-rate-aware smoothing.
let targetX=0,targetY=0,currentX=0,currentY=0,frame=0,lastFrameTime=null;
const attraction=cards.map(card=>({card,x:0,y:0,targetX:0,targetY:0}));
function requestCardFrame(){if(!frame&&!reduceMotion)frame=requestAnimationFrame(animateCards)}
function animateCards(now){const dt=lastFrameTime===null?1:Math.min(3,(now-lastFrameTime)/(1000/60));lastFrameTime=now;const globalEase=1-Math.pow(1-.065,dt),localEase=1-Math.pow(1-.11,dt);currentX+=(targetX-currentX)*globalEase;currentY+=(targetY-currentY)*globalEase;greeting.style.setProperty('--greeting-x',(currentX*.22).toFixed(3)+'px');greeting.style.setProperty('--greeting-y',(currentY*.22).toFixed(3)+'px');let unsettled=Math.abs(targetX-currentX)+Math.abs(targetY-currentY)>.015;attraction.forEach(state=>{state.x+=(state.targetX-state.x)*localEase;state.y+=(state.targetY-state.y)*localEase;const depth=Number(state.card.dataset.depth);state.card.style.setProperty('--float-x',(currentX*depth).toFixed(3)+'px');state.card.style.setProperty('--float-y',(currentY*depth).toFixed(3)+'px');state.card.style.setProperty('--magnet-x',state.x.toFixed(3)+'px');state.card.style.setProperty('--magnet-y',state.y.toFixed(3)+'px');unsettled ||= Math.abs(state.targetX-state.x)+Math.abs(state.targetY-state.y)>.015;});if(unsettled)frame=requestAnimationFrame(animateCards);else{frame=0;lastFrameTime=null}}
function moveCards(x,y){if(reduceMotion)return;targetX=x;targetY=y;requestCardFrame()}
function resetCardMotion(){attraction.forEach(s=>{s.targetX=0;s.targetY=0});moveCards(0,0)}
workspace.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||running||reduceMotion||mobileLayout.matches||document.body.classList.contains('templates-open'))return;const r=workspace.getBoundingClientRect();moveCards(((e.clientX-r.left)/r.width-.5)*40,((e.clientY-r.top)/r.height-.5)*34)});
workspace.addEventListener('pointerleave',resetCardMotion);
attraction.forEach(state=>{state.card.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||running||reduceMotion||mobileLayout.matches)return;const r=state.card.getBoundingClientRect();state.targetX=Math.max(-1,Math.min(1,(e.clientX-r.left-r.width/2)/(r.width/2)))*15;state.targetY=Math.max(-1,Math.min(1,(e.clientY-r.top-r.height/2)/(r.height/2)))*12;requestCardFrame()});state.card.addEventListener('pointerleave',()=>{state.targetX=0;state.targetY=0;requestCardFrame()})});
const recordText='CREATE • PLAY • REPEAT •';[...recordText].forEach((letter,i)=>{const s=document.createElement('span');s.textContent=letter;s.style.setProperty('--a',`${i*360/recordText.length-45}deg`);$('.record-type').append(s)});

const presets={'Song':'Create an uplifting, warm indie instrumental with a catchy melody and a relaxed summer feel.','Create video':'Create a cinematic video of a French bulldog in a red jacket walking beside a vivid blue building. Use a low camera angle, natural movement and soft daylight.','Photo edit':'Edit my photo with soft studio lighting and a warm neutral background. Keep the person recognisable and preserve natural skin texture.','Product photo':'Create a polished product photo of my AQUA coffee packaging on a soft pink backdrop, with gentle studio lighting and natural shadows. Preserve the original label and rich pink colours.','Voiceover':'Write a warm, natural voiceover script: Every great idea begins with a little spark. What will you make today?','Animate image':'Animate this image with subtle, natural motion and a gentle camera push-in. Preserve its original style and composition.'};
const templateImages={'Create video':'assets/home-create-video.png','Photo edit':'assets/home-edit-photo.png','Product photo':'assets/home-packaging.png','Animate image':'assets/home-animate-image.png'};
const templateImageCache=new Map();
let templateSelectionRevision=0,templateAttachmentLoading=false;
function loadTemplateImage(src){
  if(!templateImageCache.has(src))templateImageCache.set(src,fetch(src).then(response=>{if(!response.ok)throw Error('Template image unavailable');return response.blob()}).catch(error=>{templateImageCache.delete(src);throw error}));
  return templateImageCache.get(src);
}
let promptResizeAnimation,promptRevealAnimation;
async function applyTemplate(name,copy=presets[name],preview=templateImages[name]){
  if(running)return;
  if(name==='Song'||name==='Voiceover')preview=null;
  const revision=++templateSelectionRevision;
  selectedTemplate=name;templateAttachmentLoading=!!preview;
  promptRevealAnimation?.cancel();
  promptInput.value=copy;
  updatePrompt();
  if(!mobileLayout.matches&&!matchMedia('(pointer:coarse)').matches)promptInput.focus({preventScroll:true});
  promptInput.scrollTop=0;
  if(!reduceMotion)promptRevealAnimation=promptInput.animate([{opacity:0},{opacity:1}],{duration:280,easing:'cubic-bezier(.22,1,.36,1)'});
  try{
    const blob=preview?await loadTemplateImage(preview):null;
    if(revision!==templateSelectionRevision)return;
    const retained=attachments.filter(item=>!item.templatePreview);
    attachments.filter(item=>item.templatePreview).forEach(item=>{if(item.url)URL.revokeObjectURL(item.url)});
    attachments=retained;
    if(blob){
      if(attachments.length>=4)toast('Remove an attachment to add the template image.');
      else{const extension=preview.split('.').pop(),file=new File([blob],`${name.toLowerCase().replaceAll(' ','-')}.${extension}`,{type:blob.type||'image/png'});attachments.push({id:crypto.randomUUID(),file,url:URL.createObjectURL(file),templatePreview:true})}
    }
  }catch{if(revision===templateSelectionRevision)toast('The template image could not load. Please try again.')}finally{
    if(revision===templateSelectionRevision){templateAttachmentLoading=false;renderFiles()}
  }
}
cards.forEach(card=>card.addEventListener('click',()=>applyTemplate(card.dataset.template)));
function updatePrompt(){
  const previousHeight=promptInput.getBoundingClientRect().height;
  promptResizeAnimation?.cancel();
  promptInput.style.height='34px';
  const targetHeight=Math.min(140,Math.max(34,promptInput.scrollHeight));
  promptInput.style.height=targetHeight+'px';
  generate.disabled=running||planning||templateAttachmentLoading||(!promptInput.value.trim()&&!attachments.length);
  form.classList.toggle('long-prompt',targetHeight>74);
  if(!reduceMotion&&Math.abs(targetHeight-previousHeight)>.5){
    promptResizeAnimation=promptInput.animate([{height:previousHeight+'px'},{height:targetHeight+'px'}],{duration:320,easing:'cubic-bezier(.22,1,.36,1)'});
    promptResizeAnimation.onfinish=updatePromptFade;
  }
  updatePromptFade();
  requestAnimationFrame(updatePromptFade);
}
function updatePromptFade(){const overflow=promptInput.scrollHeight-promptInput.clientHeight;promptInput.style.setProperty('--prompt-fade-top',overflow>1&&promptInput.scrollTop>1?'10px':'0px');promptInput.style.setProperty('--prompt-fade-bottom',overflow>1&&overflow-promptInput.scrollTop>1?'10px':'0px');}
promptInput.addEventListener('scroll',updatePromptFade,{passive:true});new ResizeObserver(updatePromptFade).observe(promptInput);
promptInput.addEventListener('input',updatePrompt);promptInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit()}if(e.key==='Escape')promptInput.blur()});
function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3000)}

$('#attach-button').addEventListener('click',()=>$('#file-input').click());$('#file-input').addEventListener('change',e=>{addFiles(e.target.files);e.target.value=''});
function addFiles(files){if(running||planning){toast('Wait for your current request to finish.');return;}for(const file of files){if(attachments.length>=4){toast('You can attach up to 4 files.');break}if(file.size>20*1024*1024){toast('Each file must be under 20 MB.');continue;}attachments.push({id:crypto.randomUUID(),file,url:file.type.startsWith('image/')?URL.createObjectURL(file):null})}renderFiles();}
let attachmentRowAnimation;
function revealAttachment(wrap,index){
  if(!wrap.isConnected)return;
  wrap.style.opacity='1';
  if(!reduceMotion)wrap.animate([{opacity:0,transform:'translateY(6px) scale(.95)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:300,delay:Math.min(index*30,120),easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'});
}
function renderFiles(){
  const list=$('#attachments'),previousHeight=list.hidden?0:list.getBoundingClientRect().height;
  attachmentRowAnimation?.cancel();
  const retained=new Map([...list.children].map(node=>[node.dataset.attachmentId,node]));
  const ids=new Set(attachments.map(item=>item.id));
  retained.forEach((node,id)=>{if(!ids.has(id))node.remove()});
  list.hidden=!attachments.length;
  let addedIndex=0;
  for(const item of attachments){
    if(retained.has(item.id))continue;
    const index=addedIndex++,wrap=document.createElement('div');
    wrap.className='attachment';wrap.dataset.attachmentId=item.id;wrap.title=item.file.name;
    if(!reduceMotion)wrap.style.opacity='0';
    if(item.url){
      const img=document.createElement('img');img.alt=item.file.name;
      img.addEventListener('load',()=>revealAttachment(wrap,index),{once:true});
      img.addEventListener('error',()=>revealAttachment(wrap,index),{once:true});
      wrap.append(img);img.src=item.url;
    }else{const name=document.createElement('span');name.textContent=item.file.name;wrap.append(name)}
    const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.textContent='×';remove.setAttribute('aria-label','Remove '+item.file.name);
    remove.addEventListener('click',()=>{if(item.url)URL.revokeObjectURL(item.url);attachments=attachments.filter(a=>a.id!==item.id);renderFiles()});
    wrap.append(remove);list.append(wrap);
    if(!item.url)revealAttachment(wrap,index);
  }
  const targetHeight=list.hidden?0:list.getBoundingClientRect().height;
  if(!reduceMotion&&targetHeight>previousHeight+.5)attachmentRowAnimation=list.animate([{height:previousHeight+'px',opacity:previousHeight?1:0},{height:targetHeight+'px',opacity:1}],{duration:320,easing:'cubic-bezier(.22,1,.36,1)'});
  updatePrompt();
}
const dropOverlay=$('#drop-overlay');let dropHideTimer,dropActive=false;
function setDropVisible(visible){
  clearTimeout(dropHideTimer);dropActive=visible;
  if(visible){dropOverlay.hidden=false;requestAnimationFrame(()=>{if(dropActive)dropOverlay.classList.add('visible')})}
  else{dropOverlay.classList.remove('visible');if(reduceMotion)dropOverlay.hidden=true;else dropHideTimer=setTimeout(()=>{if(!dropActive)dropOverlay.hidden=true},200)}
}
let dragDepth=0;window.addEventListener('dragenter',e=>{if(![...e.dataTransfer.types].includes('Files'))return;e.preventDefault();dragDepth++;setDropVisible(true)});window.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy'}});window.addEventListener('dragleave',e=>{e.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)setDropVisible(false)});window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;setDropVisible(false);if(e.dataTransfer.files.length)addFiles(e.dataTransfer.files)});window.addEventListener('blur',()=>{dragDepth=0;setDropVisible(false);resetCardMotion()});

// Canvas navigation lives on a separate layer from the card's playful tilt.
const canvasViewport=$('#canvas-viewport'),canvasScene=$('#canvas-scene');
const generationItems=[],generationNodes=new WeakMap();
let showingHome=true;
let currentGeneration=null,generationNumber=0,generationRequest=0;
const canvasView={x:0,y:0,z:1,tx:0,ty:0,tz:1,frame:0,time:null};
let canvasDrag=null,canvasPinch=null,canvasSpace=false,canvasMoved=false;
const canvasPointers=new Map(),MIN_ZOOM=.01,MAX_ZOOM=2.5;
let cardStack=1;
const selectedGenerations=new Set();
const actionsMenu=$('#generation-actions');
let actionsLayout='none',actionsAnimation=null,stackRevealAnimation=null,stackNumber=0,shareItems=[],lastDeleted=[],expandedStack=null;
const selectionBox=document.createElement('div');selectionBox.className='canvas-selection-box';selectionBox.setAttribute('aria-hidden','true');canvasViewport.append(selectionBox);
function paintSelection(){
  generationItems.forEach(item=>{const selected=selectedGenerations.has(item);item.element.classList.toggle('is-selected',selected);item.card.setAttribute('aria-pressed',String(selected))});
  syncActionsMenu();
}
function expandStacks(items){const ids=new Set(items.map(item=>item.stackId).filter(id=>id&&id!==expandedStack?.id));return generationItems.filter(item=>items.includes(item)||(item.stackId&&ids.has(item.stackId)))}
function selectGenerations(items){selectedGenerations.clear();expandStacks(items).forEach(item=>selectedGenerations.add(item));paintSelection()}
function syncActionsMenu(){
  const selected=[...selectedGenerations],active=selected.length>0&&!mobileLayout.matches&&!$('#generation').hidden,multi=selected.length>1;
  const stacked=multi&&selected[0].stackId&&selected.every(item=>item.stackId===selected[0].stackId);
  const ready=selected.length>0&&selected.every(item=>item.status==='complete');
  const editable=selected.every(item=>['image','text'].includes(item.kind));
  ['enhance','share','download'].forEach(action=>$('#action-'+action).disabled=!ready);
  $('#action-enhance').disabled=!ready||running;
  $('#action-enhance').hidden=!editable;
  $('#action-stack').disabled=!ready;$('#action-stack').tabIndex=multi?0:-1;$('#action-stack').setAttribute('aria-hidden',String(!multi));
  $('#stack-action-label').textContent=stacked?'Unstack':'Stack';
  dock.style.setProperty('--stack-button-width',(stacked?98:82)+'px');
  actionsMenu.setAttribute('aria-label',selected.length>1?`Bulk actions for ${selected.length} generations`:'Actions for selected generation');
  actionsMenu.inert=!active;actionsMenu.setAttribute('aria-hidden',String(!active));form.inert=active;
  const nextLayout=active?(multi?(stacked?'stacked':'bulk'):'single')+(editable?'':'-readonly'):'none';
  if(nextLayout===actionsLayout)return;
  const revealStack=active&&multi&&!dock.classList.contains('has-multiple'),duration=active&&actionsLayout!=='none'?560:480;
  const before=dock.getBoundingClientRect();actionsAnimation?.cancel();
  stackRevealAnimation?.cancel();
  if(active&&actionsLayout==='none')dock.style.setProperty('--resting-composer-width',before.width+'px');
  dock.style.setProperty('--actions-width',((multi?(stacked?508:492):398)-(editable?0:113))+'px');dock.classList.toggle('has-multiple',multi);dock.classList.toggle('actions-open',active);
  if(active){if(document.activeElement===promptInput)promptInput.blur()}
  else if(actionsMenu.contains(document.activeElement))canvasViewport.focus({preventScroll:true});
  actionsLayout=nextLayout;
  const after=dock.getBoundingClientRect();
  if(!reduceMotion){
    actionsAnimation=dock.animate([{width:before.width+'px',height:before.height+'px'},{width:after.width+'px',height:after.height+'px'}],{duration,easing:'cubic-bezier(.22,1,.36,1)'});
    if(revealStack)stackRevealAnimation=$('#action-stack').animate([
      {opacity:0,transform:'translate(-8px,5px) scale(.94)',easing:'cubic-bezier(.2,.7,.2,1)'},
      {opacity:.9,transform:'translate(1.5px,-1px) scale(1.015)',offset:.65,easing:'ease-in-out'},
      {opacity:1,transform:'translate(0,0) scale(1)'}
    ],{duration:620,delay:50});
  }
}
const CARD_GAP=40,SNAP_DISTANCE=36;
function generationHeight(item){return item.kind==='image'?item.element.scrollHeight:item.height}
function snapCardPosition(item,x,y,zoom,disabled=false,excluded=new Set()){
  const result={x,y};if(disabled)return result;
  // Keep the layout gap in canvas units; only the pointer's capture radius uses screen pixels.
  const threshold=SNAP_DISTANCE/zoom,spacing=CARD_GAP,nearby=80/zoom,w=item.width,h=generationHeight(item),footer=h-item.height,cy=y+footer/2;
  let bestX=threshold,bestY=threshold;
  for(const other of generationItems){
    if(other===item||excluded.has(other)||(expandedStack&&other.stackId!==expandedStack.id))continue;
    const ow=other.width,oh=generationHeight(other),oy=other.ty+(oh-other.height)/2;
    const gapX=Math.max(0,Math.abs(x-other.tx)-(w+ow)/2),gapY=Math.max(0,Math.abs(cy-oy)-(h+oh)/2);
    if(gapY<=nearby){
      const separated=Math.abs(x-other.tx)>=(w+ow)/2;
      const anchors=separated?[other.tx+Math.sign(x-other.tx)*((w+ow)/2+spacing)]:[other.tx,other.tx+(w-ow)/2,other.tx+(ow-w)/2];
      for(const anchor of anchors){
        const delta=anchor-x,distance=Math.abs(delta);
        if(distance<bestX){bestX=distance;result.x=x+delta;}
      }
    }
    if(gapX<=nearby){
      const separated=Math.abs(cy-oy)>=(h+oh)/2;
      const anchors=separated?[oy+Math.sign(cy-oy)*((h+oh)/2+spacing)]:[oy,oy+(h-oh)/2,oy+(oh-h)/2];
      for(const anchor of anchors){
        const delta=anchor-footer/2-y,distance=Math.abs(delta);
        if(distance<bestY){bestY=distance;result.y=y+delta;}
      }
    }
  }
  return result;
}
function magneticNeighbours(members){
  const neighbours=new Set(),group=new Set(members);
  for(const item of members)for(const other of generationItems){
    if(group.has(other)||(expandedStack&&other.stackId!==expandedStack.id))continue;
    const h=generationHeight(item),oh=generationHeight(other);
    const dx=Math.abs(item.tx-other.tx),dy=Math.abs(item.ty+(h-item.height)/2-other.ty-(oh-other.height)/2),halfW=(item.width+other.width)/2,halfH=(h+oh)/2;
    if((Math.abs(dx-halfW-CARD_GAP)<1&&dy<halfH)||(Math.abs(dy-halfH-CARD_GAP)<1&&dx<halfW))neighbours.add(other);
  }
  return neighbours;
}
const STACK_HOLD_DELAY=600;
function clearStackDrop(drag=canvasDrag){
  if(!drag)return;
  clearTimeout(drag.stackTimer);drag.stackTimer=null;drag.stackTarget=null;drag.stackArmed=false;
  generationItems.forEach(item=>item.element.classList.remove('stack-drop-hover','stack-drop-ready'));
}
function stackDropTarget(drag,x,y){
  if(expandedStack||drag.members.some(({item})=>item.status!=='complete'))return null;
  const moving=new Set(drag.members.map(({item})=>item));
  return generationItems.filter(item=>{
    if(moving.has(item)||item.status!=='complete'||(item.stackId&&!item.element.classList.contains('stack-front')))return false;
    if(item.stackId&&generationItems.some(other=>other.stackId===item.stackId&&other.status!=='complete'))return false;
    const r=item.element.getBoundingClientRect(),inset=Math.min(18,r.width*.08,r.height*.08);
    return x>r.left+inset&&x<r.right-inset&&y>r.top+inset&&y<r.bottom-inset;
  }).sort((a,b)=>Number(b.element.style.zIndex)-Number(a.element.style.zIndex))[0]||null;
}
function updateStackDrop(drag,x,y,disabled=false){
  const target=disabled?null:stackDropTarget(drag,x,y);
  if(target===drag.stackTarget)return;
  clearStackDrop(drag);if(!target)return;
  drag.stackTarget=target;target.element.classList.add('stack-drop-hover');
  drag.stackTimer=setTimeout(()=>{
    if(canvasDrag!==drag||drag.stackTarget!==target)return;
    drag.stackArmed=true;target.element.classList.add('stack-drop-ready');
  },STACK_HOLD_DELAY);
}
function finishStackDrop(drag,e){
  const target=drag.stackTarget;
  if(e.type==='pointercancel'||e.altKey||!drag.stackArmed||!target||stackDropTarget(drag,e.clientX,e.clientY)!==target)return false;
  const members=[...new Set([...expandStacks([target]),...drag.members.map(({item})=>item)])].sort((a,b)=>a.id-b.id);
  const anchor=generationItems.find(item=>target.stackId&&item.stackId===target.stackId)||target;
  arrangeStack(members,anchor.tx,anchor.ty,target.stackId||++stackNumber);
  clearStackDrop(drag);selectGenerations([]);refreshStacks();requestCanvasFrame();return true;
}
function arrangeStack(members,x,y,id=++stackNumber){
  members.forEach((item,index)=>{item.stackId=id;item.tx=x+index*12;item.ty=y+index*12;item.element.style.zIndex=String(++cardStack)});
}
const STACK_EXTRACT_DELAY=1200,STACK_EXTRACT_DISTANCE=24;
function beginStackLift(drag){
  const item=drag.item,ghost=document.createElement('div');
  ghost.className='stack-slot-ghost';ghost.setAttribute('aria-hidden','true');
  Object.assign(ghost.style,{width:item.width+'px',height:item.height+'px',transform:`translate(-50%,-50%) translate3d(${item.tx}px,${item.ty}px,0)`});
  ghost.style.setProperty('--extract-duration',STACK_EXTRACT_DELAY+'ms');
  canvasScene.prepend(ghost);
  drag.stackLift={id:item.stackId,x:item.tx,y:item.ty,ghost,timer:null,outside:false,detached:false};
}
function updateStackLift(drag){
  const lift=drag.stackLift;if(!lift||lift.detached)return;
  const outside=Math.hypot(drag.rawX-lift.x,drag.rawY-lift.y)*canvasView.z>=STACK_EXTRACT_DISTANCE;
  if(outside===lift.outside)return;
  lift.outside=outside;clearTimeout(lift.timer);lift.timer=null;
  lift.ghost.classList.toggle('is-draining',outside);
  if(!outside)return;
  lift.timer=setTimeout(()=>{
    if(canvasDrag!==drag||!lift.outside||lift.detached)return;
    lift.detached=true;drag.item.stackId=null;
    expandedStack?.extracted.add(drag.item);
    selectedGenerations.delete(drag.item);
    lift.ghost.remove();refreshStacks();paintSelection();requestCanvasFrame();
  },STACK_EXTRACT_DELAY);
}
function finishStackLift(drag){
  const lift=drag?.stackLift;if(!lift)return;
  clearTimeout(lift.timer);lift.ghost.classList.remove('is-draining');lift.ghost.style.opacity='0';setTimeout(()=>lift.ghost.remove(),200);
  if(!lift.detached){drag.item.tx=lift.x;drag.item.ty=lift.y}
  drag.stackLift=null;requestCanvasFrame();
}
function moveDraggedCards(final=false,alt=false){
  const drag=canvasDrag,item=drag.item,dx=drag.rawX-drag.originX,dy=drag.rawY-drag.originY;
  if(drag.stackLift){
    if(!drag.stackLift.detached){
      item.tx=drag.rawX;item.ty=drag.rawY;if(!final)updateStackLift(drag);
    }else{item.tx=drag.rawX;item.ty=drag.rawY}
    return;
  }
  let targetX=drag.rawX,targetY=drag.rawY;
  if(drag.bonded.size&&!drag.detached&&!alt&&!reduceMotion){
    if(Math.hypot(dx,dy)*canvasView.z<24){
      targetX=drag.originX+(final?0:dx*.18);targetY=drag.originY+(final?0:dy*.18);
      drag.members.forEach(member=>member.item.element.classList.toggle('magnet-resisting',!final));
      if(final){drag.rawX=targetX;drag.rawY=targetY}
    }else{drag.detached=true;drag.members.forEach(member=>member.item.element.classList.remove('magnet-resisting'))}
  }else if(alt){drag.detached=true;drag.members.forEach(member=>member.item.element.classList.remove('magnet-resisting'))}
  if(!drag.bonded.size||drag.detached||reduceMotion){
    const excluded=new Set(drag.members.map(member=>member.item));
    if(drag.detached)drag.bonded.forEach(other=>excluded.add(other));
    const snapped=snapCardPosition(item,targetX,targetY,final?canvasView.tz:canvasView.z,alt,excluded);targetX=snapped.x;targetY=snapped.y;
  }
  drag.members.forEach(member=>{member.item.tx=member.x+targetX-drag.originX;member.item.ty=member.y+targetY-drag.originY});
}
function canvasActive(){return !mobileLayout.matches&&!$('#generation').hidden&&!workspace.classList.contains('viewer-open')}
function paintCanvas(){
  canvasScene.style.setProperty('--canvas-x',canvasView.x.toFixed(3)+'px');
  canvasScene.style.setProperty('--canvas-y',canvasView.y.toFixed(3)+'px');
  canvasScene.style.setProperty('--canvas-zoom',canvasView.z.toFixed(5));
  canvasScene.style.setProperty('--selection-stroke',2/canvasView.z+'px');
  generationItems.forEach(item=>{item.element.style.setProperty('--item-x',item.x.toFixed(3)+'px');item.element.style.setProperty('--item-y',item.y.toFixed(3)+'px')});
  $('#zoom-value').textContent=Math.round(canvasView.z*100)+'%';
}
function animateCanvas(now){
  const dt=canvasView.time===null?1:Math.min(3,(now-canvasView.time)/(1000/60));canvasView.time=now;
  const ease=1-Math.pow(.8,dt);
  canvasView.x+=(canvasView.tx-canvasView.x)*ease;canvasView.y+=(canvasView.ty-canvasView.y)*ease;canvasView.z+=(canvasView.tz-canvasView.z)*ease;
  generationItems.forEach(item=>{item.x+=(item.tx-item.x)*ease;item.y+=(item.ty-item.y)*ease});
  const unsettled=generationItems.some(item=>Math.abs(item.tx-item.x)+Math.abs(item.ty-item.y)>.02)||Math.abs(canvasView.tx-canvasView.x)+Math.abs(canvasView.ty-canvasView.y)>.02||Math.abs(canvasView.tz-canvasView.z)>.0001;
  if(!unsettled){generationItems.forEach(item=>{item.x=item.tx;item.y=item.ty});canvasView.x=canvasView.tx;canvasView.y=canvasView.ty;canvasView.z=canvasView.tz}
  paintCanvas();
  if(unsettled)canvasView.frame=requestAnimationFrame(animateCanvas);else{canvasView.frame=0;canvasView.time=null}
}
function requestCanvasFrame(){
  if(reduceMotion){generationItems.forEach(item=>{item.x=item.tx;item.y=item.ty});canvasView.x=canvasView.tx;canvasView.y=canvasView.ty;canvasView.z=canvasView.tz;paintCanvas();return}
  if(!canvasView.frame)canvasView.frame=requestAnimationFrame(animateCanvas);
}
function zoomCanvas(scale,clientX,clientY){
  const r=canvasViewport.getBoundingClientRect();
  const px=clientX===undefined?0:clientX-r.left-canvasScene.offsetLeft,py=clientY===undefined?0:clientY-r.top-canvasScene.offsetTop;
  const z=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,scale));
  canvasView.tx=px-(px-canvasView.tx)*z/canvasView.tz;
  canvasView.ty=py-(py-canvasView.ty)*z/canvasView.tz;
  canvasView.tz=z;requestCanvasFrame();
}
function resetCanvas(fit=false){
  canvasView.tx=0;canvasView.ty=0;canvasView.tz=1;
  if(fit&&generationItems.length){
    const bounds=generationBounds();
    canvasView.tz=Math.max(MIN_ZOOM,Math.min(1,(canvasViewport.clientWidth-48)/bounds.width,Math.max(80,canvasViewport.clientHeight-dock.offsetHeight-120)/bounds.height));
    canvasView.tx=-bounds.x*canvasView.tz;canvasView.ty=-bounds.y*canvasView.tz;
  }
  requestCanvasFrame();
}
function generationBounds(){
  const items=expandedStack?generationItems.filter(item=>item.stackId===expandedStack.id):generationItems;
  const left=Math.min(...items.map(item=>item.tx-item.element.offsetWidth/2));
  const right=Math.max(...items.map(item=>item.tx+item.element.offsetWidth/2));
  const top=Math.min(...items.map(item=>item.ty-item.element.offsetHeight/2));
  const bottom=Math.max(...items.map(item=>item.ty-item.element.offsetHeight/2+generationHeight(item)));
  return {x:(left+right)/2,y:(top+bottom)/2,width:right-left,height:bottom-top};
}
function itemAt(target){return generationNodes.get(target.closest('.generation-item'))}
function clearItemDragging(){finishStackLift(canvasDrag);clearStackDrop();generationItems.forEach(item=>item.element.classList.remove('item-dragging','magnet-resisting'));selectionBox.classList.remove('is-visible')}
function stepCanvasZoom(direction){const steps=[.01,.02,.05,.1,.15,.25,.5,.75,1,1.25,1.5,2,2.5];zoomCanvas(direction>0?(steps.find(z=>z>canvasView.tz+.001)??MAX_ZOOM):([...steps].reverse().find(z=>z<canvasView.tz-.001)??MIN_ZOOM))}
$('#zoom-reset').addEventListener('click',()=>resetCanvas());
$('#zoom-fit').addEventListener('click',()=>resetCanvas(true));
canvasViewport.addEventListener('wheel',e=>{
  if(!canvasActive())return;e.preventDefault();
  const unit=e.deltaMode===1?16:e.deltaMode===2?canvasViewport.clientHeight:1;
  if(e.ctrlKey||e.metaKey)zoomCanvas(canvasView.tz*Math.exp(-Math.max(-200,Math.min(200,e.deltaY*unit))*.008),e.clientX,e.clientY);
  else{canvasView.tx-=(e.shiftKey&&e.deltaX===0?e.deltaY:e.deltaX)*unit;canvasView.ty-=(e.shiftKey&&e.deltaX===0?0:e.deltaY)*unit;requestCanvasFrame()}
},{passive:false});
function pinchState(){const [a,b]=[...canvasPointers.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))}}
canvasViewport.addEventListener('pointerdown',e=>{
  if(!canvasActive()||e.button>1)return;
  if(e.target.closest('.generation-card-actions')){canvasMoved=false;return}
  const touch=e.pointerType==='touch';
  const item=itemAt(e.target),type=item&&!canvasSpace&&e.button!==1?'card':(!touch&&!canvasSpace&&e.button===0?'selection':'canvas');
  if(!touch)e.preventDefault();
  if(canvasDrag?.stackLift)finishStackLift(canvasDrag);
  canvasMoved=false;canvasPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  canvasDrag={id:e.pointerId,type,item,rawX:item?.tx??0,rawY:item?.ty??0,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY};
  if(type==='card'){
    canvasDrag.wasSelected=selectedGenerations.has(item);canvasDrag.additive=e.shiftKey;
    if(!selectedGenerations.has(item))selectGenerations(e.shiftKey?[...selectedGenerations,item]:[]);
    const inStack=Boolean(expandedStack&&expandedStack.id===item.stackId);
    const members=inStack?[item]:selectedGenerations.has(item)?[...selectedGenerations]:expandStacks([item]);
    canvasDrag.members=members.map(item=>({item,x:item.tx,y:item.ty}));
    canvasDrag.originX=item.tx;canvasDrag.originY=item.ty;canvasDrag.bonded=magneticNeighbours(members);canvasDrag.detached=false;
    canvasDrag.members.forEach(member=>member.item.element.style.zIndex=String(++cardStack));
    if(inStack)beginStackLift(canvasDrag);
  }else if(type==='selection'){
    canvasDrag.baseSelection=e.shiftKey?[...selectedGenerations]:[];if(!e.shiftKey)selectGenerations([]);
  }
  if(canvasPointers.size===2){canvasPinch=pinchState();canvasMoved=true;clearItemDragging();canvasDrag=null}
  if(!touch&&type!=='card'){canvasViewport.setPointerCapture(e.pointerId);canvasViewport.focus({preventScroll:true})}
});
canvasViewport.addEventListener('pointermove',e=>{
  if(!canvasPointers.has(e.pointerId))return;
  canvasPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(canvasPointers.size>=2){
    const next=pinchState();
    if(canvasPinch){canvasView.tx+=next.x-canvasPinch.x;canvasView.ty+=next.y-canvasPinch.y;zoomCanvas(canvasView.tz*next.d/canvasPinch.d,next.x,next.y)}
    canvasPinch=next;canvasMoved=true;canvasViewport.classList.add('canvas-panning');return;
  }
  if(!canvasDrag||canvasDrag.id!==e.pointerId)return;
  if(!canvasMoved&&Math.hypot(e.clientX-canvasDrag.x,e.clientY-canvasDrag.y)<3)return;
  canvasMoved=true;canvasViewport.setPointerCapture(e.pointerId);
  if(canvasDrag.type==='card'){
    canvasDrag.members.forEach(({item})=>{item.element.classList.add('item-dragging');resetLiveCard(item)});
    canvasDrag.rawX+=(e.clientX-canvasDrag.lastX)/canvasView.z;canvasDrag.rawY+=(e.clientY-canvasDrag.lastY)/canvasView.z;
    moveDraggedCards(false,e.altKey);if(!canvasDrag.stackLift)updateStackDrop(canvasDrag,e.clientX,e.clientY,e.altKey);
  }else if(canvasDrag.type==='selection'){
    const left=Math.min(canvasDrag.x,e.clientX),top=Math.min(canvasDrag.y,e.clientY),right=Math.max(canvasDrag.x,e.clientX),bottom=Math.max(canvasDrag.y,e.clientY),r=canvasViewport.getBoundingClientRect();
    Object.assign(selectionBox.style,{left:left-r.left+'px',top:top-r.top+'px',width:right-left+'px',height:bottom-top+'px'});selectionBox.classList.add('is-visible');
    selectGenerations([...canvasDrag.baseSelection,...generationItems.filter(item=>{if(expandedStack&&item.stackId!==expandedStack.id)return false;const b=item.element.getBoundingClientRect();return b.right>left&&b.left<right&&b.bottom>top&&b.top<bottom})]);
  }else{canvasViewport.classList.add('canvas-panning');canvasView.tx+=e.clientX-canvasDrag.lastX;canvasView.ty+=e.clientY-canvasDrag.lastY}
  canvasDrag.lastX=e.clientX;canvasDrag.lastY=e.clientY;requestCanvasFrame();
});
function endCanvasPointer(e){
  if(canvasMoved&&canvasDrag?.type==='card'){
    if(!finishStackDrop(canvasDrag,e))moveDraggedCards(true,e.altKey);canvasDrag.members.forEach(({item})=>item.element.classList.add('just-dragged'));requestCanvasFrame();
  }
  if(!canvasMoved&&canvasDrag?.type==='card'&&canvasDrag.additive&&canvasDrag.wasSelected){expandStacks([canvasDrag.item]).forEach(item=>selectedGenerations.delete(item));paintSelection()}
  if(!canvasMoved&&canvasDrag?.type==='card'&&!canvasDrag.additive&&canvasDrag.item.stackId&&expandedStack?.id!==canvasDrag.item.stackId){const item=canvasDrag.item;item.suppressViewerClick=true;setTimeout(()=>item.suppressViewerClick=false,100);openStackFocus(item.stackId)}
  if(!canvasMoved&&canvasDrag?.type==='selection'&&expandedStack)closeStackFocus();
  const extracted=canvasDrag?.stackLift?.detached;
  canvasPointers.delete(e.pointerId);canvasPinch=null;clearItemDragging();
  if(extracted&&expandedStack)closeStackFocus(true,false);
  if(canvasViewport.hasPointerCapture(e.pointerId))canvasViewport.releasePointerCapture(e.pointerId);
  if(canvasPointers.size===1){const [id,p]=[...canvasPointers.entries()][0];canvasDrag={id,type:'canvas',x:p.x,y:p.y,lastX:p.x,lastY:p.y}}
  else{canvasDrag=null;canvasViewport.classList.remove('canvas-panning')}
}
canvasViewport.addEventListener('pointerup',endCanvasPointer);
canvasViewport.addEventListener('pointercancel',endCanvasPointer);
canvasViewport.addEventListener('click',e=>{if(canvasMoved){e.preventDefault();e.stopPropagation();canvasMoved=false}},true);
canvasViewport.addEventListener('dragstart',e=>e.preventDefault());
function clearCanvasGesture(){clearItemDragging();canvasPointers.clear();canvasDrag=null;canvasPinch=null;canvasSpace=false;canvasViewport.classList.remove('canvas-panning','canvas-space')}
window.addEventListener('blur',clearCanvasGesture);
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.target.closest('input,textarea,[contenteditable=true]')&&lastDeleted.length){e.preventDefault();undoGenerationDeletion();return}
  if(!canvasActive()||e.target.closest('input,textarea,[contenteditable=true],.generation-card-actions'))return;
  const inCanvas=canvasViewport.contains(e.target)||e.target===document.body;
  if(e.key==='Escape'&&expandedStack){clearCanvasGesture();closeStackFocus();selectGenerations([]);return}
  if(e.key==='Escape'&&selectedGenerations.size){selectGenerations([]);return}
  if(inCanvas&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();selectGenerations(expandedStack?generationItems.filter(item=>item.stackId===expandedStack.id):generationItems);return}
  if(e.code==='Space'&&inCanvas){e.preventDefault();canvasSpace=true;canvasViewport.classList.add('canvas-space')}
  if(inCanvas&&['+','=','-','0'].includes(e.key)){
    e.preventDefault();if(e.key==='0')resetCanvas(e.shiftKey);else stepCanvasZoom(e.key==='-'?-1:1);
  }
  if(inCanvas&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();if(itemAt(e.target)){const item=itemAt(e.target);item.tx+=e.key==='ArrowLeft'?-16:e.key==='ArrowRight'?16:0;item.ty+=e.key==='ArrowUp'?-16:e.key==='ArrowDown'?16:0}else{canvasView.tx+=e.key==='ArrowLeft'?48:e.key==='ArrowRight'?-48:0;canvasView.ty+=e.key==='ArrowUp'?48:e.key==='ArrowDown'?-48:0}requestCanvasFrame();
  }
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){canvasSpace=false;canvasViewport.classList.remove('canvas-space')}});
paintCanvas();

function animateLiveCard(item,now){
  const live=item.live,dt=live.time===null?1:Math.min(3,(now-live.time)/(1000/60));live.time=now;
  const ease=1-Math.pow(.91,dt);live.x+=(live.tx-live.x)*ease;live.y+=(live.ty-live.y)*ease;
  item.card.style.setProperty('--live-rx',(-live.y*7).toFixed(3)+'deg');
  item.card.style.setProperty('--live-ry',(live.x*7).toFixed(3)+'deg');
  item.card.style.setProperty('--live-x',(live.x*-7).toFixed(3)+'px');
  item.card.style.setProperty('--live-y',(live.y*-7).toFixed(3)+'px');
  item.card.style.setProperty('--live-light-x',(50+live.x*30)+'%');
  item.card.style.setProperty('--live-light-y',(35+live.y*30)+'%');
  if(Math.abs(live.tx-live.x)+Math.abs(live.ty-live.y)>.002)live.frame=requestAnimationFrame(now=>animateLiveCard(item,now));
  else{live.frame=0;live.time=null}
}
function requestLiveFrame(item){if(!item.live.frame&&!reduceMotion)item.live.frame=requestAnimationFrame(now=>animateLiveCard(item,now))}
function resetLiveCard(item){if(!item)return;item.live.tx=0;item.live.ty=0;requestLiveFrame(item)}
function normalizedCardSize(width,height){
  // Comparable visual area for every source resolution, bounded for extreme aspect ratios.
  const ratio=width/height,area=391*220;
  const w=Math.sqrt(area*ratio),h=w/ratio,scale=Math.min(1,420/Math.max(w,h));
  return {width:w*scale,height:h*scale};
}
function addGenerationCardActions(item){
  const imageResult=item.kind==='image';
  const overlay=document.createElement('div'),controls=document.createElement('div');
  overlay.className='generation-card-overlay';controls.className='generation-card-actions';controls.setAttribute('role','group');controls.setAttribute('aria-label',`Actions for generation ${item.id}`);
  const actions=[...(imageResult||item.kind==='text'?[['enhance',imageResult?'Edit image':'Edit writing','adf5e']]:[]),['download','Download','8dfd8'],...(!imageResult?[['share','Share','91cdd']]:[])];
  for(const [action,label,asset] of actions){
    const button=document.createElement('button'),icon=document.createElement('span'),image=document.createElement('img');
    button.type='button';button.className='generation-card-action '+(imageResult?'':'tip ')+(action==='download'?'card-download':'');button.dataset.action=action;button.setAttribute('aria-label',`${label} generation ${item.id}`);button.disabled=true;
    button.dataset.tip=label;
    icon.className='generation-card-action-icon'+(action==='enhance'?' card-enhance-icon':'');image.src=`assets/generation-hover-${asset}.svg`;image.alt='';image.draggable=false;icon.append(image);button.append(icon);
    const text=document.createElement('span');text.className='card-action-label';text.textContent=label;button.append(text);if(!imageResult)bindTooltip(button);
    button.addEventListener('click',e=>{
      e.stopPropagation();hideTooltip(true);if(item.status!=='complete')return;
      if(action==='download')downloadGenerations([item]).catch(()=>toast('Could not download the image. Try again.'));
      else if(action==='enhance')enhanceGenerations([item]);else shareGenerations([item]);
    });
    controls.append(button);
  }
  controls.addEventListener('pointerdown',e=>{canvasMoved=false;e.stopPropagation()});
  overlay.append(controls);item.element.append(overlay);
}
function syncGenerationCardActions(locked=running){
  $('#viewer-enhance').disabled=locked;
  generationItems.forEach(item=>item.element.querySelectorAll('.generation-card-action').forEach(button=>{button.disabled=item.status!=='complete'||(button.dataset.action==='enhance'&&locked)}));
}
async function makeGeneration(request,kind){
  const id=++generationNumber,element=document.createElement('div'),card=document.createElement('button'),image=document.createElement('img'),sheen=document.createElement('span'),progress=document.createElement('span');
  element.className='generation-item'+(kind==='image'?' image-result':'');element.dataset.generationId=String(id);
  card.type='button';card.className='result-card';card.setAttribute('aria-label',`Generation ${id}, generating${mobileLayout.matches?'':'. Drag to move'}`);
  image.alt=`Generation ${id}`;image.draggable=false;
  sheen.className='live-sheen';sheen.setAttribute('aria-hidden','true');
  progress.className='progress-label';progress.textContent='Queued';progress.setAttribute('role','status');progress.setAttribute('aria-label',`Generation ${id} status`);
  card.append(image,sheen,progress);element.append(card);
  const item={id,kind,element,card,image,progress,status:'pending',x:0,y:0,tx:0,ty:0,url:null,prompt:promptInput.value,live:{x:0,y:0,tx:0,ty:0,time:null,frame:0},rippleTimer:null};
  const source=attachments.find(a=>a.url);
  if(source){item.url=URL.createObjectURL(source.file);image.src=item.url}
  else image.src='assets/b80ae.svg';
  try{await image.decode()}catch{}
  if(request!==generationRequest||!running){disposeGeneration(item);return null}
  item.references=attachments.filter(a=>a.url).map(a=>({url:URL.createObjectURL(a.file),name:a.file.name}));
  const nativeWidth=image.naturalWidth||270,nativeHeight=image.naturalHeight||270;
  const {width,height}=normalizedCardSize(nativeWidth,nativeHeight);
  item.width=width;item.height=height;
  element.style.setProperty('--item-aspect',String(nativeWidth/nativeHeight));
  element.style.width=width+'px';element.style.height=height+'px';element.dataset.imageWidth=String(nativeWidth);element.dataset.imageHeight=String(nativeHeight);
  card.title=`${nativeWidth} × ${nativeHeight}`;
  if(mobileLayout.matches)canvasScene.prepend(element);else canvasScene.append(element);
  const previous=generationItems.at(-1);
  if(previous){
    if(!mobileLayout.matches)canvasView.tz=generationRevealZoom(item);
    item.x=item.tx=previous.tx+(previous.width+width)/2+CARD_GAP;
    item.y=item.ty=previous.ty+(height-previous.height)/2;
  }
  generationItems.push(item);generationNodes.set(element,item);addGenerationCardActions(item);layoutGenerationItems();paintCanvas();
  card.addEventListener('pointermove',e=>{
    if(item.status!=='pending'||reduceMotion||mobileLayout.matches||canvasSpace||canvasDrag||e.pointerType==='touch')return;
    const r=card.getBoundingClientRect();item.live.tx=Math.max(-1,Math.min(1,2*(e.clientX-r.left)/r.width-1));item.live.ty=Math.max(-1,Math.min(1,2*(e.clientY-r.top)/r.height-1));requestLiveFrame(item);
  });
  card.addEventListener('pointerleave',()=>{element.classList.remove('just-dragged');resetLiveCard(item)});card.addEventListener('pointercancel',()=>resetLiveCard(item));
  card.addEventListener('click',e=>{
    if(item.suppressViewerClick||e.shiftKey)return;
    if(item.status==='complete'){
      if(e.detail===0&&item.stackId&&!mobileLayout.matches&&expandedStack?.id!==item.stackId){openStackFocus(item.stackId);return}
      openGenerationViewer(item);return;
    }
    if(e.detail===0&&item.stackId&&!e.shiftKey&&!mobileLayout.matches&&expandedStack?.id!==item.stackId){openStackFocus(item.stackId);return}
    if(item.status!=='pending'||reduceMotion)return;
    const r=card.getBoundingClientRect(),ripple=document.createElement('span');ripple.className='live-ripple';ripple.setAttribute('aria-hidden','true');
    ripple.style.left=(e.detail?Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*card.offsetWidth:card.offsetWidth/2)+'px';
    ripple.style.top=(e.detail?Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))*card.offsetHeight:card.offsetHeight/2)+'px';
    if(card.querySelectorAll('.live-ripple').length>=4)card.querySelector('.live-ripple').remove();
    card.append(ripple);ripple.addEventListener('animationend',()=>ripple.remove(),{once:true});
    item.live.ty=-.45;requestLiveFrame(item);clearTimeout(item.rippleTimer);item.rippleTimer=setTimeout(()=>resetLiveCard(item),160);
  });
  return item;
}
function generationRevealZoom(item){
  const width=Math.max(80,canvasViewport.clientWidth-48),height=Math.max(80,canvasViewport.clientHeight-dock.offsetHeight-160);
  return Math.max(MIN_ZOOM,Math.min(canvasView.tz,width/item.width,height/generationHeight(item)));
}
function revealGeneration(item,first){
  if(mobileLayout.matches){
    const r=item.element.getBoundingClientRect(),bottom=innerHeight-dock.offsetHeight-(running?84:36);
    if(r.top<80||r.bottom>bottom)window.scrollTo({top:Math.max(0,window.scrollY+r.top-80),behavior:reduceMotion?'instant':'smooth'});
    return;
  }
  if(first){resetCanvas(true);return}
  // Keep the user's zoom, shifting the camera only when the new card is outside the usable view.
  canvasView.tz=generationRevealZoom(item);
  const originX=canvasScene.offsetLeft,originY=canvasScene.offsetTop,z=canvasView.tz;
  const halfW=item.element.offsetWidth*z/2,halfH=item.element.offsetHeight*z/2,footer=(generationHeight(item)-item.element.offsetHeight)*z;
  const cx=originX+canvasView.tx+item.tx*z,cy=originY+canvasView.ty+item.ty*z;
  const left=24,right=canvasViewport.clientWidth-24,top=mobileLayout.matches?112:76,bottom=canvasViewport.clientHeight-dock.offsetHeight-80;
  if(cx+halfW>right)canvasView.tx-=cx+halfW-right;else if(cx-halfW<left)canvasView.tx+=left-(cx-halfW);
  if(cy+halfH+footer>bottom)canvasView.ty-=cy+halfH+footer-bottom;else if(cy-halfH<top)canvasView.ty+=top-(cy-halfH);
  requestCanvasFrame();
}
function disposeGeneration(item){
  item.references?.forEach(ref=>URL.revokeObjectURL(ref.url));
  cancelAnimationFrame(item.live.frame);clearTimeout(item.rippleTimer);if(item.url)URL.revokeObjectURL(item.url);
}
function setGenerationLocked(locked){
  generate.disabled=locked;form.setAttribute('aria-busy',String(locked));$('#request-retry').disabled=locked;syncGenerationCardActions(locked);promptInput.readOnly=locked;$('#attach-button').disabled=locked;$$('.attachment-remove').forEach(button=>button.disabled=locked);
}
function refreshGenerationView(){
  const visible=generationItems.length>0&&!showingHome;
  if(!$('#request-open').hidden&&!generationItems.some(item=>item.status==='complete'))showRequestMessage('');
  workspace.classList.toggle('has-result',visible);
  workspace.classList.toggle('generating',visible&&running);
  $('#generation').hidden=!visible;$('#template-stage').inert=visible;
  syncSessionFolder();syncGenerationCardActions();syncActionsMenu();
}
function syncSessionFolder(){
  const name=$('#workspace-name').textContent,active=!$('#generation').hidden&&generationItems.length>0&&!document.body.classList.contains('templates-open');
  $('#session-nav').hidden=generationItems.length===0;
  $('#session-name').textContent=name;$('#session-button').dataset.tip=name;
  $('#session-button').setAttribute('aria-label',`Open workspace: ${name}`);
  if(active)$('#session-button').setAttribute('aria-current','page');else $('#session-button').removeAttribute('aria-current');
}
$('#session-button').addEventListener('click',()=>{
  closeTemplates();
  if(!generationItems.length)return;
  closeGenerationViewer(true);
  showingHome=false;refreshGenerationView();if(mobileLayout.matches)setSidebar(false);
});
function stopGeneration(){
  clearTimeout(timer);timer=null;running=false;currentGeneration=null;
  workspace.classList.remove('generating');dock.classList.remove('processing');
  setGenerationLocked(false);
  generate.setAttribute('aria-label','Generate');generate.dataset.tip='Generate';
  refreshGenerationView();updatePrompt();
}
form.addEventListener('submit',prepareCreation);
function goHome(){
  closeTemplates();
  closeGenerationViewer(true);
  if(expandedStack)closeStackFocus();
  clearCanvasGesture();generationItems.forEach(item=>resetLiveCard(item));hideTooltip(true);
  showingHome=true;selectGenerations([]);refreshGenerationView();resetCardMotion();
  if(mobileLayout.matches){setSidebar(false,{focus:false});window.scrollTo({top:0,behavior:'instant'})}
}
$('#close-result').addEventListener('click',goHome);
$$('[data-home-trigger]').forEach(button=>button.addEventListener('click',goHome));
window.addEventListener('blur',()=>generationItems.forEach(item=>resetLiveCard(item)));
function layoutGenerationItems(){
  canvasScene.classList.toggle('single-generation',generationItems.length===1);
  if(mobileLayout.matches){
    const columns=[0,1].map(()=>{const column=document.createElement('div');column.className='generation-column';return column});
    [...generationItems].reverse().forEach((item,index)=>columns[index%2].append(item.element));
    columns[1].hidden=generationItems.length<2;
    canvasScene.replaceChildren(...columns);
  }else canvasScene.replaceChildren(...generationItems.map(item=>item.element));
}
function syncGenerationLayout(){
  if(expandedStack)closeStackFocus();
  if(mobileLayout.matches)selectGenerations([]);
  refreshStacks();layoutGenerationItems();
  clearCanvasGesture();generationItems.forEach(item=>{item.element.classList.remove('just-dragged','stack-drop-hover','stack-drop-ready');resetLiveCard(item);item.card.setAttribute('aria-label',`Generation ${item.id}${item.status==='pending'?', generating':''}${mobileLayout.matches?'':'. Drag to move'}`)});
  canvasViewport.tabIndex=mobileLayout.matches?-1:0;
  canvasViewport.setAttribute('aria-label',mobileLayout.matches?'Generations grid':'Workspace canvas');
}
mobileLayout.addEventListener('change',syncGenerationLayout);syncGenerationLayout();

function openStackFocus(id){
  if(mobileLayout.matches||expandedStack?.id===id)return;
  if(expandedStack)closeStackFocus();
  const members=generationItems.filter(item=>item.stackId===id).sort((a,b)=>a.id-b.id);if(members.length<2)return;
  const x=members[0].tx,y=members[0].ty,columns=Math.min(3,members.length),rows=Math.ceil(members.length/columns);
  const width=Math.max(...members.map(item=>item.width)),height=Math.max(...members.map(generationHeight));
  expandedStack={id,x,y,extracted:new Set(),view:{tx:canvasView.tx,ty:canvasView.ty,tz:canvasView.tz}};
  members.forEach((item,index)=>{item.tx=x+(index%columns-(columns-1)/2)*(width+CARD_GAP);item.ty=y+(Math.floor(index/columns)-(rows-1)/2)*(height+CARD_GAP);item.element.style.zIndex=String(++cardStack)});
  workspace.classList.add('stack-focus-open');selectGenerations([]);refreshStacks();
  const bounds=generationBounds(),z=Math.max(MIN_ZOOM,Math.min(1,(canvasViewport.clientWidth-96)/bounds.width,Math.max(80,canvasViewport.clientHeight-dock.offsetHeight-160)/bounds.height));
  canvasView.tz=z;canvasView.tx=-bounds.x*z;canvasView.ty=-bounds.y*z;requestCanvasFrame();
}
function closeStackFocus(collapse=true,restoreView=true){
  if(!expandedStack)return;if(canvasDrag?.stackLift&&!canvasDrag.stackLift.detached)finishStackLift(canvasDrag);const state=expandedStack;expandedStack=null;
  if(collapse)generationItems.filter(item=>item.stackId===state.id).sort((a,b)=>a.id-b.id).forEach((item,index)=>{item.tx=state.x+index*12;item.ty=state.y+index*12});
  workspace.classList.remove('stack-focus-open');
  if(restoreView)Object.assign(canvasView,state.view);
  refreshStacks();requestCanvasFrame();
}
function refreshStacks(){
  const stacks=new Map();
  generationItems.forEach(item=>{item.element.style.setProperty('--stack-rotation','0deg');item.element.classList.remove('is-stacked','stack-front','is-expanded');item.element.classList.toggle('stack-focus-member',Boolean(expandedStack&&(item.stackId===expandedStack.id||expandedStack.extracted.has(item))));item.element.inert=Boolean(expandedStack&&item.stackId!==expandedStack.id&&!expandedStack.extracted.has(item));item.element.querySelector('.stack-count')?.remove();if(item.stackId){if(!stacks.has(item.stackId))stacks.set(item.stackId,[]);stacks.get(item.stackId).push(item)}});
  if(mobileLayout.matches)return;
  for(const members of stacks.values()){
    if(members.length<2){members.forEach(item=>item.stackId=null);continue}
    members.forEach(item=>item.element.classList.add('is-stacked'));
    if(expandedStack?.id===members[0].stackId){members.forEach(item=>item.element.classList.add('is-expanded'));continue}
    const angles=[-1.5,1,.5,-.75,1.25,-.5];members.forEach((item,index)=>item.element.style.setProperty('--stack-rotation',angles[index%angles.length]+'deg'));
    const front=members.at(-1);front.element.classList.add('stack-front');
  }
  if(expandedStack&&generationItems.filter(item=>item.stackId===expandedStack.id).length<2)closeStackFocus(false,false);
}
$('#action-stack').addEventListener('click',()=>{
  if(mobileLayout.matches)return;
  const members=[...selectedGenerations].sort((a,b)=>a.id-b.id);if(members.length<2||members.some(item=>item.status!=='complete'))return;
  const stacked=members[0].stackId&&members.every(item=>item.stackId===members[0].stackId);
  if(stacked){
    const wasExpanded=expandedStack?.id===members[0].stackId;
    if(expandedStack)closeStackFocus(!wasExpanded,!wasExpanded);
    const origin=members[0];let right=origin.tx-origin.width/2;
    members.forEach(item=>{item.stackId=null;if(!wasExpanded){item.tx=right+item.width/2;item.ty=origin.ty+(item.height-origin.height)/2;right+=item.width+CARD_GAP}});
  }else{
    if(expandedStack)closeStackFocus(false,false);
    arrangeStack(members,members[0].tx,members[0].ty);
  }
  refreshStacks();paintSelection();requestCanvasFrame();
});
async function selectionFiles(items){
  return Promise.all(items.map(async item=>{const response=await fetch(item.downloadUrl);if(!response.ok)throw new Error('Result unavailable');const blob=await response.blob(),extension=item.kind==='video'?'mp4':item.kind==='audio'?'mp3':item.kind==='text'?'txt':blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png';return new File([blob],`generation-${item.id}.${extension}`,{type:blob.type})}));
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
async function zipSelection(files){
  const parts=[],directory=[],encoder=new TextEncoder();let offset=0;
  for(const file of files){
    const data=new Uint8Array(await file.arrayBuffer()),name=encoder.encode(file.name);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}crc=(crc^0xffffffff)>>>0;
    const header=new Uint8Array(30+name.length),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,name.length,true);header.set(name,30);parts.push(header,data);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);directory.push(central);offset+=header.length+data.length;
  }
  const size=directory.reduce((sum,entry)=>sum+entry.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
async function downloadGenerations(items){if(items.length===1){const link=document.createElement('a');link.href=items[0].downloadUrl;link.download='generation';link.click();return;}const files=await selectionFiles(items);if(files.length===1)downloadBlob(files[0],files[0].name);else if(files.length)downloadBlob(await zipSelection(files),'generations.zip')}
$('#action-download').addEventListener('click',()=>downloadGenerations([...selectedGenerations]).catch(()=>toast('Could not download the selection. Try again.')));
async function enhanceGenerations(items){
  if(!items.length||running||items.some(item=>!['image','text'].includes(item.kind)))return;
  referenceJobIds=items.map(item=>item.jobId);
  $('#reference-summary').textContent=`Using ${items.length} selected ${items.length===1?'result':'results'} as input`;
  $('#reference-summary').hidden=false;
  promptInput.value='';promptInput.placeholder='Describe how you want to change the selected results…';
  selectGenerations([]);updatePrompt();promptInput.focus({preventScroll:true});
}
$('#action-enhance').addEventListener('click',()=>enhanceGenerations([...selectedGenerations]));
async function shareGenerations(items){
  shareItems=[...items];if(!shareItems.length)return;
  try{
    const files=await selectionFiles(shareItems);
    if(navigator.canShare?.({files})&&navigator.share){try{await navigator.share({files,title:$('#workspace-name').textContent});return}catch(error){if(error.name==='AbortError')return}}
    const preview=$('#selection-share-preview');preview.replaceChildren();shareItems.forEach(item=>{const image=document.createElement('img');image.src=item.image.src;image.alt=`Generation ${item.id}`;preview.append(image)});
    $('#share-copy').textContent=shareItems.length>1?'Copy prompts':'Copy prompt';$('#selection-share-dialog').showModal();
  }catch(error){if(error.name!=='AbortError')toast('Could not share the selection. Try again.')}
}
$('#action-share').addEventListener('click',()=>shareGenerations([...selectedGenerations]));
$('#share-close').addEventListener('click',()=>$('#selection-share-dialog').close());
$('#share-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(shareItems.map(item=>item.prompt).join('\n\n'));toast('Prompt copied')}catch{toast('Could not copy the prompt')}});
$('#share-download').addEventListener('click',()=>downloadGenerations(shareItems).catch(()=>toast('Could not download the selection. Try again.')));
async function undoGenerationDeletion(){
  if(!lastDeleted.length)return;
  const entries=lastDeleted;
  try{await api('/api/jobs/restore',{ids:entries.map(({item})=>item.jobId)})}catch(error){toast(error.message);return}
  if(lastDeleted!==entries)return;
  sessionRequest++;
  lastDeleted.forEach(({item,index})=>generationItems.splice(Math.min(index,generationItems.length),0,item));const restored=lastDeleted.map(entry=>entry.item);lastDeleted=[];
  layoutGenerationItems();refreshStacks();refreshGenerationView();selectGenerations(restored);requestCanvasFrame();$('#toast').classList.remove('visible');
}
$('#action-delete').addEventListener('click',()=>deleteGenerations([...selectedGenerations]));
async function deleteGenerations(items){
  if(!items.length)return;
  try{await api('/api/jobs/delete',{ids:items.map(item=>item.jobId)})}catch(error){toast(error.message);return}
  sessionRequest++;
  lastDeleted.forEach(({item})=>disposeGeneration(item));lastDeleted=[];
  if(currentGeneration&&items.includes(currentGeneration)){toast('Wait for this creation to finish.');return;}
  lastDeleted=items.filter(item=>generationItems.includes(item)).map(item=>({item,index:generationItems.indexOf(item)})).sort((a,b)=>a.index-b.index);
  lastDeleted.forEach(({item})=>{item.element.remove();generationItems.splice(generationItems.indexOf(item),1)});
  selectGenerations([]);layoutGenerationItems();refreshStacks();refreshGenerationView();requestCanvasFrame();
  if(lastDeleted.length){toast(`Deleted ${lastDeleted.length} ${lastDeleted.length===1?'generation':'generations'}`);clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),8000);const undo=document.createElement('button');undo.type='button';undo.textContent='Undo';undo.addEventListener('click',undoGenerationDeletion);$('#toast').append(undo)}
}

window.addEventListener('pagehide',()=>{generationItems.forEach(disposeGeneration);lastDeleted.forEach(({item})=>disposeGeneration(item));clearInterval(timer);attachments.forEach(a=>{if(a.url)URL.revokeObjectURL(a.url)})});

// Share the already-visible tooltip state across nearby triggers.
let tooltipTarget=null,tooltipDelay=null,tooltipReset=null,tooltipWarm=false;
function hideTooltip(reset=false){clearTimeout(tooltipDelay);if(tooltipTarget){tooltipTarget.classList.remove('tooltip-visible','tooltip-instant');tooltipTarget=null}if(reset){clearTimeout(tooltipReset);tooltipWarm=false}}
function enterTooltip(button){clearTimeout(tooltipReset);hideTooltip();tooltipTarget=button;if(tooltipWarm){button.classList.add('tooltip-instant','tooltip-visible')}else{tooltipDelay=setTimeout(()=>{if(tooltipTarget!==button)return;button.classList.add('tooltip-visible');tooltipWarm=true},button.closest('.sidebar')?80:220)}}
function leaveTooltip(){hideTooltip();clearTimeout(tooltipReset);tooltipReset=setTimeout(()=>{tooltipWarm=false},90)}
function bindTooltip(button){button.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')enterTooltip(button)});button.addEventListener('pointerleave',leaveTooltip);button.addEventListener('focus',()=>{if(button.matches(':focus-visible'))enterTooltip(button)});button.addEventListener('blur',()=>{if(!button.matches(':hover'))leaveTooltip()});button.addEventListener('pointerdown',()=>hideTooltip(true))}
$$('.tip').forEach(bindTooltip);
window.addEventListener('blur',()=>hideTooltip(true));document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTooltip(true)});

// Animate details of the original SVGs without moving their outer silhouettes.
const iconMotions={
  'moon-sway':[{transform:'rotate(0deg)',easing:'ease-in-out'},{transform:'rotate(-7deg)',offset:.3,easing:'ease-in-out'},{transform:'rotate(7deg)',offset:.68,easing:'ease-in-out'},{transform:'rotate(0deg)'}],
  lens:[{transform:'scale(1)'},{transform:'scale(1.09)',offset:.45},{transform:'scale(1)'}],
  plus:[{transform:'rotate(0deg)'},{transform:'rotate(90deg)'}],
  needle:[{transform:'rotate(0deg)',easing:'ease-in-out'},{transform:'rotate(-32deg)',offset:.3,easing:'ease-in-out'},{transform:'rotate(16deg)',offset:.68,easing:'ease-in-out'},{transform:'rotate(0deg)'}],
  'tag-sway':[{transform:'rotate(0deg)',easing:'ease-in-out'},{transform:'rotate(-10deg)',offset:.3,easing:'ease-in-out'},{transform:'rotate(10deg)',offset:.68,easing:'ease-in-out'},{transform:'rotate(0deg)'}],
  rays:[{transform:'rotate(0deg)'},{transform:'rotate(45deg)'}],
  'plus-vertical':[{transform:'scaleY(1)'},{transform:'scaleY(.6)',offset:.4},{transform:'scaleY(1)'}],
  'plus-horizontal':[{transform:'scaleX(1)'},{transform:'scaleX(.6)',offset:.4},{transform:'scaleX(1)'}],
  'mode-half':[{opacity:1},{opacity:.55,offset:.45},{opacity:1}],
  'mic-capsule':[{transform:'translateY(0)'},{transform:'translateY(-1.2px)',offset:.4},{transform:'translateY(0)'}],
  'sparkle-main':[{transform:'rotate(0deg) scale(1)'},{transform:'rotate(12deg) scale(1.1)',offset:.45},{transform:'rotate(0deg) scale(1)'}],
  'sparkle-small':[{transform:'scale(1)',opacity:1},{transform:'scale(.65)',opacity:.6,offset:.4},{transform:'scale(1)',opacity:1}]
};
const ICON_MOTION_DURATION=420;
const activeIconMotions=new WeakMap();
function animateIconDetails(button){
  if(reduceMotion||button.disabled)return;
  button.querySelectorAll('[data-icon-motion]').forEach(part=>{
    if(activeIconMotions.get(part)?.playState==='running')return;
    const name=part.dataset.iconMotion;
    const delay=name==='sparkle-small'?70:name==='plus-horizontal'?35:0;
    activeIconMotions.set(part,part.animate(iconMotions[name],{duration:ICON_MOTION_DURATION-delay,delay,easing:name==='needle'||name==='tag-sway'||name==='moon-sway'?'linear':'cubic-bezier(.22,1,.36,1)'}));
  });
}
$$('button').filter(button=>button.querySelector('[data-icon-motion]')).forEach(button=>{
  button.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')animateIconDetails(button)});
  button.addEventListener('focus',()=>{if(button.matches(':focus-visible'))animateIconDetails(button)});
});

// Keep root scrolling native; only compensate for a keyboard covering fixed controls.
function updateKeyboardOffset(){
  const viewport=window.visualViewport;
  const covered=viewport?Math.max(0,innerHeight-viewport.height-viewport.offsetTop):0;
  document.documentElement.style.setProperty('--keyboard-offset',((viewport?.scale??1)===1&&covered>150?covered:0)+'px');
}
window.visualViewport?.addEventListener('resize',updateKeyboardOffset);
window.visualViewport?.addEventListener('scroll',updateKeyboardOffset);
window.addEventListener('resize',updateKeyboardOffset);updateKeyboardOffset();
let composerWidth=0;
const composerObserver=new ResizeObserver(entries=>{
  for(const entry of entries){
    if(entry.target===dock)workspace.style.setProperty('--dock-height',(entry.borderBoxSize?.[0]?.blockSize??dock.offsetHeight)+'px');
    if(entry.target===form&&Math.abs(entry.contentRect.width-composerWidth)>.5){composerWidth=entry.contentRect.width;requestAnimationFrame(updatePrompt)}
  }
});
composerObserver.observe(form);composerObserver.observe(dock);

// Open the auth UI only from the explicitly designated account/navigation controls.
const authDialog=$('#auth-dialog');let authMotion=null,authReturnFocus=null,authClosing=false;
function openAuth(trigger){
  if(authDialog.open)return;
  authReturnFocus=mobileLayout.matches&&sidebar.contains(trigger)?$('#mobile-menu-button'):trigger;
  if(mobileLayout.matches&&sidebar.classList.contains('expanded'))setSidebar(false,{focus:false});
  hideTooltip(true);clearCanvasGesture();
  authClosing=false;authDialog.classList.remove('is-closing');
  document.documentElement.classList.add('auth-modal-open');authDialog.showModal();
  if(!reduceMotion)authMotion=authDialog.animate([{opacity:0,transform:`translateY(${mobileLayout.matches?28:18}px) scale(.985)`},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:360,easing:'cubic-bezier(.22,1,.36,1)'});
}
async function closeAuth(){
  if(!authDialog.open||authClosing)return;authClosing=true;authMotion?.cancel();authDialog.classList.add('is-closing');
  if(!reduceMotion){authMotion=authDialog.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(10px)'}],{duration:180,easing:'ease-in'});try{await authMotion.finished}catch{}}
  authDialog.close();authDialog.classList.remove('is-closing');document.documentElement.classList.remove('auth-modal-open');authClosing=false;
  authReturnFocus?.focus({preventScroll:true});
}
$$('[data-auth-trigger]').forEach(button=>button.addEventListener('click',()=>openAuth(button)));
$('#auth-close').addEventListener('click',closeAuth);
$$('[data-auth-provider],#auth-switch').forEach(link=>link.addEventListener('click',event=>{
  const popup=window.open('about:blank','_blank','popup,width=480,height=720');
  if(!popup)return;
  popup.opener=null;popup.location.href=link.href;event.preventDefault();
}));
const authChannel=new BroadcastChannel('create-here-auth');
authChannel.addEventListener('message',event=>{if(event.data==='connected')loadSession()});
if(new URLSearchParams(location.search).get('auth')==='complete'){
  authChannel.postMessage('connected');window.close();history.replaceState(null,'','/');
}
authDialog.addEventListener('cancel',e=>{e.preventDefault();closeAuth()});
let authBackdropDown=false;
authDialog.addEventListener('pointerdown',e=>{const r=authDialog.getBoundingClientRect();authBackdropDown=e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom});
authDialog.addEventListener('click',e=>{const r=authDialog.getBoundingClientRect();if(authBackdropDown&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))closeAuth();authBackdropDown=false});
authDialog.addEventListener('keydown',e=>e.stopPropagation());
// A separate preview surface animates from the card without changing canvas positions.
let openedGeneration=null,viewerClosing=false,viewerMotion=null,viewerRadiusMotion=null;
const viewer=$('#generation-viewer'),viewerShell=$('#viewer-image-shell');
// Reuse the canvas selection toolbar's buttons, SVGs and interaction styles.
['enhance','share','download','delete'].forEach(action=>{
  const button=$('#action-'+action).cloneNode(true);button.id='viewer-'+action;button.disabled=false;
  if(action==='delete'){button.setAttribute('aria-label','Delete generation');bindTooltip(button)}
  $('.viewer-actions').append(button);
});
function viewerLayout(){
  if(!openedGeneration)return;
  const r=viewer.getBoundingClientRect(),compact=r.width<950;
  const nativeWidth=openedGeneration.kind==='text'?640:openedGeneration.image.naturalWidth||openedGeneration.width,nativeHeight=openedGeneration.kind==='text'?720:openedGeneration.image.naturalHeight||openedGeneration.height;
  const maxWidth=Math.max(80,Math.min(compact?960:820,r.width-(compact?40:580))),maxHeight=Math.max(80,compact?r.height*.52:Math.min(720,r.height*.66));
  const scale=Math.min(1,maxWidth/nativeWidth,maxHeight/nativeHeight),w=nativeWidth*scale,h=nativeHeight*scale;
  const compactTop=mobileLayout.matches?120:80;
  const top=compact?compactTop+(Math.max(80,r.height*.52)-h)/2:(r.height-h)/2;
  Object.assign(viewerShell.style,{width:w+'px',height:h+'px',left:(r.width-w)/2+'px',top:top+'px'});
  const details=$('#viewer-details');
  Object.assign(details.style,compact?{left:'20px',top:(compactTop+Math.max(80,r.height*.52)+24)+'px',width:'calc(100% - 40px)',maxHeight:Math.max(70,r.height-(compactTop+Math.max(80,r.height*.52)+24)-104)+'px'}:{left:(r.width+w)/2+24+'px',top:top+24+'px',width:'202px',maxHeight:Math.max(100,r.height-top-128)+'px'});
}
function viewerTransform(from,to){return `translate(${from.left-to.left}px,${from.top-to.top}px) scale(${from.width/to.width},${from.height/to.height})`}
function viewerCardRadius(item,viewport){
  const radius=parseFloat(getComputedStyle(item.card).borderTopLeftRadius)||0;
  return `${radius*viewport.width/item.card.offsetWidth}px / ${radius*viewport.height/item.card.offsetHeight}px`;
}
function viewerInterface(away){
  [canvasViewport,dock,$('.canvas-zoom'),$('#close-result')].forEach(el=>el.inert=away);
}
function openGenerationViewer(item){
  if(openedGeneration||item.status!=='complete')return;
  const from=item.card.getBoundingClientRect();
  clearCanvasGesture();hideTooltip(true);
  openedGeneration=item;viewerClosing=false;resetViewerImageZoom();
  const image=$('#viewer-image');image.src=item.image.src;image.alt=`Generation ${item.id}`;
  $('#viewer-request').textContent=item.prompt;
  $('#viewer-image-zoom').querySelectorAll('video,audio,.writing-result').forEach(node=>node.remove());
  image.hidden=item.kind!=='image';
  if(item.kind==='text'){const writing=document.createElement('pre');writing.className='writing-result';writing.textContent=item.text;$('#viewer-image-zoom').append(writing);}
  else if(image.hidden){const media=document.createElement(item.kind==='video'?'video':'audio');media.controls=true;media.src=item.downloadUrl+'?preview=1';media.setAttribute('aria-label','Generated '+item.kind);if(item.kind==='video')media.playsInline=true;$('#viewer-image-zoom').append(media);}

  $('#viewer-resolution').textContent=item.kind==='video'?'Video':item.kind==='audio'?'Audio':item.kind==='text'?'Text document':`${item.image.naturalWidth} × ${item.image.naturalHeight}`;
  const assets=$('#viewer-assets');assets.replaceChildren();
  (item.references||[]).forEach(ref=>{const thumb=document.createElement('img');thumb.src=ref.url;thumb.alt=ref.name;assets.append(thumb)});
  $('#viewer-assets-section').hidden=!item.references?.length;
  $('#viewer-enhance').disabled=running;
  $('#viewer-enhance').hidden=!['image','text'].includes(item.kind);
  viewer.style.setProperty('--viewer-actions-width',$('#viewer-enhance').hidden?'285px':'398px');
  viewer.hidden=false;viewer.classList.remove('is-closing','is-visible');viewerLayout();
  const target=viewerShell.getBoundingClientRect(),center=canvasViewport.getBoundingClientRect();
  generationItems.forEach(other=>{
    if(other===item){other.element.classList.add('viewer-source');return}
    const b=other.element.getBoundingClientRect(),dx=b.left+b.width/2-(center.left+center.width/2),dy=b.top+b.height/2-(center.top+center.height/2),length=Math.hypot(dx,dy)||1,z=mobileLayout.matches?1:canvasView.z;
    other.element.style.setProperty('--viewer-out-x',(dx/length*110/z)+'px');other.element.style.setProperty('--viewer-out-y',(dy/length*110/z)+'px');other.element.classList.add('viewer-other');
  });
  workspace.classList.add('viewer-guest');workspace.classList.add('viewer-open');document.documentElement.classList.add('generation-viewer-open');viewerInterface(true);
  viewerMotion?.cancel();viewerRadiusMotion?.cancel();
  if(!reduceMotion){
    const motionOptions={duration:420,easing:'cubic-bezier(.2,.75,.25,1)'};
    viewerMotion=viewerShell.animate([{transform:viewerTransform(from,target)},{transform:'translate(0,0) scale(1)'}],motionOptions);
    viewerRadiusMotion=$('#viewer-image-zoom').animate([{borderRadius:viewerCardRadius(item,target)},{borderRadius:'16px'}],motionOptions);
  }
  requestAnimationFrame(()=>{if(openedGeneration===item&&!viewerClosing)viewer.classList.add('is-visible')});
  $('#viewer-back').focus({preventScroll:true});
}
async function closeGenerationViewer(immediate=false){
  if(!openedGeneration||viewerClosing&&!immediate)return;
  const item=openedGeneration;viewerClosing=true;
  const current=viewerShell.getBoundingClientRect(),currentRadius=getComputedStyle($('#viewer-image-zoom')).borderRadius;viewerMotion?.cancel();viewerRadiusMotion?.cancel();stopViewerImageGesture();
  const from=viewerShell.getBoundingClientRect(),target=item.card.getBoundingClientRect();
  viewer.classList.add('is-closing');viewer.classList.remove('is-visible');workspace.classList.remove('viewer-open');
  generationItems.forEach(other=>other.element.classList.remove('viewer-other'));
  if(!immediate&&!reduceMotion&&target.width&&target.height){
    viewerImageMotion=$('#viewer-image-zoom').animate([{transform:$('#viewer-image-zoom').style.transform||'none'},{transform:'translate(0px,0px) scale(1)'}],{duration:520,easing:'cubic-bezier(.22,1,.36,1)'});
    viewerMotion=viewerShell.animate([{transform:viewerTransform(current,from)},{transform:viewerTransform(target,from)}],{duration:520,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});
    viewerRadiusMotion=$('#viewer-image-zoom').animate([{borderRadius:currentRadius},{borderRadius:viewerCardRadius(item,from)}],{duration:520,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});
    try{await viewerMotion.finished}catch{}
  }
  if(openedGeneration!==item)return;
  $('#viewer-image-zoom').querySelectorAll('video,audio').forEach(media=>media.pause());
  viewerMotion?.cancel();viewerMotion=null;viewerRadiusMotion?.cancel();viewerRadiusMotion=null;
  resetViewerImageZoom();item.element.classList.remove('viewer-source');viewer.hidden=true;viewer.classList.remove('is-closing');openedGeneration=null;viewerClosing=false;workspace.classList.remove('viewer-guest');
  viewerInterface(false);document.documentElement.classList.remove('generation-viewer-open');
  if(!immediate&&item.element.isConnected)item.card.focus({preventScroll:true});
}
$('#viewer-back').addEventListener('click',()=>closeGenerationViewer());
document.addEventListener('keydown',e=>{if(openedGeneration&&e.key==='Escape'&&!e.target.closest('dialog')){e.preventDefault();e.stopImmediatePropagation();closeGenerationViewer()}},true);
$('#viewer-download').addEventListener('click',()=>{if(openedGeneration)downloadGenerations([openedGeneration]).catch(()=>toast('Could not download the image. Try again.'))});
$('#viewer-share').addEventListener('click',()=>{if(openedGeneration)shareGenerations([openedGeneration])});
$('#viewer-enhance').addEventListener('click',async()=>{const item=openedGeneration;if(!item)return;await closeGenerationViewer();enhanceGenerations([item])});
$('#viewer-delete').addEventListener('click',async()=>{const item=openedGeneration;if(!item)return;await closeGenerationViewer();deleteGenerations([item])});
new ResizeObserver(()=>{if(openedGeneration&&!viewerClosing){viewerLayout();clampViewerImagePan();requestViewerImageZoom(false)}}).observe(workspace);
window.addEventListener('resize',()=>{if(openedGeneration&&!viewerClosing)viewerLayout()});

// Temporary whole-image inspection zoom; the action toolbar stays in its own layer.
const viewerZoom={z:1,x:0,y:0,tz:1,tx:0,ty:0,frame:0,time:null};
const viewerZoomPointers=new Map();
let viewerZoomPinch=null,viewerSafariGesture=null,viewerImageMotion=null,viewerZoomReleaseTimer=0,viewerZoomReturn=null;
function canZoomViewerImage(){return Boolean(openedGeneration?.kind==='image'&&openedGeneration&&!viewerClosing&&viewerMotion?.playState!=='running')}
function clampViewerImagePan(){
  if(viewerZoom.tz===1){viewerZoom.tx=0;viewerZoom.ty=0}
}
function paintViewerImageZoom(){
  $('#viewer-image-zoom').style.transform=`translate(${viewerZoom.x.toFixed(3)}px,${viewerZoom.y.toFixed(3)}px) scale(${viewerZoom.z.toFixed(5)})`;
  viewerShell.classList.toggle('image-zoomed',viewerZoom.tz>1.001);
  viewerShell.setAttribute('aria-label',`Image preview, ${Math.round(viewerZoom.tz*100)} percent. Pinch to zoom, drag to pan. Use plus and minus to zoom, zero to reset.`);
}
function animateViewerImageZoom(now){
  if(viewerZoomReturn){
    const r=viewerZoomReturn;r.time??=now;
    const t=Math.min(1,(now-r.time)/380),ease=1-Math.pow(1-t,3);
    viewerZoom.z=r.z+(1-r.z)*ease;viewerZoom.x=r.x*(1-ease);viewerZoom.y=r.y*(1-ease);
    paintViewerImageZoom();
    if(t<1)viewerZoom.frame=requestAnimationFrame(animateViewerImageZoom);
    else{viewerZoom.z=1;viewerZoom.x=0;viewerZoom.y=0;viewerZoomReturn=null;viewerZoom.frame=0;viewerZoom.time=null;paintViewerImageZoom()}
    return;
  }
  const dt=viewerZoom.time===null?1:Math.min(3,(now-viewerZoom.time)/(1000/60));viewerZoom.time=now;
  const ease=1-Math.pow(.65,dt);
  viewerZoom.z+=(viewerZoom.tz-viewerZoom.z)*ease;viewerZoom.x+=(viewerZoom.tx-viewerZoom.x)*ease;viewerZoom.y+=(viewerZoom.ty-viewerZoom.y)*ease;
  const moving=Math.abs(viewerZoom.tz-viewerZoom.z)>.0001||Math.abs(viewerZoom.tx-viewerZoom.x)+Math.abs(viewerZoom.ty-viewerZoom.y)>.05;
  if(!moving){viewerZoom.z=viewerZoom.tz;viewerZoom.x=viewerZoom.tx;viewerZoom.y=viewerZoom.ty}
  paintViewerImageZoom();
  if(moving)viewerZoom.frame=requestAnimationFrame(animateViewerImageZoom);else{viewerZoom.frame=0;viewerZoom.time=null}
}
function requestViewerImageZoom(smooth=true){
  if(!smooth||reduceMotion){cancelAnimationFrame(viewerZoom.frame);viewerZoom.frame=0;viewerZoom.time=null;viewerZoom.z=viewerZoom.tz;viewerZoom.x=viewerZoom.tx;viewerZoom.y=viewerZoom.ty;paintViewerImageZoom()}
  else if(!viewerZoom.frame)viewerZoom.frame=requestAnimationFrame(animateViewerImageZoom);
}
function setViewerImageZoom(scale,clientX,clientY,smooth=true){
  const r=viewerShell.getBoundingClientRect(),x=(clientX??r.left+r.width/2)-r.left-r.width/2,y=(clientY??r.top+r.height/2)-r.top-r.height/2;
  const next=Math.max(1,Math.min(6,scale)),ratio=next/viewerZoom.tz;
  viewerZoom.tx=x-(x-viewerZoom.tx)*ratio;viewerZoom.ty=y-(y-viewerZoom.ty)*ratio;viewerZoom.tz=next;
  clampViewerImagePan();requestViewerImageZoom(smooth);
}
function beginViewerImageGesture(){
  clearTimeout(viewerZoomReleaseTimer);viewerZoomReleaseTimer=0;
  if(viewerZoomReturn){
    viewerZoomReturn=null;cancelAnimationFrame(viewerZoom.frame);viewerZoom.frame=0;viewerZoom.time=null;
    viewerZoom.tz=viewerZoom.z;viewerZoom.tx=viewerZoom.x;viewerZoom.ty=viewerZoom.y;
  }
}
function releaseViewerImageZoom(){
  clearTimeout(viewerZoomReleaseTimer);viewerZoomReleaseTimer=0;
  if(!openedGeneration||viewerClosing)return;
  cancelAnimationFrame(viewerZoom.frame);viewerZoom.frame=0;viewerZoom.time=null;
  viewerZoomReturn={z:viewerZoom.z,x:viewerZoom.x,y:viewerZoom.y,time:null};
  viewerZoom.tz=1;viewerZoom.tx=0;viewerZoom.ty=0;
  requestViewerImageZoom();
  if(reduceMotion)viewerZoomReturn=null;
}
function scheduleViewerImageRelease(){
  clearTimeout(viewerZoomReleaseTimer);
  viewerZoomReleaseTimer=setTimeout(releaseViewerImageZoom,140);
}
function stopViewerImageGesture(){
  clearTimeout(viewerZoomReleaseTimer);viewerZoomReleaseTimer=0;viewerZoomReturn=null;
  cancelAnimationFrame(viewerZoom.frame);viewerZoom.frame=0;viewerZoom.time=null;
  for(const id of viewerZoomPointers.keys())if(viewerShell.hasPointerCapture(id))viewerShell.releasePointerCapture(id);
  viewerZoomPointers.clear();viewerZoomPinch=null;viewerSafariGesture=null;viewerShell.classList.remove('image-panning');
}
function resetViewerImageZoom(){
  stopViewerImageGesture();viewerImageMotion?.cancel();viewerImageMotion=null;
  Object.assign(viewerZoom,{z:1,x:0,y:0,tz:1,tx:0,ty:0});paintViewerImageZoom();
}
function viewerImagePinch(){
  const [a,b]=[...viewerZoomPointers.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
}
viewerShell.addEventListener('wheel',e=>{
  if(!canZoomViewerImage())return;
  if(e.ctrlKey||e.metaKey){e.preventDefault();if(!viewerSafariGesture){beginViewerImageGesture();setViewerImageZoom(viewerZoom.tz*Math.exp(-e.deltaY*(e.deltaMode===1?.04:.01)),e.clientX,e.clientY);scheduleViewerImageRelease()}}
  else if(viewerZoom.tz>1){e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?viewerShell.clientHeight:1;viewerZoom.tx-=e.deltaX*unit;viewerZoom.ty-=e.deltaY*unit;clampViewerImagePan();requestViewerImageZoom();scheduleViewerImageRelease()}
},{passive:false});
viewerShell.addEventListener('pointerdown',e=>{
  if(!canZoomViewerImage()||e.button!==0)return;
  e.preventDefault();beginViewerImageGesture();viewerZoomPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});viewerShell.setPointerCapture(e.pointerId);
  if(viewerZoomPointers.size>=2){viewerSafariGesture=null;viewerZoomPinch=viewerImagePinch()}
  if(viewerZoom.tz>1)viewerShell.classList.add('image-panning');
});
viewerShell.addEventListener('pointermove',e=>{
  const previous=viewerZoomPointers.get(e.pointerId);if(!previous||viewerClosing)return;
  viewerZoomPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(viewerZoomPointers.size>=2){
    const next=viewerImagePinch();
    if(viewerZoomPinch){setViewerImageZoom(viewerZoom.tz*next.d/viewerZoomPinch.d,viewerZoomPinch.x,viewerZoomPinch.y,false);viewerZoom.tx+=next.x-viewerZoomPinch.x;viewerZoom.ty+=next.y-viewerZoomPinch.y;clampViewerImagePan();requestViewerImageZoom(false)}
    viewerZoomPinch=next;
  }else if(viewerZoom.tz>1){viewerZoom.tx+=e.clientX-previous.x;viewerZoom.ty+=e.clientY-previous.y;clampViewerImagePan();requestViewerImageZoom(false)}
});
function endViewerImagePointer(e){
  if(!viewerZoomPointers.has(e.pointerId))return;
  viewerZoomPointers.delete(e.pointerId);viewerZoomPinch=viewerZoomPointers.size>=2?viewerImagePinch():null;
  if(viewerShell.hasPointerCapture(e.pointerId))viewerShell.releasePointerCapture(e.pointerId);
  if(!viewerZoomPointers.size){viewerShell.classList.remove('image-panning');releaseViewerImageZoom()}
}
['pointerup','pointercancel','lostpointercapture'].forEach(name=>viewerShell.addEventListener(name,endViewerImagePointer));
// Safari exposes trackpad pinches as GestureEvents instead of Ctrl+wheel.
viewerShell.addEventListener('gesturestart',e=>{if(!canZoomViewerImage())return;e.preventDefault();if(viewerZoomPointers.size>=2)return;beginViewerImageGesture();viewerSafariGesture={scale:viewerZoom.tz}} ,{passive:false});
viewerShell.addEventListener('gesturechange',e=>{if(!viewerSafariGesture||!canZoomViewerImage())return;e.preventDefault();setViewerImageZoom(viewerSafariGesture.scale*e.scale,e.clientX,e.clientY)},{passive:false});
viewerShell.addEventListener('gestureend',e=>{if(viewerSafariGesture){e.preventDefault();viewerSafariGesture=null;releaseViewerImageZoom()}},{passive:false});
viewerShell.addEventListener('dblclick',e=>{if(!canZoomViewerImage())return;e.preventDefault();beginViewerImageGesture();setViewerImageZoom(viewerZoom.tz>1?1:2,e.clientX,e.clientY)});
viewerShell.addEventListener('dragstart',e=>e.preventDefault());
viewerShell.addEventListener('keydown',e=>{
  if(!canZoomViewerImage())return;
  if(['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();beginViewerImageGesture()}
  if(e.key==='+'||e.key==='=')setViewerImageZoom(viewerZoom.tz*1.25);
  else if(e.key==='-')setViewerImageZoom(viewerZoom.tz/1.25);
  else if(e.key==='0')setViewerImageZoom(1);
  else if(viewerZoom.tz>1&&e.key.startsWith('Arrow')){viewerZoom.tx+=e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0;viewerZoom.ty+=e.key==='ArrowUp'?40:e.key==='ArrowDown'?-40:0;clampViewerImagePan();requestViewerImageZoom()}
});
window.addEventListener('blur',()=>{stopViewerImageGesture();releaseViewerImageZoom()});

const pricingPage=$('#pricing-page');
function openPricing(){window.open('https://magichour.ai/pricing','_blank','noopener')}
$$('[data-pricing-trigger]').forEach(button=>button.addEventListener('click',openPricing));
// The library is another view of the same in-memory workspace.
const templatesPage=$('#templates-page'),templatesGrid=$('#templates-grid');
const templateLibrary=[
  {id:'1f36c',name:'Golden forms',category:'image',kind:'Photo edit',prompt:'Create an architectural photograph of sculptural golden forms, with warm light, repeating curves and a clean editorial composition.'},
  {id:'ccba0',name:'Slow mornings',category:'image',kind:'Photo edit',prompt:'Create a cosy editorial image of soft linen bedding in muted green tones, with natural morning light and delicate embroidered lettering.'},
  {id:'a2914',name:'Coastal escape',category:'video',kind:'Animate image',prompt:'Create a cinematic video of a white coastal town above turquoise water. Add a gentle camera drift, subtle waves and warm summer light.'},
  {id:'81b53',name:'Summer by the sea',category:'video',kind:'Animate image',prompt:'Create a peaceful seaside video with a beach umbrella, swimmers and warm evening light. Keep the camera movement slow and natural.'},
  {id:'74f1a',name:'Magazine moment',category:'image',kind:'Photo edit',prompt:'Create a lifestyle photograph of someone reading a beautifully designed magazine, with soft daylight and a calm editorial feel.'},
  {id:'ee5e1',name:'Cosy soundtrack',category:'audio',kind:'Song',prompt:'Create a mellow acoustic instrumental for a slow morning at home, with warm guitar, soft piano and a relaxed, comforting rhythm.'},
  {id:'b1c81',name:'Room refresh',category:'image',kind:'Photo edit',prompt:'Refresh this room with playful art, warm natural materials and a soft colour palette. Preserve the layout and make the lighting feel natural.'},
  {id:'28c45',name:'Under the stars',category:'audio',kind:'Song',prompt:'Create an ambient soundtrack for stargazing, with spacious soft synths, delicate textures and a peaceful sense of wonder.'},
  {id:'88089',name:'Golden hour',category:'video',kind:'Animate image',prompt:'Create a sunlit cinematic travel video with warm golden-hour light, gentle foliage movement and an unhurried camera drift.'},
  {id:'251ac',name:'Tropical breeze',category:'audio',kind:'Song',prompt:'Create a laid-back tropical instrumental with soft percussion, gentle guitar and a warm, breezy summer atmosphere.'},
  {id:'4899e',name:'City stories',category:'video',kind:'Animate image',prompt:'Create a cinematic city scene with subtle natural movement, soft daylight and a slow camera push-in. Keep the architecture consistent.'},
  {id:'5c274',name:'A little getaway',category:'audio',kind:'Voiceover',prompt:'Create a warm, inviting travel voiceover: Take a moment. Find a new view. Sometimes a little getaway is all you need.'}
];
let templatesOpen=false,templateCategory='popular',templatesSnapshot=null,templateMagnetFrame=0,templateMagnetTime=null;
const templateEntryMotions=[];
const libraryMotion=[];
function animateLibraryEntry(nodes){
  if(reduceMotion)return;
  nodes.forEach((node,index)=>{
    const motion=node.animate([{opacity:0,translate:'0 18px',scale:'.985'},{opacity:1,translate:'0 0',scale:'1'}],{duration:460,delay:Math.min(index,7)*30,easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'});
    templateEntryMotions.push(motion);
  });
}
function requestLibraryMagnet(){if(!templateMagnetFrame&&!reduceMotion)templateMagnetFrame=requestAnimationFrame(animateLibraryMagnet)}
function animateLibraryMagnet(now){
  const dt=templateMagnetTime===null?1:Math.min(3,(now-templateMagnetTime)/(1000/60)),ease=1-Math.pow(1-.11,dt);templateMagnetTime=now;
  let moving=false;
  libraryMotion.forEach(state=>{
    state.x+=(state.tx-state.x)*ease;state.y+=(state.ty-state.y)*ease;
    state.card.style.setProperty('--magnet-x',state.x.toFixed(3)+'px');state.card.style.setProperty('--magnet-y',state.y.toFixed(3)+'px');
    moving ||= Math.abs(state.x-state.tx)+Math.abs(state.y-state.ty)>.015;
  });
  if(moving)templateMagnetFrame=requestAnimationFrame(animateLibraryMagnet);else{templateMagnetFrame=0;templateMagnetTime=null}
}
function resetLibraryMagnet(){libraryMotion.forEach(state=>{state.tx=state.ty=0});requestLibraryMagnet()}
templateLibrary.forEach(item=>{
  const card=document.createElement('button');card.type='button';card.className='catalog-card';card.dataset.category=item.category;card.setAttribute('aria-label',`Use ${item.name} template`);
  const surface=document.createElement('span');surface.className='card-surface';
  const image=document.createElement('img');image.className='card-image';image.src=`assets/template-${item.id}.jpg`;image.alt='';image.loading='lazy';image.decoding='async';
  const shade=document.createElement('span');shade.className='shade';shade.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.className='card-label';label.textContent=item.name;
  surface.append(image,shade,label);const arrow=$('.float-card .card-action').cloneNode(true);surface.append(arrow);card.append(surface);templatesGrid.append(card);
  const state={card,x:0,y:0,tx:0,ty:0};libraryMotion.push(state);
  card.addEventListener('pointermove',e=>{
    if(e.pointerType==='touch'||mobileLayout.matches||reduceMotion)return;
    const r=card.getBoundingClientRect();state.tx=Math.max(-1,Math.min(1,(e.clientX-r.left-r.width/2)/(r.width/2)))*15;state.ty=Math.max(-1,Math.min(1,(e.clientY-r.top-r.height/2)/(r.height/2)))*12;requestLibraryMagnet();
  });
  card.addEventListener('pointerleave',()=>{state.tx=state.ty=0;requestLibraryMagnet()});
  card.addEventListener('click',()=>{
    if(running){toast('Your generation is still in progress. Choose a template when it finishes.');return}
    closeTemplates();goHome();applyTemplate(item.kind,item.prompt,`assets/template-${item.id}.jpg`);
  });
});
function setTemplateCategory(category){
  if(!['popular','video','image','audio'].includes(category)||category===templateCategory)return;
  templateCategory=category;templateEntryMotions.splice(0).forEach(motion=>motion.cancel());resetLibraryMagnet();
  $$('[data-template-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.templateFilter===category)));
  const visible=[];libraryMotion.forEach(({card})=>{card.hidden=category!=='popular'&&card.dataset.category!==category;if(!card.hidden)visible.push(card)});
  animateLibraryEntry(visible);
}
function openTemplates(){
  if(templatesOpen)return;
  hideTooltip(true);clearCanvasGesture();closeGenerationViewer(true);resetCardMotion();
  if(mobileLayout.matches)setSidebar(false,{focus:false});
  const keep=new Set([templatesPage,$('.top-actions'),$('.mobile-header'),$('#toast'),pricingPage]);
  templatesSnapshot={title:document.title,scrollY:window.scrollY,children:[...workspace.children].filter(node=>!keep.has(node)).map(node=>[node,node.inert])};
  templatesSnapshot.children.forEach(([node])=>node.inert=true);
  templatesOpen=true;templatesPage.hidden=false;document.body.classList.add('templates-open');document.title='Templates — Create.here';
  $('[data-templates-trigger]').setAttribute('aria-current','page');syncSessionFolder();templatesPage.scrollTop=0;
  if(mobileLayout.matches)window.scrollTo({top:0,behavior:'instant'});
  animateLibraryEntry([$('.templates-heading'),$('.templates-filters'),...libraryMotion.filter(({card})=>!card.hidden).map(({card})=>card)]);
  (mobileLayout.matches?$('[data-template-filter="'+templateCategory+'"]'):$('#templates-title')).focus({preventScroll:true});
}
function closeTemplates(){
  if(!templatesOpen)return;
  templateEntryMotions.splice(0).forEach(motion=>motion.cancel());resetLibraryMagnet();
  templatesOpen=false;templatesPage.hidden=true;document.body.classList.remove('templates-open');$('[data-templates-trigger]').removeAttribute('aria-current');
  templatesSnapshot.children.forEach(([node,inert])=>node.inert=inert);document.title=templatesSnapshot.title;
  window.scrollTo({top:templatesSnapshot.scrollY,behavior:'instant'});templatesSnapshot=null;syncSessionFolder();
}
$('[data-templates-trigger]').addEventListener('click',openTemplates);
$$('[data-template-filter]').forEach(button=>button.addEventListener('click',()=>setTemplateCategory(button.dataset.templateFilter)));
window.addEventListener('blur',resetLibraryMagnet);templatesPage.addEventListener('scroll',resetLibraryMagnet,{passive:true});mobileLayout.addEventListener('change',resetLibraryMagnet);

// Keep the home previews playing only while their cards are visible.
const homePreviewVideos=$$('.template-video'),homePreviewVisible=new Map(),homePreviewMotion=matchMedia('(prefers-reduced-motion:reduce)');
function syncHomePreviewVideos(){
  const hidden=document.hidden||homePreviewMotion.matches||workspace.classList.contains('generating')||workspace.classList.contains('has-result')||document.body.classList.contains('templates-open')||document.body.classList.contains('pricing-open');
  homePreviewVideos.forEach(video=>{if(hidden||!homePreviewVisible.get(video))video.pause();else video.play().catch(()=>{})});
}
const homePreviewObserver=new IntersectionObserver(entries=>{entries.forEach(entry=>homePreviewVisible.set(entry.target,entry.isIntersecting));syncHomePreviewVideos()});
homePreviewVideos.forEach(video=>homePreviewObserver.observe(video));
new MutationObserver(syncHomePreviewVideos).observe(workspace,{attributes:true,attributeFilter:['class']});
new MutationObserver(syncHomePreviewVideos).observe(document.body,{attributes:true,attributeFilter:['class']});
document.addEventListener('visibilitychange',syncHomePreviewVideos);homePreviewMotion.addEventListener('change',syncHomePreviewVideos);

let sessionState=null,pendingPlan=null,referenceJobIds=[],clarificationPrompt='',historyPages=1,sessionRequest=0;
const requestMessage=$('#request-message'),planDialog=$('#plan-dialog');
function showRequestMessage(text,retry=false){requestMessage.textContent=text;$('#processing-info').hidden=!text;dock.classList.toggle('has-status',!!text);$('#request-retry').hidden=!retry;$('#request-open').hidden=true;$('#request-credits').hidden=true;updatePrompt()}
$('#request-open').addEventListener('click',()=>{
  const item=generationItems.filter(item=>item.status==='complete').sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  if(!item){showRequestMessage('');return}
  $('#session-button').click();
  if(expandedStack)closeStackFocus();
  revealGeneration(item,false);openGenerationViewer(item);
});
$$('[data-new-creation]').forEach(button=>button.addEventListener('click',()=>{
  if(running||planning){toast('Wait for your current request to finish.');return}
  goHome();
  templateSelectionRevision++;templateAttachmentLoading=false;promptRevealAnimation?.cancel();
  attachments.forEach(item=>{if(item.url)URL.revokeObjectURL(item.url)});attachments=[];
  referenceJobIds=[];clarificationPrompt='';pendingPlan=null;
  $('#reference-summary').hidden=true;
  promptInput.value='';promptInput.placeholder='Describe what you want to create or change…';
  renderFiles();showRequestMessage('');promptInput.focus({preventScroll:true});
}));
async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).catch(()=>{throw new Error('Could not connect. Check your connection.')});
  const data=await response.json();
  if(!response.ok){const error=new Error(typeof data.error==='string'?data.error:data.error?.message||'Your request could not be completed. Please try again.');error.status=response.status;throw error;}
  return data;
}
function showTrial(){
  const remaining=sessionState?.trial?.remaining??1;
  const account=sessionState?.account,connected=Boolean(account?.connected);
  $('#trial-status').textContent=connected?(account.credits===null?'Magic Hour connected. Credit balance is temporarily unavailable.':`${account.credits.toLocaleString()} Magic Hour credits. Keep creating here.`):remaining?'Your first creation is included. No sign-up needed.':'Your included creation is used. Sign in to keep creating here.';
  $('#auth-title').textContent=connected?'Magic Hour connected':'Create your free account';
  $('#auth-description').textContent=connected?'Your creations are saved to this Magic Hour account. Sign in on another browser or device to find them here. New media uses your Magic Hour credits. Writing is included.':'Create a free Magic Hour account to keep creating here and save your creations across devices.';
  $('#save-description').textContent=connected?'Saved to your account.':'Creations stay in this browser.';
  $('#save-signin').textContent=connected?'View account':'Sign in to save across devices';$('#account-credits').hidden=!connected;
  $('#account-summary').hidden=!connected;$('#account-summary').textContent=connected?(account.email||'Your Magic Hour account'):'';
  $$('[data-auth-provider],#auth-terms').forEach(element=>element.hidden=connected);$('#auth-switch').hidden=!connected;$('#auth-disconnect').hidden=!connected;
  $$('.top-actions [data-auth-trigger],.mobile-signup').forEach(button=>button.hidden=connected);
  const trigger=$('.bottom-nav [data-auth-trigger]');trigger.querySelector('.nav-label').textContent=connected?'My account':'Sign Up / Log In';trigger.setAttribute('aria-label',connected?'My account':'Sign Up / Log In');trigger.dataset.tip=connected?'My account':'Sign Up / Log In';
  syncPlanBalance();
}
function syncPlanBalance(){
  const account=sessionState?.account,credits=account?.credits;
  $('#plan-balance').hidden=!account?.connected;
  $('#plan-balance').textContent=Number.isFinite(credits)?`${credits.toLocaleString()} credits available${account.email?` for ${account.email}`:''}.${credits<(pendingPlan?.estimatedCredits||0)?' Your balance is below the estimate.':''}`:'Credit balance is temporarily unavailable.';
  $('#plan-credit-help').textContent=`Buy credits on Magic Hour${account?.email?` using ${account.email}`:''}, then return here. Your request stays here.`;
  $('#plan-credits').hidden=!account?.connected||pendingPlan?.kind==='text';
}
$('#plan-refresh').addEventListener('click',async()=>{const button=$('#plan-refresh');button.disabled=true;await loadSession(true);button.disabled=false});
$('#history-more').addEventListener('click',async()=>{historyPages++;$('#history-more').disabled=true;await loadSession(true);$('#history-more').disabled=false});
$('#auth-disconnect').addEventListener('click',async()=>{try{await api('/api/auth/logout',{});location.reload()}catch(error){toast(error.message)}});
window.addEventListener('focus',()=>{if(sessionState?.configured)loadSession()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&sessionState?.configured)loadSession()});
async function uploadAttachment(item){
  if(item.assetId)return item.assetId;
  const file=item.file;
  if(file.type.startsWith('image/')||/\.(pdf|doc|docx|ppt|pptx|txt)$/i.test(file.name)){
    if(file.size>3000000)throw new Error('Images and documents must be under 3 MB.');
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file)});
    const result=await api('/api/documents',{name:file.name,mimeType:file.type,data});item.assetId=result.assetId;
  }else{
    const result=await api('/api/uploads',{name:file.name,type:file.type,size:file.size});
    const response=await fetch(result.uploadUrl,{method:'PUT',headers:{'Content-Type':file.type},body:file});
    if(!response.ok)throw new Error(`Could not upload ${file.name}. Please try again.`);
    item.assetId=result.assetId;
  }
  return item.assetId;
}
async function prepareCreation(event){
  event.preventDefault();
  if(running||planning||templateAttachmentLoading)return;
  const entered=promptInput.value.trim();if(!entered&&!attachments.length&&!referenceJobIds.length)return;
  planning=true;generate.disabled=true;setGenerationLocked(true);
  showRequestMessage(attachments.some(item=>!item.assetId)?'Preparing your references...':'Understanding your request…');
  try{
    const assetIds=[];for(const item of attachments)assetIds.push(await uploadAttachment(item));
    showRequestMessage('Understanding your request…');
    const prompt=clarificationPrompt?`${clarificationPrompt}\nAdditional information: ${entered}`:entered;
    const response=await api('/api/plan',{prompt,assetIds,selectedJobIds:referenceJobIds});
    if(response.question||response.clarification){
      clarificationPrompt=prompt;showRequestMessage(response.question||response.clarification?.question||response.clarification);promptInput.value='';promptInput.focus();return;
    }
    pendingPlan=response.plan;
    if(!pendingPlan?.id)throw new Error('We could not prepare that request. Please try a simpler description.');
    $('#plan-summary').textContent=pendingPlan.summary;
    $('#plan-cost').textContent=pendingPlan.costLabel||'1 included trial creation';
    syncPlanBalance();
    $('#plan-remaining').textContent=sessionState?.account?.connected?'Nothing is generated until you confirm. Media charges use your connected Magic Hour account; writing uses the app’s OpenAI service.':'Nothing is generated until you confirm. Failed creations do not use your trial.';
    showRequestMessage('');planDialog.showModal();$('#plan-confirm').focus();
  }catch(error){showRequestMessage(`${error.message} Your prompt and files are still here.`,![401,402,403,409].includes(error.status));if(error.status===401){await loadSession()}if([401,402,403].includes(error.status))openAuth(generate)}
  finally{planning=false;setGenerationLocked(false);updatePrompt()}
}
$('#plan-close').addEventListener('click',()=>planDialog.close());
$('#plan-change').addEventListener('click',()=>{planDialog.close();promptInput.focus()});
$('#reference-summary').addEventListener('click',()=>{referenceJobIds=[];$('#reference-summary').hidden=true;promptInput.placeholder='Describe what you want to create or change…'});
$('#plan-confirm').addEventListener('click',async()=>{
  if(running||planning||!pendingPlan)return;
  planning=true;$('#plan-confirm').disabled=true;setGenerationLocked(true);
  try{
    const response=await api('/api/generate',{planId:pendingPlan.id});
    if(clarificationPrompt)promptInput.value=response.job.prompt;
    pendingPlan=null;planDialog.close();clarificationPrompt='';
    await displayJob(response.job,true);
    await loadSession(true);
  }catch(error){planDialog.close();showRequestMessage(error.message);if(error.status===401){await loadSession();openAuth(generate)}}
  finally{planning=false;$('#plan-confirm').disabled=false;if(!running){setGenerationLocked(false);updatePrompt()}}
});
async function displayJob(job,submitted=false){
  if(generationItems.some(item=>item.jobId===job.id))return;
  const first=generationItems.length===0;
  running=true;showingHome=false;
  const request=++generationRequest,item=await makeGeneration(request,job.kind);if(!item){running=false;return;}
  item.jobId=job.id;item.createdAt=job.createdAt;item.prompt=job.prompt||promptInput.value;item.submitted=submitted;
  $('#workspace-name').textContent='Your creations';syncSessionFolder();
  applyJob(item,job);requestAnimationFrame(()=>revealGeneration(item,first));
  if(!['complete','error','canceled','submission_unknown'].includes(job.status)){
    workspace.classList.add('generating');dock.classList.add('processing');setGenerationLocked(true);
    if(!currentGeneration){currentGeneration=item;pollJob(item)}
  }else{running=Boolean(currentGeneration);refreshGenerationView()}
}
function applyJob(item,job){
  item.kind=job.kind;item.status=job.status==='complete'?'complete':['error','canceled','submission_unknown'].includes(job.status)?'error':'pending';
  item.progress.textContent=job.status==='queued'?'Queued':job.status==='complete'?'Ready':item.status==='error'?'Could not create':'Creating…';
  if(item.status==='pending')showRequestMessage(job.status==='queued'?'Your creation is queued…':'Bringing your idea to life…');
  if(item.status==='complete'){
    if(item.submitted){
      attachments.forEach(source=>{if(source.url)URL.revokeObjectURL(source.url)});attachments=[];referenceJobIds=[];renderFiles();$('#reference-summary').hidden=true;item.submitted=false;
    }
    item.downloadUrl=`/api/download/${encodeURIComponent(job.id)}/0`;item.text=job.text||'';
    item.progress.hidden=true;item.element.classList.add('is-complete');resetLiveCard(item);
    if(job.kind==='image'){
      item.image.onload=()=>{const size=normalizedCardSize(item.image.naturalWidth,item.image.naturalHeight);size.width*=1.5;size.height*=1.5;Object.assign(item,size);item.element.style.width=size.width+'px';item.element.style.height=size.height+'px';item.element.style.setProperty('--item-aspect',String(item.image.naturalWidth/item.image.naturalHeight));layoutGenerationItems();if(!mobileLayout.matches)revealGeneration(item,generationItems.length===1);paintCanvas()};
      item.image.src=item.downloadUrl+'?preview=1';
    }else if(job.kind==='video'){
      item.image.hidden=true;const video=document.createElement('video');video.src=item.downloadUrl+'?preview=1';video.muted=true;video.loop=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label','Generated video');item.card.prepend(video);video.play().catch(()=>{});
    }else if(job.kind==='text'){item.image.hidden=true;const text=document.createElement('p');text.className='writing-preview';text.textContent=job.text;item.card.prepend(text);}
    else{item.image.src='assets/b1ae1.png';item.progress.hidden=false;item.progress.textContent='Music · Play';}
    item.card.setAttribute('aria-label',`Open generated ${job.kind}`);
    showRequestMessage('Your creation is ready.');$('#request-open').hidden=false;
  }else if(item.status==='error'){
    item.progress.textContent=['submitting','submission_unknown'].includes(job.status)?'Needs attention':'Could not create';item.element.classList.add('generation-failed');
    const retry=item.submitted&&['error','canceled'].includes(job.status);
    const message=typeof job.error==='string'?job.error:job.error?.message||'This creation failed. Your trial is still available.';
    showRequestMessage(message+(retry?' Your prompt and files are still here. Try again or change your request.':''),retry);
    $('#request-credits').hidden=job.errorCode!=='insufficient_credits';
  }
  refreshGenerationView();syncGenerationCardActions();
}
async function pollJob(item){
  try{
    const {job}=await api(`/api/jobs/${encodeURIComponent(item.jobId)}`);applyJob(item,job);
  }catch(error){
    if(error.status===404){
      if(openedGeneration===item)await closeGenerationViewer(true);
      disposeGeneration(item);item.element.remove();const index=generationItems.indexOf(item);if(index!==-1)generationItems.splice(index,1);selectedGenerations.delete(item);
      layoutGenerationItems();refreshStacks();refreshGenerationView();showRequestMessage('This creation is no longer available in this workspace.');
    }else if(error.status===401){await loadSession(true);openAuth(generate)}
    else showRequestMessage('We lost the connection. Your creation may still be running. We’ll check again.');
  }
  const pending=generationItems.filter(other=>other.status==='pending');
  if(!pending.length){stopGeneration();await loadSession(true);return}
  currentGeneration=pending[(pending.indexOf(item)+1)%pending.length];
  if(currentGeneration)timer=setTimeout(()=>pollJob(currentGeneration),5000);
}
async function loadSession(creationRefresh=false){
  const request=++sessionRequest;
  try{
    const previousAccountId=sessionState?.account?.id;
    const latest=await api('/api/session');if(request!==sessionRequest)return;
    sessionState=latest;
    if(previousAccountId&&previousAccountId!==sessionState.account?.id){location.reload();return}
    if(sessionState.configured)showTrial();
    if(!previousAccountId&&sessionState.account?.connected&&authDialog.open){await closeAuth();showRequestMessage('Signed in. Your creations are saved to your account.')}
    let jobs=[...(sessionState.jobs||[])],hasMore=sessionState.hasMore;
    for(let page=1;page<historyPages&&hasMore;page++){const next=await api(`/api/session?offset=${page*50}`);if(request!==sessionRequest)return;if(next.account?.id!==sessionState.account?.id){location.reload();return}jobs.push(...next.jobs);hasMore=next.hasMore}
    $('#history-more').hidden=!hasMore;
    for(const item of [...generationItems])if(item.jobId&&item.status!=='pending'&&!jobs.some(job=>job.id===item.jobId)){if(openedGeneration===item)await closeGenerationViewer(true);disposeGeneration(item);item.element.remove();generationItems.splice(generationItems.indexOf(item),1);selectedGenerations.delete(item)}
    refreshGenerationView();
    jobs.sort((a,b)=>Number(!['complete','error','canceled','submission_unknown'].includes(a.status))-Number(!['complete','error','canceled','submission_unknown'].includes(b.status)));
    for(const job of jobs){if(request!==sessionRequest)return;await displayJob(job)}
    if(sessionState.configured===false)showRequestMessage('Create.here is getting ready. Generation will be available soon.');
  }catch(error){if(creationRefresh)toast('Could not refresh your account status. Your creation status is unchanged.');else showRequestMessage('Create.here is getting ready. Generation will be available soon.');}
}
loadSession();
