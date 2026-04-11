import { useState, useRef, useEffect, useCallback } from "react";

/* ─── FFT (in-place radix-2) ─────────────────────────────── */
function fft(re, im, inv) {
  const n = re.length;
  for (let i=1,j=0;i<n;i++){
    let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;
    if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
  }
  for(let len=2;len<=n;len<<=1){
    const ang=(inv?1:-1)*2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let ur=1,ui=0;
      for(let j=0;j<len>>1;j++){
        const ar=re[i+j],ai=im[i+j];
        const br=re[i+j+(len>>1)]*ur-im[i+j+(len>>1)]*ui;
        const bi=re[i+j+(len>>1)]*ui+im[i+j+(len>>1)]*ur;
        re[i+j]=ar+br; im[i+j]=ai+bi;
        re[i+j+(len>>1)]=ar-br; im[i+j+(len>>1)]=ai-bi;
        [ur,ui]=[ur*wr-ui*wi, ur*wi+ui*wr];
      }
    }
  }
  if(inv) for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}

/* ─── Phase Vocoder — chunked async ──────────────────────── */
const yld = () => new Promise(r => setTimeout(r, 0));
async function pvStretchAsync(audioBuffer, stretch, onProg) {
  const FFT=1024, HOP_A=256, HOP_S=Math.max(1,Math.round(HOP_A*stretch));
  const TP=2*Math.PI, HALF=FFT>>1, CHUNK=64;
  const numCh=audioBuffer.numberOfChannels, inLen=audioBuffer.length;
  const outLen=Math.max(1,Math.round(inLen*stretch));
  const win=new Float32Array(FFT);
  for(let i=0;i<FFT;i++) win[i]=0.5*(1-Math.cos(TP*i/(FFT-1)));
  const result=[];
  for(let ch=0;ch<numCh;ch++){
    const input=audioBuffer.getChannelData(ch);
    const out=new Float32Array(outLen+FFT), wn=new Float32Array(outLen+FFT);
    const lp=new Float32Array(FFT), sp=new Float32Array(FFT);
    let inPos=0, outPos=0, hop=0;
    while(inPos<inLen+FFT){
      const re=new Float32Array(FFT), im=new Float32Array(FFT);
      for(let i=0;i<FFT;i++){const s=inPos-HALF+i; re[i]=(s>=0&&s<inLen)?input[s]*win[i]:0;}
      fft(re,im,false);
      const or=new Float32Array(FFT), oi=new Float32Array(FFT);
      for(let k=0;k<=HALF;k++){
        const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k]), ph=Math.atan2(im[k],re[k]);
        let dp=ph-lp[k]-TP*k*HOP_A/FFT; dp-=TP*Math.round(dp/TP);
        sp[k]+=HOP_S*(TP*k/FFT+dp/HOP_A); lp[k]=ph;
        or[k]=mag*Math.cos(sp[k]); oi[k]=mag*Math.sin(sp[k]);
        if(k>0&&k<HALF){or[FFT-k]=or[k]; oi[FFT-k]=-oi[k];}
      }
      fft(or,oi,true);
      for(let i=0;i<FFT;i++){
        const op=outPos-HALF+i;
        if(op>=0&&op<out.length){out[op]+=or[i]*win[i]; wn[op]+=win[i]*win[i];}
      }
      inPos+=HOP_A; outPos+=HOP_S; hop++;
      if(outPos>outLen+HALF) break;
      if(hop%CHUNK===0){ onProg&&onProg(Math.min(0.9,inPos/inLen)); await yld(); }
    }
    for(let i=0;i<outLen;i++) if(wn[i]>1e-8) out[i]/=wn[i];
    result.push(out.slice(0,outLen));
  }
  return result;
}

/* ─── IndexedDB persistence ──────────────────────────────── */
const DB_NAME='worship-setlist', DB_STORE='songs', DB_CACHE='buffers', DB_VER=2;
const openDB=()=>new Promise((res,rej)=>{
  const req=indexedDB.open(DB_NAME,DB_VER);
  req.onupgradeneeded=e=>{
    const db=e.target.result;
    if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE,{keyPath:'id'});
    if(!db.objectStoreNames.contains(DB_CACHE)) db.createObjectStore(DB_CACHE,{keyPath:'key'});
  };
  req.onsuccess=e=>res(e.target.result);
  req.onerror=e=>rej(e.target.error);
});
const dbGetAll=async()=>{
  const db=await openDB();
  return new Promise((res,rej)=>{
    const req=db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
    req.onsuccess=e=>res(e.target.result); req.onerror=e=>rej(e.target.error);
  });
};
const dbPut=async(record)=>{
  const db=await openDB();
  return new Promise((res,rej)=>{
    const req=db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE).put(record);
    req.onsuccess=()=>res(); req.onerror=e=>rej(e.target.error);
  });
};
const dbDelete=async(id)=>{
  const db=await openDB();
  return new Promise((res,rej)=>{
    const req=db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE).delete(id);
    req.onsuccess=()=>res(); req.onerror=e=>rej(e.target.error);
  });
};
const dbGetCache=async(key)=>{
  const db=await openDB();
  return new Promise((res,rej)=>{
    const req=db.transaction(DB_CACHE).objectStore(DB_CACHE).get(key);
    req.onsuccess=e=>res(e.target.result||null); req.onerror=e=>rej(e.target.error);
  });
};
const dbPutCache=async(key,arrayBuffer)=>{
  const db=await openDB();
  return new Promise((res,rej)=>{
    const req=db.transaction(DB_CACHE,'readwrite').objectStore(DB_CACHE).put({key,arrayBuffer});
    req.onsuccess=()=>res(); req.onerror=e=>rej(e.target.error);
  });
};
const dbDeleteCache=async(songId)=>{
  const db=await openDB();
  const store=db.transaction(DB_CACHE,'readwrite').objectStore(DB_CACHE);
  return new Promise((res,rej)=>{
    const req=store.getAllKeys();
    req.onsuccess=e=>{ e.target.result.filter(k=>k.startsWith(songId+'-')).forEach(k=>store.delete(k)); res(); };
    req.onerror=e=>rej(e.target.error);
  });
};

/* ─── MP3 export via lamejs (loaded dynamically) ─────────── */
const loadLame=()=>new Promise(resolve=>{
  if(window.lamejs){ resolve(window.lamejs); return; }
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  s.onload=()=>resolve(window.lamejs);
  document.head.appendChild(s);
});

const exportMp3=async(audioBuffer, filename)=>{
  const lamejs=await loadLame();
  const numCh=audioBuffer.numberOfChannels;
  const sr=audioBuffer.sampleRate;
  const left=audioBuffer.getChannelData(0);
  const right=numCh>1?audioBuffer.getChannelData(1):left;

  const mp3enc=new lamejs.Mp3Encoder(numCh,sr,128);
  const CHUNK=1152;
  const mp3Data=[];

  const toInt16=f=>{ const v=Math.max(-1,Math.min(1,f)); return v<0?v*0x8000:v*0x7FFF; };

  for(let i=0;i<left.length;i+=CHUNK){
    const lChunk=new Int16Array(Math.min(CHUNK,left.length-i));
    const rChunk=new Int16Array(Math.min(CHUNK,right.length-i));
    for(let j=0;j<lChunk.length;j++){
      lChunk[j]=toInt16(left[i+j]);
      rChunk[j]=toInt16(right[i+j]);
    }
    const encoded=numCh>1?mp3enc.encodeBuffer(lChunk,rChunk):mp3enc.encodeBuffer(lChunk);
    if(encoded.length>0) mp3Data.push(encoded);
  }
  const flushed=mp3enc.flush();
  if(flushed.length>0) mp3Data.push(flushed);

  const blob=new Blob(mp3Data,{type:'audio/mp3'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`${filename}.mp3`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },1000);
};

/* ─── Themes ─────────────────────────────────────────────── */
const THEMES=[
  { id:'ocean', label:'🌊 Ocean', vars:{
    '--bg':'#060d12','--bg2':'#0b1520','--bg3':'#101e2a','--bg4':'#162535',
    '--border':'#1a2e3d','--border2':'#1f3a4f',
    '--text':'#d4eaf7','--text2':'#6a90a8','--text3':'#3a5a6a',
    '--amber':'#1a8fc0','--amber2':'#25aae0','--amber3':'#60ccff','--red':'#e05555',
  }},
  { id:'amber', label:'🌙 Dark Amber', vars:{
    '--bg':'#0c0b08','--bg2':'#131108','--bg3':'#1a180f','--bg4':'#201e14',
    '--border':'#2a2718','--border2':'#3a3620',
    '--text':'#f2ead8','--text2':'#8a8070','--text3':'#5a5448',
    '--amber':'#d4881a','--amber2':'#f0a030','--amber3':'#ffc060','--red':'#c0392b',
  }},
  { id:'forest', label:'🌿 Forest', vars:{
    '--bg':'#080d09','--bg2':'#0f150f','--bg3':'#141c14','--bg4':'#192219',
    '--border':'#1f2c1f','--border2':'#273627',
    '--text':'#d8edd8','--text2':'#6a8a6a','--text3':'#445844',
    '--amber':'#3a9e5a','--amber2':'#4dbf6e','--amber3':'#7de89a','--red':'#d44',
  }},
  { id:'rose', label:'🌸 Rose', vars:{
    '--bg':'#110810','--bg2':'#1a0e19','--bg3':'#221422','--bg4':'#2a182a',
    '--border':'#321e32','--border2':'#3e283e',
    '--text':'#f5ddf5','--text2':'#9a729a','--text3':'#644864',
    '--amber':'#c04880','--amber2':'#e0609a','--amber3':'#ff90c0','--red':'#e04444',
  }},
  { id:'light', label:'☀️ Light', vars:{
    '--bg':'#f5f2ec','--bg2':'#ede9e0','--bg3':'#e4dfd4','--bg4':'#dad4c8',
    '--border':'#ccc6b8','--border2':'#bbb4a4',
    '--text':'#2a2418','--text2':'#7a7060','--text3':'#aaa090',
    '--amber':'#c07010','--amber2':'#d88820','--amber3':'#a05808','--red':'#c0392b',
  }},
];
const getSavedTheme=()=>{ try{ return localStorage.getItem('ws-theme')||'ocean'; }catch{ return 'ocean'; } };
const saveTheme=id=>{ try{ localStorage.setItem('ws-theme',id); }catch{} };
const applyTheme=theme=>{ const r=document.documentElement; Object.entries(theme.vars).forEach(([k,v])=>r.style.setProperty(k,v)); };

/* ─── Styles ─────────────────────────────────────────────── */
const STYLE=`
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#060d12;--bg2:#0b1520;--bg3:#101e2a;--bg4:#162535;
  --border:#1a2e3d;--border2:#1f3a4f;
  --text:#d4eaf7;--text2:#6a90a8;--text3:#3a5a6a;
  --amber:#1a8fc0;--amber2:#25aae0;--amber3:#60ccff;--red:#e05555;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden;position:relative;}
.header{flex-shrink:0;height:54px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--bg2);position:relative;z-index:20;}
.header h1{font-family:'Syne',sans-serif;font-size:22px;font-weight:600;letter-spacing:-.5px;color:var(--text);}
.main{flex:1;overflow:hidden;display:flex;}
@media(max-width:660px){.main{flex-direction:column;}}
.playlist-panel{flex:1;display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden;min-width:0;}
@media(max-width:660px){.playlist-panel{flex:1;border-right:none;}}
.panel-head{flex-shrink:0;padding:11px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg2);}
.panel-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--text2);}
.song-count{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:2px 8px;font-size:10px;font-family:'DM Mono',monospace;color:var(--text2);margin-left:8px;}
.add-btn{background:var(--amber);color:#fff;border:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background .15s;min-height:40px;-webkit-tap-highlight-color:transparent;}
.add-btn:hover{background:var(--amber2);}
.add-btn:active{transform:scale(.96);}
.add-source-wrap{display:flex;border-bottom:1px solid var(--border);background:var(--bg2);flex-shrink:0;}
.add-source-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;font-size:12px;font-weight:500;cursor:pointer;background:none;border:none;color:var(--text3);font-family:'DM Sans',sans-serif;border-bottom:2px solid transparent;transition:all .15s;-webkit-tap-highlight-color:transparent;}
.add-source-btn.active{color:var(--amber);border-bottom-color:var(--amber);}
.add-source-btn:hover:not(.active){color:var(--text2);}
.add-action-wrap{flex-shrink:0;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2);}
.add-full-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--amber);color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background .15s;-webkit-tap-highlight-color:transparent;}
.add-full-btn:hover{background:var(--amber2);}
.add-full-btn:active{transform:scale(.97);}
.yt-input-wrap{display:flex;gap:6px;}
.yt-input{flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;font-family:'DM Sans',sans-serif;outline:none;transition:border-color .15s;min-width:0;}
.yt-input::placeholder{color:var(--text3);}
.yt-input:focus{border-color:var(--amber);}
.yt-input:disabled{opacity:.5;}
.yt-btn{flex-shrink:0;background:var(--amber);color:#fff;border:none;border-radius:8px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;-webkit-tap-highlight-color:transparent;}
.yt-btn:hover:not(:disabled){background:var(--amber2);}
.yt-btn:disabled{opacity:.4;cursor:not-allowed;}
.yt-error{font-size:11px;color:var(--red);padding:6px 0 0;font-family:'DM Sans',sans-serif;}
.songs-scroll{flex:1;overflow-y:auto;padding:8px;}
.songs-scroll::-webkit-scrollbar{width:3px;}
.songs-scroll::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.songs-scroll,.song-item,.song-row,.drag-handle{-webkit-user-select:none;user-select:none;}
.song-item{background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;cursor:pointer;transition:border-color .15s;overflow:hidden;-webkit-tap-highlight-color:transparent;}
.song-item:hover{border-color:var(--border2);}
.song-item.active{border-color:var(--amber);background:var(--bg3);}
.song-item.drag-over{border-color:var(--amber2) !important;background:var(--bg4) !important;}
.song-item.dragging{opacity:.4;}
.song-item.floating{opacity:1 !important;border-color:var(--amber) !important;box-shadow:0 12px 40px rgba(0,0,0,.5);transform:scale(1.03) rotate(0.8deg);z-index:999;pointer-events:none;}
.drag-handle{display:flex;flex-direction:column;justify-content:center;gap:3px;padding:8px 6px 8px 2px;cursor:grab;flex-shrink:0;opacity:.35;transition:opacity .15s;touch-action:none;}
.drag-handle:active{cursor:grabbing;}
.song-item:hover .drag-handle{opacity:.7;}
.drag-handle span{display:block;width:14px;height:1.5px;background:var(--text);border-radius:2px;}
.song-row{display:flex;align-items:center;gap:10px;padding:11px 12px;min-height:50px;}
.song-num{width:28px;height:28px;border-radius:50%;flex-shrink:0;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-family:'DM Mono',monospace;color:var(--text3);transition:all .15s;}
.song-item.active .song-num{background:var(--amber);border-color:var(--amber);color:#fff;}
.song-name{flex:1;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.song-badges{display:flex;gap:4px;flex-shrink:0;}
.badge{font-size:10px;font-family:'DM Mono',monospace;padding:2px 7px;border-radius:10px;background:var(--bg4);border:1px solid var(--border2);color:var(--amber2);}
.badge.neutral{color:var(--text3);}
.song-del{background:none;border:none;color:var(--text3);cursor:pointer;min-width:34px;min-height:34px;border-radius:6px;font-size:13px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s,color .15s;-webkit-tap-highlight-color:transparent;}
.song-item:hover .song-del{opacity:1;}
@media(max-width:660px){.song-del{opacity:.45;}}
.song-del:hover{color:var(--red);}
.song-controls{padding:0 12px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.ctrl-box{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;}
.ctrl-title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--text3);margin-bottom:6px;font-weight:600;}
.ctrl-val{font-family:'DM Mono',monospace;font-size:18px;font-weight:500;color:var(--amber3);text-align:center;margin-bottom:7px;line-height:1;}
.ctrl-val span{font-size:10px;color:var(--text2);}
.ctrl-btns{display:flex;gap:3px;justify-content:center;}
.c-btn{min-width:32px;min-height:38px;border-radius:6px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s;font-family:'DM Sans',sans-serif;padding:0 5px;-webkit-tap-highlight-color:transparent;}
.c-btn:hover{background:var(--amber);border-color:var(--amber);color:#fff;}
.c-btn:active{transform:scale(.92);}
.tempo-slider{width:100%;accent-color:var(--amber);cursor:pointer;margin-top:8px;height:4px;display:block;}
.song-actions{grid-column:1/-1;display:flex;gap:8px;margin-top:2px;}
.play-now-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--amber);color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background .15s;min-height:42px;-webkit-tap-highlight-color:transparent;}
.play-now-btn:hover:not(:disabled){background:var(--amber2);}
.play-now-btn:active:not(:disabled){transform:scale(.97);}
.play-now-btn:disabled{opacity:.5;cursor:not-allowed;}
.export-btn{display:flex;align-items:center;justify-content:center;gap:6px;background:none;border:1px solid var(--border2);color:var(--text2);border-radius:8px;padding:10px 14px;font-size:12px;font-weight:500;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .15s;min-height:42px;white-space:nowrap;-webkit-tap-highlight-color:transparent;}
.export-btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber);}
.export-btn:active:not(:disabled){transform:scale(.97);}
.export-btn:disabled{opacity:.4;cursor:not-allowed;}
.drop-zone{margin:8px;border:1px dashed var(--border2);border-radius:10px;padding:22px 14px;text-align:center;color:var(--text3);transition:all .2s;cursor:pointer;}
.drop-zone.over{border-color:var(--amber);color:var(--amber);background:rgba(212,136,26,.05);}
.drop-icon{font-size:24px;opacity:.4;margin-bottom:6px;}
.drop-zone p{font-size:12px;line-height:1.6;}
.pl-footer-wrap{flex-shrink:0;display:flex;flex-direction:column;}
.pl-banner{padding:7px 14px;background:var(--bg);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;}
.pl-banner-text{font-size:10px;color:var(--text3);font-family:'DM Sans',sans-serif;}
.pl-banner-links{display:flex;gap:8px;}
.pl-social-btn{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:1px solid var(--border2);color:var(--text3);text-decoration:none;transition:all .15s;-webkit-tap-highlight-color:transparent;}
.pl-social-btn:hover{border-color:var(--text2);color:var(--text2);}
.pl-footer{padding:7px 14px;border-top:1px solid var(--border);font-size:10px;color:var(--text3);font-family:'DM Mono',monospace;background:var(--bg);display:flex;align-items:center;justify-content:space-between;gap:8px;}
.clear-btn{background:none;border:1px solid var(--border2);color:var(--red);border-radius:6px;padding:4px 10px;font-size:10px;cursor:pointer;font-family:'DM Mono',monospace;transition:all .15s;white-space:nowrap;-webkit-tap-highlight-color:transparent;}
.clear-btn:hover{background:var(--red);color:#fff;border-color:var(--red);}
.clear-btn:active{transform:scale(.95);}
.player-panel{width:300px;flex-shrink:0;display:flex;flex-direction:column;background:var(--bg2);overflow:hidden;}
@media(max-width:660px){.player-panel{width:100%;flex-shrink:0;border-top:1px solid var(--border);}}
.now-playing{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 16px 8px;gap:4px;text-align:center;}
@media(max-width:660px){.now-playing{flex-direction:row;text-align:left;align-items:center;padding:12px 16px;gap:14px;flex:none;}}
.vinyl-wrap{position:relative;width:96px;height:96px;flex-shrink:0;}
@media(max-width:660px){.vinyl-wrap{width:52px;height:52px;}}
.vinyl{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 50%,var(--bg4) 18%,transparent 18%),repeating-conic-gradient(var(--bg3) 0deg 4deg,var(--bg) 4deg 8deg);border:1px solid var(--border2);box-shadow:0 0 0 1px var(--border),0 6px 20px rgba(0,0,0,.5);}
.vinyl.spin{animation:vspin 3s linear infinite;}
@keyframes vspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.vinyl-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:var(--amber);display:flex;align-items:center;justify-content:center;font-size:12px;}
@media(max-width:660px){.vinyl-label{width:17px;height:17px;font-size:8px;}}
.np-info{display:flex;flex-direction:column;gap:3px;min-width:0;}
.np-eyebrow{font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:var(--amber);font-weight:600;}
.np-title{font-family:'Syne',serif;font-size:17px;line-height:1.3;}
.np-empty{color:var(--text3);font-size:12px;font-style:italic;}
.np-badges{display:flex;gap:5px;margin-top:3px;flex-wrap:wrap;}
.np-badge{padding:3px 9px;border-radius:20px;background:var(--bg3);border:1px solid var(--border2);font-size:10px;font-family:'DM Mono',monospace;color:var(--amber2);}
.progress-wrap{padding:5px 16px;}
.prog-bar{background:var(--bg3);border-radius:3px;height:4px;cursor:pointer;position:relative;margin-bottom:5px;-webkit-tap-highlight-color:transparent;}
.prog-fill{background:linear-gradient(90deg,var(--amber),var(--amber2));height:100%;border-radius:3px;pointer-events:none;}
.prog-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:var(--amber2);border:2px solid var(--bg2);box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none;transition:transform .1s;}
.prog-bar:hover .prog-thumb,.prog-bar:active .prog-thumb{transform:translate(-50%,-50%) scale(1.3);}
.prog-times{display:flex;justify-content:space-between;font-size:10px;font-family:'DM Mono',monospace;color:var(--text3);}
.transport{padding:8px 16px 16px;display:flex;align-items:center;justify-content:center;gap:10px;}
.t-btn{min-width:46px;min-height:46px;border-radius:50%;background:none;border:1px solid var(--border2);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;-webkit-tap-highlight-color:transparent;}
.t-btn:active{transform:scale(.91);}
.t-btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber);}
.t-btn.play-btn{min-width:58px;min-height:58px;background:var(--amber);border-color:var(--amber);color:#fff;}
.t-btn.play-btn:hover:not(:disabled){background:var(--amber2);border-color:var(--amber2);}
.t-btn:disabled{opacity:.2;cursor:not-allowed;}
.proc-wrap{padding:4px 16px;}
.proc-label{font-size:10px;color:var(--text2);text-align:center;margin-bottom:4px;font-family:'DM Mono',monospace;}
.proc-track{background:var(--bg3);border-radius:3px;height:3px;overflow:hidden;}
.proc-inner{height:100%;background:var(--amber);border-radius:3px;transition:width .15s linear;}
.theme-btn{margin-left:auto;background:none;border:1px solid var(--border2);color:var(--text2);border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer;font-family:'DM Sans',sans-serif;display:flex;align-items:center;gap:5px;transition:all .15s;-webkit-tap-highlight-color:transparent;white-space:nowrap;}
.theme-btn:hover{border-color:var(--amber);color:var(--amber);}
.theme-dropdown{position:absolute;top:58px;right:12px;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.4);min-width:160px;}
.theme-option{padding:11px 16px;font-size:13px;cursor:pointer;transition:background .12s;display:flex;align-items:center;gap:8px;-webkit-tap-highlight-color:transparent;}
.theme-option:hover{background:var(--bg3);}
.theme-option.active{color:var(--amber);font-weight:600;}
.theme-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
`;

const fmt=s=>!s||isNaN(s)?"0:00":`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
const pitchLabel=s=>s===0?"±0":s>0?`+${s}`:`${s}`;

const IconPrev=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>;
const IconNext=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z"/></svg>;
const IconPlay=()=><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>;
const IconPause=()=><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>;
const IconPlaySm=()=><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>;
const IconExport=()=><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5v-2z"/></svg>;

export default function WorshipSetlist() {
  const [songs,      setSongs]      = useState([]);
  const [activeIdx,  setActiveIdx]  = useState(null);
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [duration,   setDuration]   = useState(0);
  const [processing, setProcessing] = useState(false);
  const [procPct,    setProcPct]    = useState(0);
  const [dragOver,   setDragOver]   = useState(false);
  const [themeId,    setThemeId]    = useState(getSavedTheme);
  const [showThemes, setShowThemes] = useState(false);
  const [dragOverIdx,setDragOverIdx]= useState(null);
  const [exporting,  setExporting]  = useState(null); // song id being exported
  const [showYt,     setShowYt]     = useState(false);
  const [ytUrl,      setYtUrl]      = useState('');
  const [ytLoading,  setYtLoading]  = useState(false);
  const [ytError,    setYtError]    = useState('');

  const fileInputRef = useRef(null);
  const actxRef      = useRef(null);
  const sourceRef    = useRef(null);
  const startTimeRef = useRef(0);
  const pausedAtRef  = useRef(0);
  const rafRef       = useRef(null);
  const durationRef  = useRef(0);
  const genRef       = useRef(0);
  const busyRef      = useRef(false);
  const dragSrcRef   = useRef(null);
  const floatRef     = useRef(null);
  const touchSrcIdx  = useRef(null);

  const songsRef     = useRef(songs);
  const activeIdxRef = useRef(activeIdx);
  const isPlayingRef = useRef(isPlaying);
  useEffect(()=>{ songsRef.current=songs; },         [songs]);
  useEffect(()=>{ activeIdxRef.current=activeIdx; }, [activeIdx]);
  useEffect(()=>{ isPlayingRef.current=isPlaying; }, [isPlaying]);

  // Apply theme
  useEffect(()=>{
    const t=THEMES.find(t=>t.id===themeId)||THEMES[0];
    applyTheme(t); saveTheme(themeId);
  },[themeId]);

  // Close theme dropdown on outside click
  useEffect(()=>{
    if(!showThemes) return;
    const h=()=>setShowThemes(false);
    setTimeout(()=>document.addEventListener('click',h),0);
    return ()=>document.removeEventListener('click',h);
  },[showThemes]);

  // Load persisted songs on first mount
  useEffect(()=>{
    (async()=>{
      try{
        const ctx=getCtx();
        const saved=await dbGetAll();
        if(!saved.length) return;
        const restored=await Promise.all(saved.map(async s=>{
          const audioBuffer=await ctx.decodeAudioData(s.arrayBuffer.slice(0));
          return{id:s.id,name:s.name,audioBuffer,pitch:s.pitch,tempo:s.tempo,
            cachedBuffer:null,cachedPitch:null,cachedTempo:null};
        }));
        restored.sort((a,b)=>saved.findIndex(s=>s.id===a.id)-saved.findIndex(s=>s.id===b.id));
        setSongs(restored);
      }catch(e){ console.error('Restore failed:',e); }
    })();
  },[]);

  const getCtx=()=>{
    if(!actxRef.current||actxRef.current.state==="closed")
      actxRef.current=new(window.AudioContext||window.webkitAudioContext)();
    return actxRef.current;
  };

  const stopSource=()=>{
    if(sourceRef.current){try{sourceRef.current.stop();}catch{}sourceRef.current.disconnect();sourceRef.current=null;}
    if(rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const audioBufferToArrayBuffer=(audioBuffer)=>{
    const numCh=audioBuffer.numberOfChannels, len=audioBuffer.length, sr=audioBuffer.sampleRate;
    const ab=new ArrayBuffer(44+len*numCh*2), view=new DataView(ab);
    const ws=(off,str)=>{for(let i=0;i<str.length;i++)view.setUint8(off+i,str.charCodeAt(i));};
    ws(0,'RIFF'); view.setUint32(4,36+len*numCh*2,true);
    ws(8,'WAVE'); ws(12,'fmt '); view.setUint32(16,16,true);
    view.setUint16(20,1,true); view.setUint16(22,numCh,true);
    view.setUint32(24,sr,true); view.setUint32(28,sr*numCh*2,true);
    view.setUint16(32,numCh*2,true); view.setUint16(34,16,true);
    ws(36,'data'); view.setUint32(40,len*numCh*2,true);
    let off=44;
    for(let i=0;i<len;i++) for(let c=0;c<numCh;c++){
      const v=Math.max(-1,Math.min(1,audioBuffer.getChannelData(c)[i]));
      view.setInt16(off,v<0?v*0x8000:v*0x7FFF,true); off+=2;
    }
    return ab;
  };

  const getProcessedBuffer=useCallback(async(song)=>{
    if(song.cachedBuffer&&song.cachedPitch===song.pitch&&song.cachedTempo===song.tempo)
      return song.cachedBuffer;
    if(song.pitch===0&&song.tempo===100) return song.audioBuffer;

    const cacheKey=`${song.id}-${song.pitch}-${song.tempo}`;
    try{
      const cached=await dbGetCache(cacheKey);
      if(cached){
        const ctx=getCtx();
        const rendered=await ctx.decodeAudioData(cached.arrayBuffer.slice(0));
        setSongs(prev=>prev.map(s=>s.id===song.id
          ?{...s,cachedBuffer:rendered,cachedPitch:song.pitch,cachedTempo:song.tempo}:s));
        return rendered;
      }
    }catch(e){ console.warn('Cache read failed:',e); }

    const ab=song.audioBuffer, numCh=ab.numberOfChannels;
    const pitchFactor=Math.pow(2,song.pitch/12), tempoFactor=song.tempo/100;
    setProcPct(0);
    const stretched=await pvStretchAsync(ab,pitchFactor/tempoFactor,p=>setProcPct(p));
    setProcPct(0.95);
    const outLen=Math.max(1,Math.round(ab.length/tempoFactor));
    const offCtx=new OfflineAudioContext(numCh,outLen,ab.sampleRate);
    const strBuf=offCtx.createBuffer(numCh,stretched[0].length,ab.sampleRate);
    for(let c=0;c<numCh;c++) strBuf.copyToChannel(stretched[c],c);
    const src=offCtx.createBufferSource();
    src.buffer=strBuf; src.playbackRate.value=pitchFactor;
    src.connect(offCtx.destination); src.start(0);
    const rendered=await offCtx.startRendering();
    setProcPct(1);

    try{
      const arrayBuffer=audioBufferToArrayBuffer(rendered);
      dbPutCache(cacheKey,arrayBuffer).catch(()=>{});
    }catch(e){ console.warn('Cache write failed:',e); }

    setSongs(prev=>prev.map(s=>s.id===song.id
      ?{...s,cachedBuffer:rendered,cachedPitch:song.pitch,cachedTempo:song.tempo}:s));
    return rendered;
  },[]);

  const playFrom=useCallback(async(idx,offset=0)=>{
    if(busyRef.current) return;
    busyRef.current=true;
    const song=songsRef.current[idx];
    if(!song){ busyRef.current=false; return; }
    setProcessing(true); stopSource();
    const ctx=getCtx(); if(ctx.state==="suspended") await ctx.resume();
    try{
      const buffer=await getProcessedBuffer(song);
      durationRef.current=buffer.duration;
      setDuration(buffer.duration); setProgress(offset);
      const src=ctx.createBufferSource();
      src.buffer=buffer; src.connect(ctx.destination); src.start(0,offset);
      startTimeRef.current=ctx.currentTime-offset; sourceRef.current=src;
      const gen=++genRef.current;
      src.onended=()=>{
        if(genRef.current!==gen) return;
        if(!isPlayingRef.current) return;
        const next=activeIdxRef.current+1;
        if(next<songsRef.current.length){setActiveIdx(next);pausedAtRef.current=0;playFrom(next,0);}
        else{setIsPlaying(false);setProgress(0);pausedAtRef.current=0;}
      };
      const tick=()=>{
        const el=ctx.currentTime-startTimeRef.current;
        setProgress(Math.min(el,durationRef.current));
        if(el<durationRef.current) rafRef.current=requestAnimationFrame(tick);
      };
      rafRef.current=requestAnimationFrame(tick);
      setActiveIdx(idx); setIsPlaying(true);
    }catch(e){console.error(e);}
    finally{setProcessing(false);setProcPct(0);busyRef.current=false;}
  },[getProcessedBuffer]);

  const handlePlayPause=()=>{
    if(processing) return;
    const ctx=getCtx();
    if(isPlaying){
      pausedAtRef.current=Math.min(ctx.currentTime-startTimeRef.current,durationRef.current);
      stopSource(); setIsPlaying(false);
    } else { playFrom(activeIdx??0,pausedAtRef.current); }
  };

  const handlePrev=()=>{if(activeIdx!==null){pausedAtRef.current=0;playFrom(Math.max(0,activeIdx-1),0);}};
  const handleNext=()=>{if(activeIdx!==null&&activeIdx+1<songs.length){pausedAtRef.current=0;playFrom(activeIdx+1,0);}};

  const handleProgressClick=e=>{
    if(activeIdx===null||duration===0) return;
    const rect=e.currentTarget.getBoundingClientRect();
    const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    pausedAtRef.current=ratio*duration; playFrom(activeIdx,pausedAtRef.current);
  };

  const handleScrubStart=e=>{
    if(activeIdx===null||duration===0) return;
    e.preventDefault();
    const bar=e.currentTarget;
    const wasPlaying=isPlayingRef.current;
    if(wasPlaying){ stopSource(); setIsPlaying(false); }
    const getX=ev=>ev.touches?ev.touches[0].clientX:ev.clientX;
    const onMove=ev=>{
      const rect=bar.getBoundingClientRect();
      const ratio=Math.max(0,Math.min(1,(getX(ev)-rect.left)/rect.width));
      pausedAtRef.current=ratio*duration; setProgress(ratio*duration);
    };
    const onUp=()=>{
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
      document.removeEventListener('touchmove',onMove);
      document.removeEventListener('touchend',onUp);
      if(wasPlaying) playFrom(activeIdx,pausedAtRef.current);
    };
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
    document.addEventListener('touchmove',onMove,{passive:false});
    document.addEventListener('touchend',onUp);
  };

  // Drag to reorder
  const handleDragStart=(e,idx)=>{
    dragSrcRef.current=idx;
    const blank=document.createElement('div');
    document.body.appendChild(blank);
    e.dataTransfer.setDragImage(blank,0,0);
    setTimeout(()=>document.body.removeChild(blank),0);
    setTimeout(()=>{ const el=document.querySelector(`[data-idx="${idx}"]`); if(el) el.classList.add('dragging'); },0);
  };
  const handleDragEnter=(idx)=>{
    if(dragSrcRef.current===null||dragSrcRef.current===idx) return;
    setDragOverIdx(idx);
  };
  const handleDragEnd=()=>{
    document.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));
    const from=dragSrcRef.current, to=dragOverIdx;
    dragSrcRef.current=null; setDragOverIdx(null);
    if(from===null||to===null||from===to) return;
    setSongs(prev=>{
      const next=[...prev]; const [moved]=next.splice(from,1); next.splice(to,0,moved);
      if(activeIdx===from) setActiveIdx(to);
      else if(activeIdx>from&&activeIdx<=to) setActiveIdx(i=>i-1);
      else if(activeIdx<from&&activeIdx>=to) setActiveIdx(i=>i+1);
      return next;
    });
  };
  const handleTouchStart=(e,idx)=>{
    e.stopPropagation(); touchSrcIdx.current=idx; dragSrcRef.current=idx;
    const src=document.querySelector(`[data-idx="${idx}"]`);
    if(src){
      const clone=src.cloneNode(true);
      const rect=src.getBoundingClientRect();
      clone.style.cssText=`position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;pointer-events:none;z-index:9999;border-radius:10px;transition:none;`;
      clone.classList.add('floating');
      document.body.appendChild(clone);
      floatRef.current={el:clone,offsetY:e.touches[0].clientY-rect.top};
      src.classList.add('dragging');
    }
  };
  const handleTouchMove=(e)=>{
    e.preventDefault();
    const touch=e.touches[0];
    if(floatRef.current) floatRef.current.el.style.top=`${touch.clientY-floatRef.current.offsetY}px`;
    const el=document.elementFromPoint(touch.clientX,touch.clientY);
    const item=el?.closest('[data-idx]');
    if(item){ const idx=parseInt(item.dataset.idx); if(!isNaN(idx)&&idx!==touchSrcIdx.current) setDragOverIdx(idx); }
  };
  const handleTouchEnd=()=>{
    if(floatRef.current){ document.body.removeChild(floatRef.current.el); floatRef.current=null; }
    document.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));
    const from=touchSrcIdx.current, to=dragOverIdx;
    touchSrcIdx.current=null; dragSrcRef.current=null; setDragOverIdx(null);
    if(from===null||to===null||from===to) return;
    setSongs(prev=>{
      const next=[...prev]; const [moved]=next.splice(from,1); next.splice(to,0,moved);
      if(activeIdx===from) setActiveIdx(to);
      else if(activeIdx>from&&activeIdx<=to) setActiveIdx(i=>i-1);
      else if(activeIdx<from&&activeIdx>=to) setActiveIdx(i=>i+1);
      return next;
    });
  };

  const handleYtAdd=async()=>{
    if(!ytUrl.trim()) return;
    setYtLoading(true); setYtError('');
    try{
      const res=await fetch('https://pitchlist-backend--ipanmanuel.replit.app/download',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url:ytUrl.trim()})
      });
      if(!res.ok){ const err=await res.json(); throw new Error(err.error||'Failed to download'); }
      const blob=await res.blob();
      const disposition=res.headers.get('content-disposition')||'';
      const match=disposition.match(/filename="?(.+?)("|\s*$)/);
      const filename=match?match[1]:'YouTube Audio';
      const file=new File([blob],filename,{type:'audio/mpeg'});
      await loadFiles([file]);
      setYtUrl(''); setShowYt(false);
    }catch(e){ setYtError(e.message||'Something went wrong'); }
    finally{ setYtLoading(false); }
  };
  // Export MP3
  const handleExport=async(e,song)=>{
    e.stopPropagation();
    setExporting(song.id);
    try{
      const buffer=await getProcessedBuffer(song);
      const label=pitchLabel(song.pitch)==='±0'&&song.tempo===100
        ?song.name
        :`${song.name} (${pitchLabel(song.pitch)}st ${song.tempo}%)`;
      await exportMp3(buffer,label);
    }catch(err){ console.error('Export failed:',err); alert('Export failed: '+err.message); }
    finally{ setExporting(null); }
  };

  const updateSong=(id,key,val)=>setSongs(prev=>prev.map(s=>{
    if(s.id!==id) return s;
    const updated={...s,[key]:val};
    openDB().then(db=>{
      const store=db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE);
      const req=store.get(id);
      req.onsuccess=e=>{ if(e.target.result) store.put({...e.target.result,pitch:updated.pitch,tempo:updated.tempo}); };
    }).catch(()=>{});
    return updated;
  }));

  const loadFiles=async files=>{
    const ctx=getCtx();
    const loaded=await Promise.all(
      Array.from(files)
        .filter(f=>f.type.startsWith("audio/")||/\.(mp3|wav|ogg|m4a|aac|flac|mp4|caf)$/i.test(f.name))
        .map(async file=>{
          const ab=await file.arrayBuffer();
          const audioBuffer=await ctx.decodeAudioData(ab);
          return{id:Math.random().toString(36).slice(2,9),
            name:file.name.replace(/\.[^.]+$/,""),audioBuffer,
            pitch:0,tempo:100,cachedBuffer:null,cachedPitch:null,cachedTempo:null};
        })
    );
    setSongs(prev=>{
      const next=[...prev,...loaded];
      loaded.forEach(s=>{
        const arrayBuffer=audioBufferToArrayBuffer(s.audioBuffer);
        dbPut({id:s.id,name:s.name,arrayBuffer,pitch:s.pitch,tempo:s.tempo}).catch(()=>{});
      });
      return next;
    });
  };

  const removeSong=(id,e)=>{
    e.stopPropagation();
    dbDelete(id).catch(()=>{});
    dbDeleteCache(id).catch(()=>{});
    setSongs(prev=>{
      const ri=prev.findIndex(s=>s.id===id);
      const next=prev.filter(s=>s.id!==id);
      if(activeIdx===ri){stopSource();setIsPlaying(false);setActiveIdx(null);setProgress(0);}
      else if(activeIdx>ri) setActiveIdx(i=>i-1);
      return next;
    });
  };

  const currentSong=activeIdx!==null?songs[activeIdx]:null;
  const pct=duration>0?(progress/duration)*100:0;

  return(
    <>
      <style>{STYLE}</style>
      <div className="app">
        <header className="header">
          <h1>PitchList</h1>
          <button className="theme-btn" onClick={e=>{e.stopPropagation();setShowThemes(p=>!p)}}>
            🎨 Theme
          </button>
          {showThemes&&(
            <div className="theme-dropdown" onClick={e=>e.stopPropagation()}>
              {THEMES.map(t=>(
                <div key={t.id} className={`theme-option${themeId===t.id?' active':''}`}
                  onClick={()=>{setThemeId(t.id);setShowThemes(false);}}>
                  <div className="theme-dot" style={{background:t.vars['--amber']}}/>
                  {t.label}
                </div>
              ))}
            </div>
          )}
        </header>

        <div className="main">
          {/* Playlist */}
          <div className="playlist-panel">
            <div className="panel-head">
              <div style={{display:"flex",alignItems:"center"}}>
                <span className="panel-label">Setlist</span>
                <span className="song-count">{songs.length}</span>
              </div>
            </div>

            <div className="add-source-wrap">
              <button className={`add-source-btn${!showYt?' active':''}`}
                onClick={()=>{ setShowYt(false); setYtError(''); setYtUrl(''); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
                Upload File
              </button>
              <button className={`add-source-btn${showYt?' active':''}`}
                onClick={()=>setShowYt(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0-2.19-.16-3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>
                YouTube
              </button>
            </div>

            {!showYt&&(
              <div className="add-action-wrap">
                <button className="add-full-btn" onClick={()=>fileInputRef.current?.click()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
                  Choose Audio Files
                </button>
                <input ref={fileInputRef} type="file"
                  accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.caf"
                  multiple style={{display:"none"}}
                  onChange={e=>{loadFiles(e.target.files);e.target.value="";}}/>
              </div>
            )}

            {showYt&&(
              <div className="add-action-wrap">
                <div className="yt-input-wrap">
                  <input className="yt-input" type="url"
                    placeholder="Paste YouTube URL…"
                    value={ytUrl} disabled={ytLoading}
                    onChange={e=>{ setYtUrl(e.target.value); setYtError(''); }}
                    onKeyDown={e=>{ if(e.key==='Enter') handleYtAdd(); }}/>
                  <button className="yt-btn" onClick={handleYtAdd} disabled={ytLoading||!ytUrl.trim()}>
                    {ytLoading
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" style={{animation:'spin .7s linear infinite',transformOrigin:'center'}}/></svg>
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>
                    }
                  </button>
                </div>
                {ytError&&<div className="yt-error">{ytError}</div>}
              </div>
            )}

            <div className="songs-scroll"
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);loadFiles(e.dataTransfer.files);}}>
              {songs.length===0?(
                <div className={`drop-zone${dragOver?" over":""}`} onClick={()=>fileInputRef.current?.click()}>
                  <div className="drop-icon">🎧</div>
                  <p>Drop audio files here<br/>or tap to browse</p>
                  <p style={{fontSize:10,marginTop:6,color:"var(--text3)"}}>MP3 · WAV · OGG · M4A</p>
                </div>
              ):(
                <>
                  {songs.map((song,idx)=>{
                    const isActive=idx===activeIdx;
                    return(
                      <div key={song.id}
                        data-idx={idx}
                        className={`song-item${isActive?" active":""}${dragOverIdx===idx?" drag-over":""}`}
                        onDragEnter={()=>handleDragEnter(idx)}
                        onDragOver={e=>e.preventDefault()}
                        onDragEnd={handleDragEnd}
                        onClick={()=>setActiveIdx(isActive?null:idx)}>
                        <div className="song-row">
                          <div className="drag-handle"
                            draggable
                            onDragStart={e=>handleDragStart(e,idx)}
                            onTouchStart={e=>handleTouchStart(e,idx)}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}>
                            <span/><span/><span/>
                          </div>
                          <div className="song-num">{isActive&&isPlaying?<IconPlaySm/>:idx+1}</div>
                          <span className="song-name" title={song.name}>{song.name}</span>
                          <div className="song-badges">
                            <span className={`badge${song.pitch===0?" neutral":""}`}>{pitchLabel(song.pitch)}st</span>
                            <span className={`badge${song.tempo===100?" neutral":""}`}>{song.tempo}%</span>
                          </div>
                          <button className="song-del" onClick={e=>removeSong(song.id,e)}>✕</button>
                        </div>
                        {isActive&&(
                          <div className="song-controls" onClick={e=>e.stopPropagation()}>
                            <div className="ctrl-box">
                              <div className="ctrl-title">Pitch</div>
                              <div className="ctrl-val">{pitchLabel(song.pitch)}<span> st</span></div>
                              <div className="ctrl-btns">
                                {[-2,-1].map(d=>(
                                  <button key={d} className="c-btn"
                                    onClick={()=>updateSong(song.id,"pitch",Math.max(-12,song.pitch+d))}>{d}</button>
                                ))}
                                <button className="c-btn" style={{fontSize:11}}
                                  onClick={()=>updateSong(song.id,"pitch",0)}>↺</button>
                                {[1,2].map(d=>(
                                  <button key={d} className="c-btn"
                                    onClick={()=>updateSong(song.id,"pitch",Math.min(12,song.pitch+d))}>+{d}</button>
                                ))}
                              </div>
                            </div>
                            <div className="ctrl-box">
                              <div className="ctrl-title">Tempo</div>
                              <div className="ctrl-val">{song.tempo}<span>%</span></div>
                              <div className="ctrl-btns">
                                <button className="c-btn"
                                  onClick={()=>updateSong(song.id,"tempo",Math.max(50,song.tempo-5))}>−5</button>
                                <button className="c-btn" style={{fontSize:11}}
                                  onClick={()=>updateSong(song.id,"tempo",100)}>↺</button>
                                <button className="c-btn"
                                  onClick={()=>updateSong(song.id,"tempo",Math.min(150,song.tempo+5))}>+5</button>
                              </div>
                              <input type="range" className="tempo-slider"
                                min={50} max={150} value={song.tempo}
                                onChange={e=>updateSong(song.id,"tempo",Number(e.target.value))}/>
                            </div>
                            <div className="song-actions">
                              <button className="play-now-btn"
                                disabled={processing}
                                onClick={e=>{e.stopPropagation();pausedAtRef.current=0;playFrom(idx,0);}}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                {processing&&activeIdx===idx?`Processing… ${Math.round(procPct*100)}%`:'Play'}
                              </button>
                             <button className="export-btn"
                                disabled={exporting===song.id||!(song.cachedBuffer&&song.cachedPitch===song.pitch&&song.cachedTempo===song.tempo)&&!(song.pitch===0&&song.tempo===100)}
                                onClick={e=>handleExport(e,song)}>
                                {exporting===song.id
                                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" style={{animation:'spin .7s linear infinite',transformOrigin:'center'}}/></svg>
                                  : <IconExport/>
                                }
                                {exporting===song.id?'Exporting…':'Export MP3'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className={`drop-zone${dragOver?" over":""}`}
                    style={{padding:"13px 14px",margin:"2px 0 0"}}
                    onClick={()=>fileInputRef.current?.click()}>
                    <p style={{fontSize:11}}>+ Add more songs</p>
                  </div>
                </>
              )}
            </div>

            <div className="pl-footer-wrap">
              <div className="pl-banner">
                <span className="pl-banner-text">Enjoying PitchList? Follow us!</span>
                <div className="pl-banner-links">
                  <a href="https://www.instagram.com/ipanmanuel" target="_blank" rel="noopener noreferrer" className="pl-social-btn">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.5" fill="currentColor"/></svg>
                  </a>
                  <a href="https://www.tiktok.com/@ipanmanuel10" target="_blank" rel="noopener noreferrer" className="pl-social-btn">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/></svg>
                  </a>
                </div>
              </div>
              <div className="pl-footer">
                <span>{songs.length>0?`${songs.length} song${songs.length!==1?"s":""} · tap to select & adjust`:"no songs loaded"}</span>
                {songs.length>0&&(
                  <button className="clear-btn" onClick={()=>{
                    if(!window.confirm('Clear all songs from the setlist?')) return;
                    stopSource(); setIsPlaying(false); setActiveIdx(null);
                    setProgress(0); setDuration(0); pausedAtRef.current=0;
                    songs.forEach(s=>{ dbDelete(s.id).catch(()=>{}); dbDeleteCache(s.id).catch(()=>{}); });
                    setSongs([]);
                  }}>Clear Setlist</button>
                )}
              </div>
            </div>
          </div>

          {/* Player */}
          <div className="player-panel">
            <div className="now-playing">
              <div className="vinyl-wrap">
                <div className={`vinyl${isPlaying?" spin":""}`}/>
                <div className="vinyl-label">🎵</div>
              </div>
              {currentSong?(
                <div className="np-info">
                  <div className="np-eyebrow">Now Playing · {activeIdx+1}/{songs.length}</div>
                  <div className="np-title">{currentSong.name}</div>
                  <div className="np-badges">
                    <div className="np-badge">{pitchLabel(currentSong.pitch)} semitones</div>
                    <div className="np-badge">{currentSong.tempo}% tempo</div>
                  </div>
                </div>
              ):(
                <div className="np-info">
                  <div className="np-eyebrow">PitchList</div>
                  <p className="np-empty">{songs.length===0?"Add songs to get started":"Tap a song to select"}</p>
                </div>
              )}
            </div>

            {processing&&(
              <div className="proc-wrap">
                <div className="proc-label">Processing… {Math.round(procPct*100)}%</div>
                <div className="proc-track"><div className="proc-inner" style={{width:`${procPct*100}%`}}/></div>
              </div>
            )}

            <div className="progress-wrap">
              <div className="prog-bar"
                onClick={handleProgressClick}
                onMouseDown={handleScrubStart}
                onTouchStart={handleScrubStart}>
                <div className="prog-fill" style={{width:`${pct}%`}}/>
                <div className="prog-thumb" style={{left:`${pct}%`}}/>
              </div>
              <div className="prog-times"><span>{fmt(progress)}</span><span>{fmt(duration)}</span></div>
            </div>

            <div className="transport">
              <button className="t-btn" onClick={handlePrev} disabled={!currentSong||activeIdx===0}><IconPrev/></button>
              <button className="t-btn play-btn"
                onClick={songs.length>0?handlePlayPause:undefined}
                disabled={songs.length===0||processing}>
                {isPlaying?<IconPause/>:<IconPlay/>}
              </button>
              <button className="t-btn" onClick={handleNext} disabled={!currentSong||activeIdx>=songs.length-1}><IconNext/></button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
