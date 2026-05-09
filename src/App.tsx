import { useState, useRef, useEffect, useCallback } from "react";

/* ─── IndexedDB persistence ──────────────────────────────── */
const DB_NAME='worship-setlist', DB_STORE='songs', DB_VER=4;
const openDB=()=>new Promise((res,rej)=>{
  const req=indexedDB.open(DB_NAME,DB_VER);
  req.onupgradeneeded=e=>{
    const db=e.target.result;
    if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE,{keyPath:'id'});
    // Remove legacy processed-buffer cache store if upgrading from v1/v2
    if(db.objectStoreNames.contains('buffers')) db.deleteObjectStore('buffers');
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
const dbPatchKey=async(id,root,mode)=>{
  const db=await openDB();
  return new Promise<void>((res,rej)=>{
    const store=db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE);
    const req=store.get(id);
    req.onsuccess=e=>{
      const rec=(e.target as any).result;
      if(rec) store.put({...rec,detectedRoot:root,detectedMode:mode});
      res();
    };
    req.onerror=e=>rej((e.target as any).error);
  });
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

/* ─── PWA install helpers ─────────────────────────────────── */
let _installPrompt:any=null;
let _onInstallReady:(()=>void)|null=null;
window.addEventListener('beforeinstallprompt',(e:any)=>{
  e.preventDefault(); _installPrompt=e; _onInstallReady?.();
});
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)&&!(window as any).MSStream;
const isStandalone=()=>!!(window.matchMedia('(display-mode: standalone)').matches||(navigator as any).standalone);
const saveOrder=(songs:{id:string}[])=>{ try{ localStorage.setItem('ws-order',JSON.stringify(songs.map(s=>s.id))); }catch{} };
const getSavedOrder=():string[]=>{ try{ return JSON.parse(localStorage.getItem('ws-order')||'[]'); }catch{ return []; } };

/* ─── iOS audio session + background playback ────────────── */
/* iOS defaults Web Audio API to "ambient" session (respects mute, suspends
   on background). Fix:
   1. navigator.audioSession.category='playback' — modern API (Safari 17+)
   2. Loop a silent <audio> element — keeps the playback session alive so
      iOS doesn't suspend the AudioContext when the app is minimised.
   The looping element must stay referenced (not GC'd) for this to work. */
let _keepAlive:HTMLAudioElement|null=null;
let _sessionSet=false;
/* Build the silent keepalive element once, then call unlockAudio() on every
   user gesture so play() is retried until the browser accepts it. */
const unlockAudio=()=>{
  try{
    /* Set audio session category once — Safari 17+ / iOS 17+ */
    if(!_sessionSet&&'audioSession' in navigator){
      (navigator as any).audioSession.category='playback';
      _sessionSet=true;
    }
    /* Create the looping silent WAV element once */
    if(!_keepAlive){
      const sr=8000,ns=800;
      const ab=new ArrayBuffer(44+ns*2);
      const v=new DataView(ab);
      const ws=(o:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
      ws(0,'RIFF');v.setUint32(4,36+ns*2,true);ws(8,'WAVE');ws(12,'fmt ');
      v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
      v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);
      v.setUint16(32,2,true);v.setUint16(34,16,true);
      ws(36,'data');v.setUint32(40,ns*2,true);
      const url=URL.createObjectURL(new Blob([ab],{type:'audio/wav'}));
      _keepAlive=new Audio(url);
      _keepAlive.loop=true;
      _keepAlive.volume=0;
      /* Re-start keepalive if iOS pauses it on screen-lock */
      document.addEventListener('visibilitychange',()=>{
        if(document.visibilityState==='visible'&&_keepAlive&&_keepAlive.paused)
          _keepAlive.play().catch(()=>{});
      });
    }
    /* Retry play() on every user gesture until iOS accepts it */
    if(_keepAlive.paused) _keepAlive.play().catch(()=>{});
  }catch{}
};

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
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;overscroll-behavior:none;overflow:hidden;}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden;position:relative;}
.header{flex-shrink:0;height:54px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--bg2);position:relative;z-index:20;}
.header h1{font-family:'Syne',sans-serif;font-size:22px;font-weight:600;letter-spacing:-.5px;color:var(--text);}
.main{flex:1;overflow:hidden;display:flex;}
@media(max-width:660px){.main{flex-direction:column;}}
.playlist-panel{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
@media(max-width:660px){.playlist-panel{flex:1;border-right:none;}}
.panel-head{flex-shrink:0;padding:11px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg2);}
.panel-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--text2);}
.song-count{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:2px 8px;font-size:10px;font-family:'DM Mono',monospace;color:var(--text2);margin-left:8px;}
.add-btn{background:var(--amber);color:#fff;border:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background .15s;min-height:40px;-webkit-tap-highlight-color:transparent;}
.add-btn:hover{background:var(--amber2);}
.add-btn:active{transform:scale(.96);}
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
@media(max-width:660px){.song-num{display:none;}}
.song-name{flex:1;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
@keyframes mq-scroll{0%,25%{transform:translateX(0);}70%,92%{transform:translateX(var(--mq,0px));}100%{transform:translateX(0);}}
.song-badges{display:flex;gap:4px;flex-shrink:0;}
.badge{font-size:10px;font-family:'DM Mono',monospace;padding:2px 7px;border-radius:10px;background:var(--bg4);border:1px solid var(--border2);color:var(--amber2);}
.badge.neutral{color:var(--text3);}
.badge.key{color:var(--amber3);border-color:var(--amber);}
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
.export-btn{display:flex;align-items:center;justify-content:center;gap:6px;background:var(--bg3);color:var(--text2);border:1px solid var(--border2);border-radius:8px;padding:10px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .15s;min-height:42px;white-space:nowrap;-webkit-tap-highlight-color:transparent;}
.export-btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber);}
.export-btn:active:not(:disabled){transform:scale(.96);}
.export-btn:disabled{opacity:.45;cursor:not-allowed;}
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
.player-panel{width:100%;flex-shrink:0;display:flex;flex-direction:row;align-items:center;background:var(--bg2);border-top:1px solid var(--border);padding:0 20px;gap:16px;height:80px;}
@media(max-width:660px){.player-panel{height:auto;flex-direction:column;padding:0;gap:0;}}
.now-playing{display:flex;flex-direction:row;align-items:center;padding:0;gap:10px;width:220px;flex-shrink:0;order:1;}
@media(max-width:660px){.now-playing{width:100%;padding:10px 16px;order:0;}}
@media(max-width:660px){.np-info{flex:1;align-items:center;text-align:center;}}
.vinyl-wrap{position:relative;width:46px;height:46px;flex-shrink:0;}
@media(max-width:660px){.vinyl-wrap{width:46px;height:46px;}}
.vinyl{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 50%,var(--bg4) 18%,transparent 18%),repeating-conic-gradient(var(--bg3) 0deg 4deg,var(--bg) 4deg 8deg);border:1px solid var(--border2);box-shadow:0 0 0 1px var(--border),0 6px 20px rgba(0,0,0,.5);}
.vinyl.spin{animation:vspin 3s linear infinite;}
@keyframes vspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.vinyl-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:17px;height:17px;border-radius:50%;background:var(--amber);display:flex;align-items:center;justify-content:center;font-size:9px;}
.np-info{display:flex;flex-direction:column;gap:2px;min-width:0;}
.np-eyebrow{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--amber);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.np-title{display:block;font-family:'Syne',serif;font-size:14px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.np-empty{color:var(--text3);font-size:12px;font-style:italic;}
.np-badges{display:none;}
@media(max-width:660px){.np-badges{display:flex;gap:5px;margin-top:3px;flex-wrap:wrap;}}
.np-badge{padding:3px 9px;border-radius:20px;background:var(--bg3);border:1px solid var(--border2);font-size:10px;font-family:'DM Mono',monospace;color:var(--amber2);}
.progress-wrap{flex:1;padding:0;min-width:0;order:3;}
@media(max-width:660px){.progress-wrap{padding:4px 16px;width:100%;flex:none;order:0;}}
.prog-bar{background:var(--bg3);border-radius:3px;height:4px;cursor:pointer;position:relative;margin-bottom:5px;-webkit-tap-highlight-color:transparent;touch-action:none;}
.prog-fill{background:linear-gradient(90deg,var(--amber),var(--amber2));height:100%;border-radius:3px;pointer-events:none;}
.prog-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:var(--amber2);border:2px solid var(--bg2);box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none;transition:transform .1s;}
.prog-bar:hover .prog-thumb,.prog-bar:active .prog-thumb{transform:translate(-50%,-50%) scale(1.3);}
.prog-times{display:flex;justify-content:space-between;font-size:10px;font-family:'DM Mono',monospace;color:var(--text3);}
.transport{display:flex;align-items:center;justify-content:center;gap:8px;padding:0;flex-shrink:0;order:2;}
@media(max-width:660px){.transport{padding:8px 16px 12px;order:0;}}
.t-btn{min-width:46px;min-height:46px;border-radius:50%;background:none;border:1px solid var(--border2);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;-webkit-tap-highlight-color:transparent;}
.t-btn:active{transform:scale(.91);}
.t-btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber);}
.t-btn.play-btn{min-width:58px;min-height:58px;background:var(--amber);border-color:var(--amber);color:#fff;}
.t-btn.play-btn:hover:not(:disabled){background:var(--amber2);border-color:var(--amber2);}
.t-btn:disabled{opacity:.2;cursor:not-allowed;}
.theme-btn{background:none;border:1px solid var(--border2);color:var(--text2);border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer;font-family:'DM Sans',sans-serif;display:flex;align-items:center;gap:5px;transition:all .15s;-webkit-tap-highlight-color:transparent;white-space:nowrap;margin-left:auto;}
.theme-btn:hover{border-color:var(--amber);color:var(--amber);}
.theme-dropdown{position:absolute;top:58px;right:12px;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.4);min-width:160px;}
.theme-option{padding:11px 16px;font-size:13px;cursor:pointer;transition:background .12s;display:flex;align-items:center;gap:8px;-webkit-tap-highlight-color:transparent;}
.theme-option:hover{background:var(--bg3);}
.theme-option.active{color:var(--amber);font-weight:600;}
.theme-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
/* Mobile: theme button becomes a plain colored circle */
.theme-btn-label{display:inline;}
.theme-btn-circle{display:none;width:22px;height:22px;border-radius:50%;flex-shrink:0;border:2px solid var(--border2);}
@media(max-width:660px){
  .theme-btn{padding:0;width:36px;height:36px;border-radius:50%;justify-content:center;border:none;}
  .theme-btn-label{display:none;}
  .theme-btn-circle{display:block;}
}
/* Install button */
.install-btn{display:flex;align-items:center;gap:4px;background:none;border:1px solid var(--border2);color:var(--text2);border-radius:6px;padding:4px 8px;font-size:10px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .15s;-webkit-tap-highlight-color:transparent;white-space:nowrap;}
.install-btn:hover{border-color:var(--amber);color:var(--amber);}
@media(max-width:660px){.install-btn{padding:4px 7px;font-size:10px;}}
/* iOS install modal */
.pwa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:flex-end;justify-content:center;}
.pwa-sheet{background:var(--bg2);border-radius:20px 20px 0 0;padding:24px 24px 40px;width:100%;max-width:480px;border:1px solid var(--border2);}
.pwa-sheet h2{font-family:'Syne',sans-serif;font-size:18px;font-weight:700;margin-bottom:6px;color:var(--text);}
.pwa-sheet p{font-size:12px;color:var(--text2);margin-bottom:20px;}
.pwa-steps{list-style:none;display:flex;flex-direction:column;gap:14px;margin-bottom:24px;}
.pwa-step{display:flex;align-items:flex-start;gap:12px;}
.pwa-step-num{min-width:26px;height:26px;border-radius:50%;background:var(--amber);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.pwa-step-text{font-size:13px;color:var(--text);line-height:1.5;padding-top:3px;}
.pwa-step-text b{color:var(--amber2);}
.pwa-hint{background:var(--bg3);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:20px;border:1px solid var(--border);}
.pwa-hint svg{flex-shrink:0;color:var(--amber);}
.pwa-hint span{font-size:11px;color:var(--text2);line-height:1.5;}
.pwa-lang{display:flex;align-items:center;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:3px;margin-left:auto;}
.pwa-lang button{background:none;border:none;color:var(--text2);font-size:11px;font-weight:600;font-family:'DM Mono',monospace;padding:3px 8px;border-radius:6px;cursor:pointer;transition:all .12s;-webkit-tap-highlight-color:transparent;}
.pwa-lang button.active{background:var(--amber);color:#fff;}
.pwa-sheet-header{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;}
.pwa-sheet-header h2{margin:0;flex:1;}
.pwa-close{width:100%;padding:13px;border-radius:10px;background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .15s;}
.pwa-close:hover{background:var(--bg4);}
`;

const fmt=s=>!s||isNaN(s)?"0:00":`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
const pitchLabel=s=>s===0?"±0":s>0?`+${s}`:`${s}`;

/* ─── Key Detection (Krumhansl-Schmuckler) ───────────────── */
/* In-place Cooley-Tukey radix-2 FFT (copied from pv-processor.js) */
function _fft(re:Float64Array,im:Float64Array,inv:boolean){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){
    let b=n>>1;
    for(;j&b;b>>=1) j^=b;
    j^=b;
    if(i<j){
      let t=re[i];re[i]=re[j];re[j]=t;
      t=im[i];im[i]=im[j];im[j]=t;
    }
  }
  const TP=2*Math.PI;
  for(let len=2;len<=n;len<<=1){
    const ang=(inv?1:-1)*TP/len;
    const wr=Math.cos(ang),wi=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let ur=1,ui=0;
      for(let j=0;j<len>>1;j++){
        const k=i+j+(len>>1);
        const ar=re[i+j],ai=im[i+j];
        const br=re[k]*ur-im[k]*ui;
        const bi=re[k]*ui+im[k]*ur;
        re[i+j]=ar+br;im[i+j]=ai+bi;
        re[k]=ar-br;im[k]=ai-bi;
        const t=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=t;
      }
    }
  }
}

/* 8192-sample window: bin width = sr/8192 ≈ 5.4 Hz @ 44100 Hz
   Enough to resolve semitones down to C2 (65 Hz) where adjacent semitones
   are ~4 Hz apart — the previous 4096 window (10.8 Hz) was too coarse. */
const CHROMA_N=8192;
const CHROMA_WIN=(()=>{
  const w=new Float32Array(CHROMA_N);
  for(let i=0;i<CHROMA_N;i++) w[i]=0.5*(1-Math.cos(2*Math.PI*i/(CHROMA_N-1)));
  return w;
})();

/* Krumhansl-Schmuckler key profiles */
const KS_MAJOR=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
/* Temperley (2007) MIREX profiles — better relative-major/minor separation */
const TEMP_MAJOR=[5.0,2.0,3.5,2.0,4.5,4.0,2.0,4.5,2.0,3.5,1.5,4.0];
const TEMP_MINOR=[5.0,2.0,3.5,4.5,2.0,4.0,2.0,4.5,3.5,2.0,1.5,4.0];

function _pearson(x:number[],y:number[]){
  let mx=0,my=0;
  for(let i=0;i<12;i++){mx+=x[i];my+=y[i];}
  mx/=12;my/=12;
  let num=0,dx=0,dy=0;
  for(let i=0;i<12;i++){
    const a=x[i]-mx,b=y[i]-my;
    num+=a*b;dx+=a*a;dy+=b*b;
  }
  const denom=Math.sqrt(dx*dy);
  return denom<1e-10?0:num/denom;
}

const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

async function detectKey(audioBuffer:AudioBuffer):Promise<{root:number,mode:'major'|'minor'}|null>{
  if(audioBuffer.duration<1) return null;

  const sr=audioBuffer.sampleRate;
  const maxSamples=audioBuffer.length;
  const mono=new Float32Array(maxSamples);
  const nc=audioBuffer.numberOfChannels;
  for(let c=0;c<nc;c++){
    const ch=audioBuffer.getChannelData(c);
    for(let i=0;i<maxSamples;i++) mono[i]+=ch[i]/nc;
  }

  const chroma=new Array(12).fill(0);
  let prevRms=0;
  const re=new Float64Array(CHROMA_N);
  const im=new Float64Array(CHROMA_N);
  /* No-overlap hop: at 8192 samples the freq resolution is already good;
     no-overlap keeps computation proportional to the old 4096/2048 scheme. */
  const hop=CHROMA_N;
  let totalWeight=0;
  let frameCount=0;

  const N2=CHROMA_N>>1;
  const mag=new Float64Array(N2+1);
  const kLo=Math.max(2,Math.ceil(65*CHROMA_N/sr));
  const kHi=Math.min(N2-1,Math.floor(5600*CHROMA_N/sr));
  /* Bass register upper limit (≤500 Hz) for extra tonic-root boost */
  const kBass=Math.min(N2-1,Math.floor(500*CHROMA_N/sr));

  for(let pos=0;pos+CHROMA_N<=maxSamples;pos+=hop){
    for(let i=0;i<CHROMA_N;i++){re[i]=mono[pos+i]*CHROMA_WIN[i];im[i]=0;}
    _fft(re,im,false);
    for(let k=0;k<=N2;k++) mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);

    /* Weight this frame by its RMS — chord-dense sections contribute more
       than silence / reverb tails / intro/outro instrumental pads. */
    let rms2=0;
    for(let i=0;i<CHROMA_N;i++) rms2+=mono[pos+i]*mono[pos+i];
    const rms=Math.sqrt(rms2/CHROMA_N);
    if(rms<1e-5){prevRms=rms;frameCount++;continue;}

    let mxf=0;
    for(let k=kLo;k<=kHi;k++) if(mag[k]>mxf) mxf=mag[k];
    if(mxf<1e-10){frameCount++;continue;}

    /* HPCP — Harmonic Pitch Class Profile (Gómez 2006):
       Each spectral peak is treated as the h-th harmonic of a lower
       fundamental; votes with weight 1/h² and a cosine detuning window. */
    const fc=new Array(12).fill(0);
    for(let k=kLo;k<=kHi;k++){
      if(mag[k]<=mag[k-1]||mag[k]<=mag[k+1]) continue;
      const m=mag[k]/mxf;
      if(m<0.01) continue;
      const f=k*sr/CHROMA_N;
      for(let h=1;h<=8;h++){
        const ff=f/h;
        if(ff<65||ff>700) continue;
        const midi=69+12*Math.log2(ff/440);
        const pc=((Math.round(midi)%12)+12)%12;
        const dev=midi-Math.round(midi);
        const cw=Math.cos(Math.PI*dev);
        if(cw<=0) continue;
        fc[pc]+=m*cw*cw/(h*h);
      }
    }

    /* Bass boost: for peaks ≤500 Hz add an extra h=1 direct contribution.
       The bass root note is the strongest key indicator; this counteracts
       upper-voice melody notes that would otherwise overpower it. */
    for(let k=kLo;k<=kBass;k++){
      if(mag[k]<=mag[k-1]||mag[k]<=mag[k+1]) continue;
      const m=mag[k]/mxf;
      if(m<0.01) continue;
      const f=k*sr/CHROMA_N;
      const midi=69+12*Math.log2(f/440);
      const pc=((Math.round(midi)%12)+12)%12;
      const dev=midi-Math.round(midi);
      const cw=Math.cos(Math.PI*dev);
      if(cw<=0) continue;
      fc[pc]+=m*cw*cw; /* extra h=1 weight for bass register */
    }

    /* Normalise frame chroma, then accumulate weighted by frame RMS */
    const ft=fc.reduce((a,b)=>a+b,0);
    if(ft>1e-6){
      const norm=fc.map(v=>v/ft);

      /* ── Chroma concentration weight ─────────────────────────────────
         Tonal frames (chord/melody) concentrate energy in a few bins →
         high peakedness. Metronome/noise frames spread energy flat across
         all 12 bins → peakedness ≈ 1. Weight by (peak/mean − 1) so truly
         flat frames contribute nearly nothing. */
      const mn=norm.reduce((a,b)=>a+b,0)/12;
      const pk=Math.max(...norm);
      const concentration=Math.max(0,pk/Math.max(mn,1e-9)-1);

      /* ── Transient onset suppression ─────────────────────────────────
         A sudden energy spike vs the previous frame signals a percussive
         onset (metronome click, drum hit). Down-weight by 60% when the
         current frame's RMS is more than 3× the previous frame's. */
      const transientPenalty=prevRms>1e-6&&rms/prevRms>3?0.4:1.0;

      const w=rms*concentration*transientPenalty;
      for(let i=0;i<12;i++) chroma[i]+=norm[i]*w;
      totalWeight+=w;
    }
    prevRms=rms;

    frameCount++;
    if(frameCount%32===0) await new Promise(r=>setTimeout(r,0));
  }

  if(totalWeight<1e-6) return null;
  for(let i=0;i<12;i++) chroma[i]/=totalWeight;

  /* Circular Gaussian smoothing — reduces FFT bin-boundary quantisation noise */
  const sc=new Array(12).fill(0);
  for(let i=0;i<12;i++) sc[i]=0.2*chroma[(i+11)%12]+0.6*chroma[i]+0.2*chroma[(i+1)%12];

  /* Ensemble: average Krumhansl-Schmuckler + Temperley correlations.
     KS alone is known to confuse relative major/minor pairs (e.g. Am vs C);
     Temperley profiles weight the tonic more distinctly, reducing that error. */
  let bestR=-Infinity,bestRoot=0,bestMode:'major'|'minor'='major';
  for(let root=0;root<12;root++){
    const ksM=Array.from({length:12},(_,i)=>KS_MAJOR[(i-root+12)%12]);
    const ksm=Array.from({length:12},(_,i)=>KS_MINOR[(i-root+12)%12]);
    const tpM=Array.from({length:12},(_,i)=>TEMP_MAJOR[(i-root+12)%12]);
    const tpm=Array.from({length:12},(_,i)=>TEMP_MINOR[(i-root+12)%12]);
    const rMaj=(_pearson(sc,ksM)+_pearson(sc,tpM))/2;
    const rMin=(_pearson(sc,ksm)+_pearson(sc,tpm))/2;
    if(rMaj>bestR){bestR=rMaj;bestRoot=root;bestMode='major';}
    if(rMin>bestR){bestR=rMin;bestRoot=root;bestMode='minor';}
  }
  return{root:bestRoot,mode:bestMode};
}

const keyLabel=(song:{detectedRoot:number|null,detectedMode:'major'|'minor'|null,pitch:number}):string|null=>{
  if(song.detectedRoot===null||song.detectedMode===null) return null;
  const root=((song.detectedRoot+song.pitch)%12+12)%12;
  if(song.detectedMode==='major') return NOTE_NAMES[root];
  const relMajor=NOTE_NAMES[(root+3)%12];
  return `${NOTE_NAMES[root]}m (${relMajor})`;
};

/* Simple semaphore to cap concurrent detection jobs */
let _detectingCount=0;
const MAX_DETECT=2;

/* ─── lamejs loader ──────────────────────────────────────── */
const loadLame=()=>new Promise<any>((resolve,reject)=>{
  if((window as any).lamejs){resolve((window as any).lamejs);return;}
  const s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
  s.crossOrigin='anonymous';
  s.onload=()=>resolve((window as any).lamejs);
  s.onerror=reject;
  document.head.appendChild(s);
});

const IconPrev=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>;
const IconNext=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z"/></svg>;
const IconPlay=()=><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>;
const IconPause=()=><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>;
const IconPlaySm=()=><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>;

/* Scrolls overflowing text after a pause so the full title is readable */
function MarqueeText({text,className}:{text:string,className?:string}){
  const ref=useRef<HTMLSpanElement>(null);
  const [dist,setDist]=useState(0);
  useEffect(()=>{
    const el=ref.current; if(!el) return;
    const measure=()=>setDist(Math.max(0,el.scrollWidth-el.clientWidth-1));
    measure();
    const ro=new ResizeObserver(measure); ro.observe(el);
    return()=>ro.disconnect();
  },[text]);
  return(
    <span ref={ref} className={className}
      style={dist>0?{textOverflow:'clip'}:undefined}>
      <span style={dist>0?{
        display:'inline-block',
        animation:`mq-scroll ${Math.max(6,3+dist/30)}s ease-in-out infinite`,
        ['--mq' as string]:'-'+dist+'px'
      } as React.CSSProperties:undefined}>{text}</span>
    </span>
  );
}

export default function WorshipSetlist() {
  const [songs,      setSongs]      = useState([]);
  const [activeIdx,  setActiveIdx]  = useState(null);
  const [playingIdx, setPlayingIdx] = useState(null);
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [duration,   setDuration]   = useState(0);
  const [dragOver,   setDragOver]   = useState(false);
  const [themeId,    setThemeId]    = useState(getSavedTheme);
  const [showThemes, setShowThemes] = useState(false);
  const [dragOverIdx,setDragOverIdx]= useState(null);
  const [exportingId,setExportingId]= useState<string|null>(null);
  const [keyDetecting,setKeyDetecting]= useState<Set<string>>(()=>new Set());
  const [canInstall,  setCanInstall]  = useState(()=>!isStandalone()&&(!!_installPrompt||isIOS()));
  const [showInstall, setShowInstall] = useState(false);
  const [installLang, setInstallLang] = useState<'en'|'id'>('en');

  const fileInputRef    = useRef(null);
  const actxRef         = useRef(null);
  const sourceRef       = useRef(null);  // kept for compat (unused by worklet path)
  const workletNodeRef  = useRef<AudioWorkletNode|null>(null);
  const workletReadyRef = useRef<Promise<void>|null>(null);
  /* MediaStream bridge — routes worklet audio through an <audio> element so
     iOS treats it as a real media player and keeps it alive in background. */
  const destNodeRef     = useRef<MediaStreamDestinationNode|null>(null);
  const audioOutRef     = useRef<HTMLAudioElement|null>(null);
  const startTimeRef    = useRef(0);
  const pausedAtRef     = useRef(0);
  const rafRef          = useRef(null);
  const durationRef     = useRef(0);
  const genRef          = useRef(0);
  const busyRef         = useRef(false);
  const dragSrcRef      = useRef(null);
  const floatRef        = useRef(null);
  const touchSrcIdx     = useRef(null);

  const songsRef      = useRef(songs);
  const activeIdxRef  = useRef(activeIdx);
  const playingIdxRef = useRef(playingIdx);
  const isPlayingRef  = useRef(isPlaying);
  useEffect(()=>{ songsRef.current=songs; },           [songs]);
  useEffect(()=>{ activeIdxRef.current=activeIdx; },   [activeIdx]);
  useEffect(()=>{ playingIdxRef.current=playingIdx; }, [playingIdx]);
  useEffect(()=>{ isPlayingRef.current=isPlaying; },   [isPlaying]);

  // Wire up the beforeinstallprompt callback so the install button appears
  // even if the event fired before the component mounted.
  useEffect(()=>{
    if(isStandalone()){ setCanInstall(false); return; }
    _onInstallReady=()=>setCanInstall(true);
    if(_installPrompt||isIOS()) setCanInstall(true);
    return()=>{ _onInstallReady=null; };
  },[]);

  // Resume AudioContext when app returns from background / screen-unlock
  useEffect(()=>{
    const onVisible=()=>{
      if(document.visibilityState==='visible'&&isPlayingRef.current){
        const ctx=actxRef.current;
        if(ctx&&ctx.state==='suspended') ctx.resume().catch(()=>{});
        /* Restart the audio-out element in case iOS paused it */
        if(audioOutRef.current?.paused) audioOutRef.current.play().catch(()=>{});
      }
    };
    document.addEventListener('visibilitychange',onVisible);
    return ()=>document.removeEventListener('visibilitychange',onVisible);
  },[]);

  // Spacebar → play/pause (desktop)
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if(e.code!=='Space') return;
      const tag=(e.target as HTMLElement).tagName;
      if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
      e.preventDefault();
      unlockAudio();
      if(isPlayingRef.current){
        const ctx=getCtx();
        pausedAtRef.current=Math.min(ctx.currentTime-startTimeRef.current,durationRef.current);
        stopSource(); audioOutRef.current?.pause(); setIsPlaying(false);
      } else {
        const idx=playingIdxRef.current??activeIdxRef.current;
        if(idx!==null) playFrom(idx,pausedAtRef.current);
      }
    };
    window.addEventListener('keydown',onKey,true);
    return ()=>window.removeEventListener('keydown',onKey,true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Media Session API — lock screen controls + background audio registration
  useEffect(()=>{
    if(!('mediaSession' in navigator)) return;
    const song = playingIdx!==null ? songs[playingIdx] : null;
    navigator.mediaSession.metadata = song
      ? new MediaMetadata({ title: song.name, artist: 'PitchList' })
      : null;
  }, [playingIdx, songs]);

  useEffect(()=>{
    if(!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  useEffect(()=>{
    if(!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', ()=>{
      if(!isPlayingRef.current) playFrom(playingIdxRef.current??0, pausedAtRef.current);
    });
    navigator.mediaSession.setActionHandler('pause', ()=>{
      if(isPlayingRef.current){
        const ctx=getCtx();
        pausedAtRef.current=Math.min(ctx.currentTime-startTimeRef.current,durationRef.current);
        stopSource(); audioOutRef.current?.pause(); setIsPlaying(false);
      }
    });
    navigator.mediaSession.setActionHandler('nexttrack', ()=>{
      const next = playingIdxRef.current;
      if(next===null) return;
      const n = next+1;
      if(n < songsRef.current.length) { setActiveIdx(n); setPlayingIdx(n); pausedAtRef.current=0; playFrom(n,0); }
    });
    navigator.mediaSession.setActionHandler('previoustrack', ()=>{
      const cur = playingIdxRef.current;
      if(cur===null) return;
      const p = cur-1;
      if(p >= 0) { setActiveIdx(p); setPlayingIdx(p); pausedAtRef.current=0; playFrom(p,0); }
      else { pausedAtRef.current=0; playFrom(cur,0); }
    });
    return ()=>{
      (['play','pause','nexttrack','previoustrack'] as MediaSessionAction[]).forEach(a=>{
        try{ navigator.mediaSession.setActionHandler(a,null); }catch{}
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Keep a stable ref to loadFiles so the SW message handler (mounted once) always calls the latest version
  const loadFilesRef = useRef<((files:FileList|File[])=>void)|null>(null);

  // Handle files shared into the app from other apps (Web Share Target — Android)
  useEffect(()=>{
    /* Read pending files from the share cache and import them */
    const importFromShareCache=async()=>{
      if(!('caches' in window)) return;
      try{
        const cache=await caches.open('pitchlist-share');
        const keys=await cache.keys();
        if(!keys.length) return;
        const files:File[]=[];
        for(const req of keys){
          const resp=await cache.match(req);
          if(!resp) continue;
          const blob=await resp.blob();
          const name=resp.headers.get('x-filename')||req.url.split('/').pop()||'audio';
          files.push(new File([blob],decodeURIComponent(name),{type:resp.headers.get('content-type')||blob.type}));
          await cache.delete(req);
        }
        if(files.length) loadFilesRef.current?.(files);
      }catch(e){ console.error('share-cache read failed',e); }
    };

    /* Check if we were opened via /share-target redirect */
    if(location.search.includes('shared=1')){
      history.replaceState(null,'',location.pathname);
      importFromShareCache();
    }

    /* Also handle the case where the app was already open when the share happened —
       the service worker posts a message instead of redirecting */
    const onMessage=(e:MessageEvent)=>{
      if(e.data?.type==='SHARE_RECEIVED') importFromShareCache();
    };
    navigator.serviceWorker?.addEventListener('message',onMessage);
    return()=>navigator.serviceWorker?.removeEventListener('message',onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

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
            detectedRoot:s.detectedRoot??null,detectedMode:s.detectedMode??null,
            cachedBuffer:null,cachedPitch:null,cachedTempo:null};
        }));
        const order=getSavedOrder();
        restored.sort((a,b)=>{
          const ai=order.indexOf(a.id), bi=order.indexOf(b.id);
          if(ai===-1&&bi===-1) return saved.findIndex(s=>s.id===a.id)-saved.findIndex(s=>s.id===b.id);
          if(ai===-1) return 1; if(bi===-1) return -1;
          return ai-bi;
        });
        setSongs(restored);
      }catch(e){ console.error('Restore failed:',e); }
    })();
  },[]);

  const getCtx=()=>{
    if(!actxRef.current||actxRef.current.state==="closed"){
      const ctx=new(window.AudioContext||window.webkitAudioContext)();
      /* When iOS suspends the context, immediately resume it.
         The <audio> element below (audioOutRef) is the real audio output and
         keeps the OS audio session alive, so resume() is honoured without
         a user gesture even on a locked screen. */
      ctx.onstatechange=()=>{
        if(ctx.state==='suspended'&&isPlayingRef.current) ctx.resume().catch(()=>{});
      };
      /* MediaStream bridge: worklet → destNode → <audio srcObject=stream>
         iOS treats the <audio> element as a proper media player so it
         continues running in the background / with the screen locked. */
      try{
        const dest=ctx.createMediaStreamDestination();
        const el=new Audio();
        el.srcObject=dest.stream;
        destNodeRef.current=dest;
        audioOutRef.current=el;
      }catch{ destNodeRef.current=null; audioOutRef.current=null; }
      actxRef.current=ctx;
    }
    return actxRef.current;
  };

  /* Register pv-processor.js once per AudioContext lifetime */
  const ensureWorklet=async()=>{
    const ctx=getCtx();
    if(!workletReadyRef.current)
      workletReadyRef.current=ctx.audioWorklet.addModule('/pv-processor.js');
    await workletReadyRef.current;
  };

  const stopSource=()=>{
    if(workletNodeRef.current){
      try{workletNodeRef.current.port.postMessage({t:'stop'});}catch{}
      workletNodeRef.current.disconnect(); workletNodeRef.current=null;
    }
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

  const playFrom=useCallback(async(idx,offset=0)=>{
    if(busyRef.current) return;
    busyRef.current=true;
    const song=songsRef.current[idx];
    if(!song){ busyRef.current=false; return; }
    stopSource();
    const ctx=getCtx(); if(ctx.state==="suspended") await ctx.resume();
    try{
      await ensureWorklet();
      const ab=song.audioBuffer;
      const numCh=ab.numberOfChannels;
      const tempoFactor=song.tempo/100;
      const outDuration=ab.duration/tempoFactor;

      /* Copy channel data so the AudioBuffer stays intact for export */
      const ch:Float32Array[]=[];
      for(let c=0;c<numCh;c++) ch.push(new Float32Array(ab.getChannelData(c)));

      const startSample=Math.round(offset*tempoFactor*ab.sampleRate);

      const node=new AudioWorkletNode(ctx,'pv-proc',{
        numberOfOutputs:1, outputChannelCount:[numCh]
      });
      node.parameters.get('pitch').value=song.pitch;
      node.parameters.get('tempo').value=tempoFactor;
      /* Transfer copies to worklet (zero-copy after slice above) */
      node.port.postMessage({t:'load',ch,s:startSample},ch.map(f=>f.buffer));

      const gen=++genRef.current;
      node.port.onmessage=({data})=>{
        if(data.t==='ended') advance();
      };

      /* Route through MediaStream bridge if available (iOS background audio),
         otherwise fall back to direct ctx.destination output. */
      if(destNodeRef.current){
        node.connect(destNodeRef.current);
        const el=audioOutRef.current;
        if(el&&el.paused) el.play().catch(()=>{ node.connect(ctx.destination); });
      } else {
        node.connect(ctx.destination);
      }
      workletNodeRef.current=node;
      durationRef.current=outDuration;
      setDuration(outDuration); setProgress(offset);
      startTimeRef.current=ctx.currentTime-offset;

      const advance=()=>{
        if(!isPlayingRef.current||genRef.current!==gen) return;
        const next=playingIdxRef.current+1;
        if(next<songsRef.current.length){setActiveIdx(next);setPlayingIdx(next);pausedAtRef.current=0;playFrom(next,0);}
        else{setIsPlaying(false);setPlayingIdx(null);setProgress(0);pausedAtRef.current=0;}
      };

      const tick=()=>{
        const el=ctx.currentTime-startTimeRef.current;
        setProgress(Math.min(el,durationRef.current));
        if(el<durationRef.current) rafRef.current=requestAnimationFrame(tick);
        else advance(); /* duration elapsed — go to next song */
      };
      rafRef.current=requestAnimationFrame(tick);
      setPlayingIdx(idx); setActiveIdx(idx); setIsPlaying(true);
    }catch(e){console.error(e);}
    finally{busyRef.current=false;}
  },[]);

  const handlePlayPause=()=>{
    unlockAudio();
    const ctx=getCtx();
    if(isPlaying){
      pausedAtRef.current=Math.min(ctx.currentTime-startTimeRef.current,durationRef.current);
      stopSource();
      audioOutRef.current?.pause();
      setIsPlaying(false);
    } else { playFrom(playingIdx??activeIdx??0,pausedAtRef.current); }
  };

  const handlePrev=()=>{const pi=playingIdx??activeIdx;if(pi!==null){pausedAtRef.current=0;playFrom(Math.max(0,pi-1),0);}};
  const handleNext=()=>{const pi=playingIdx??activeIdx;if(pi!==null&&pi+1<songs.length){pausedAtRef.current=0;playFrom(pi+1,0);}};

  const handleInstall=async()=>{
    if(isIOS()){ setShowInstall(true); return; }
    if(!_installPrompt) return;
    _installPrompt.prompt();
    const{outcome}=await _installPrompt.userChoice;
    if(outcome==='accepted'){ _installPrompt=null; setCanInstall(false); }
  };

  const handleProgressClick=e=>{
    if(playingIdx===null||duration===0) return;
    const rect=e.currentTarget.getBoundingClientRect();
    const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    pausedAtRef.current=ratio*duration; playFrom(playingIdx,pausedAtRef.current);
  };

  const handleScrubStart=e=>{
    if(playingIdx===null||duration===0) return;
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
      if(wasPlaying) playFrom(playingIdx,pausedAtRef.current);
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
      if(playingIdx===from) setPlayingIdx(to);
      else if(playingIdx>from&&playingIdx<=to) setPlayingIdx(i=>i-1);
      else if(playingIdx<from&&playingIdx>=to) setPlayingIdx(i=>i+1);
      saveOrder(next);
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
      if(playingIdx===from) setPlayingIdx(to);
      else if(playingIdx>from&&playingIdx<=to) setPlayingIdx(i=>i-1);
      else if(playingIdx<from&&playingIdx>=to) setPlayingIdx(i=>i+1);
      saveOrder(next);
      return next;
    });
  };

  const updateSong=(id,key,val)=>{
    setSongs(prev=>prev.map(s=>{
      if(s.id!==id) return s;
      const updated={...s,[key]:val};
      openDB().then(db=>{
        const store=db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE);
        const req=store.get(id);
        req.onsuccess=e=>{ if(e.target.result) store.put({...e.target.result,pitch:updated.pitch,tempo:updated.tempo}); };
      }).catch(()=>{});
      return updated;
    }));
    /* If this song is currently playing, update worklet AudioParams instantly */
    const isActive=songsRef.current[playingIdxRef.current]?.id===id;
    if(isActive&&workletNodeRef.current){
      const song=songsRef.current.find(s=>s.id===id);
      if(!song) return;
      const updated={...song,[key]:val};
      workletNodeRef.current.parameters.get('pitch').value=updated.pitch;
      const tf=updated.tempo/100;
      workletNodeRef.current.parameters.get('tempo').value=tf;
      /* Recalculate output duration when tempo changes */
      const newDur=updated.audioBuffer.duration/tf;
      durationRef.current=newDur; setDuration(newDur);
    }
  };

  const exportSong=useCallback(async(song)=>{
    setExportingId(song.id);
    try{
      const tempoFactor=song.tempo/100;
      const ab=song.audioBuffer;
      const nc=ab.numberOfChannels;
      const sr=ab.sampleRate;
      /* Add 2 s headroom; the worklet returns false when done, rest is silence */
      const outLen=Math.ceil(ab.length/tempoFactor)+sr*2;

      /* Render offline through the same AudioWorklet */
      const octx=new OfflineAudioContext(nc,outLen,sr);
      await octx.audioWorklet.addModule('/pv-processor.js');
      const node=new AudioWorkletNode(octx,'pv-proc',{
        numberOfOutputs:1,outputChannelCount:[nc]
      });
      node.parameters.get('pitch').value=song.pitch;
      node.parameters.get('tempo').value=tempoFactor;
      const ch:Float32Array[]=[];
      for(let c=0;c<nc;c++) ch.push(new Float32Array(ab.getChannelData(c)));
      node.port.postMessage({t:'load',ch,s:0},ch.map(f=>f.buffer));
      node.connect(octx.destination);

      const rendered=await octx.startRendering();

      /* Trim trailing silence */
      const ch0=rendered.getChannelData(0);
      let trimAt=rendered.length;
      for(let i=rendered.length-1;i>=0;i--){
        if(Math.abs(ch0[i])>1e-6){trimAt=Math.min(i+512,rendered.length);break;}
      }

      /* Encode to MP3 via lamejs */
      const lame=await loadLame();
      const enc=new lame.Mp3Encoder(nc,sr,128);
      const BLOCK=1152;
      const chunks:Uint8Array[]=[];
      const leftF=rendered.getChannelData(0);
      const rightF=nc>1?rendered.getChannelData(1):leftF;
      const L=new Int16Array(BLOCK), R=new Int16Array(BLOCK);
      for(let i=0;i<trimAt;i+=BLOCK){
        const end=Math.min(i+BLOCK,trimAt), len=end-i;
        for(let j=0;j<len;j++){
          L[j]=Math.max(-32768,Math.min(32767,leftF[i+j]*32767));
          R[j]=Math.max(-32768,Math.min(32767,rightF[i+j]*32767));
        }
        const c=enc.encodeBuffer(L.subarray(0,len),R.subarray(0,len));
        if(c.length) chunks.push(new Uint8Array(c));
      }
      const tail=enc.flush(); if(tail.length) chunks.push(new Uint8Array(tail));

      const blob=new Blob(chunks,{type:'audio/mpeg'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      const suffix=(song.pitch!==0?`_${song.pitch>0?'+':''}${song.pitch}st`:'')
                  +(song.tempo!==100?`_${song.tempo}pct`:'');
      a.href=url; a.download=`${song.name}${suffix}.mp3`;
      a.click(); URL.revokeObjectURL(url);
    }catch(e){console.error('Export failed:',e);alert('Export failed. See console for details.');}
    finally{setExportingId(null);}
  },[]);

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
            pitch:0,tempo:100,detectedRoot:null,detectedMode:null};
        })
    );
    setSongs(prev=>{
      const next=[...prev,...loaded];
      loaded.forEach(s=>{
        const arrayBuffer=audioBufferToArrayBuffer(s.audioBuffer);
        dbPut({id:s.id,name:s.name,arrayBuffer,pitch:s.pitch,tempo:s.tempo,detectedRoot:null,detectedMode:null}).catch(()=>{});
      });
      saveOrder(next);
      return next;
    });
    /* Fire key detection for each new song (rate-limited) */
    loaded.forEach(song=>{
      setKeyDetecting(prev=>new Set(prev).add(song.id));
      const run=async()=>{
        while(_detectingCount>=MAX_DETECT) await new Promise(r=>setTimeout(r,200));
        _detectingCount++;
        try{
          const result=await detectKey(song.audioBuffer);
          if(result){
            setSongs(prev=>{
              if(!prev.find(s=>s.id===song.id)) return prev;
              return prev.map(s=>s.id===song.id?{...s,detectedRoot:result.root,detectedMode:result.mode}:s);
            });
            dbPatchKey(song.id,result.root,result.mode).catch(()=>{});
          }
        }catch(e){console.warn('Key detection failed:',e);}
        finally{
          _detectingCount--;
          setKeyDetecting(prev=>{const n=new Set(prev);n.delete(song.id);return n;});
        }
      };
      run();
    });
  };
  loadFilesRef.current=loadFiles;

  const removeSong=(id,e)=>{
    e.stopPropagation();
    dbDelete(id).catch(()=>{});
    setSongs(prev=>{
      const ri=prev.findIndex(s=>s.id===id);
      const next=prev.filter(s=>s.id!==id);
      if(activeIdx===ri){setActiveIdx(null);}
      else if(activeIdx>ri) setActiveIdx(i=>i-1);
      if(playingIdx===ri){stopSource();setIsPlaying(false);setPlayingIdx(null);setProgress(0);}
      else if(playingIdx>ri) setPlayingIdx(i=>i-1);
      saveOrder(next);
      return next;
    });
  };

  const currentSong=playingIdx!==null?songs[playingIdx]:null;
  const pct=duration>0?(progress/duration)*100:0;

  return(
    <>
      <style>{STYLE}</style>
      <div className="app">
        <header className="header">
          <h1>PitchList</h1>
          {showInstall&&(()=>{
            const en={
              title:'Install PitchList',
              sub:'Add to your Home Screen for the best experience — fullscreen, offline, and ready instantly.',
              steps:[
                <><b>Tap the Share</b> button <svg style={{verticalAlign:'middle'}} width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h3v2H6v11h12V10h-3V8h3a2 2 0 0 1 2 2z"/></svg> in Safari's toolbar at the bottom of your screen</>,
                <>Scroll down in the share sheet and tap <b>"Add to Home Screen"</b></>,
                <>Tap <b>"Add"</b> in the top-right corner to confirm</>,
              ],
              hint:<>Make sure you're using <b>Safari</b> — this won't work in Chrome or other browsers on iPhone.</>,
              close:'Got it',
            };
            const id={
              title:'Pasang PitchList',
              sub:'Tambahkan ke Layar Utama untuk pengalaman terbaik — layar penuh, bisa offline, dan langsung siap.',
              steps:[
                <><b>Ketuk tombol Bagikan</b> <svg style={{verticalAlign:'middle'}} width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h3v2H6v11h12V10h-3V8h3a2 2 0 0 1 2 2z"/></svg> di toolbar Safari bagian bawah layar</>,
                <>Gulir ke bawah pada lembar berbagi, lalu ketuk <b>"Tambahkan ke Layar Utama"</b></>,
                <>Ketuk <b>"Tambahkan"</b> di pojok kanan atas untuk mengonfirmasi</>,
              ],
              hint:<>Pastikan kamu menggunakan <b>Safari</b> — fitur ini tidak tersedia di Chrome atau browser lain di iPhone.</>,
              close:'Mengerti',
            };
            const t=installLang==='id'?id:en;
            return(
            <div className="pwa-overlay" onClick={()=>setShowInstall(false)}>
              <div className="pwa-sheet" onClick={e=>e.stopPropagation()}>
                <div className="pwa-sheet-header">
                  <h2>{t.title}</h2>
                  <div className="pwa-lang">
                    <button className={installLang==='en'?'active':''} onClick={()=>setInstallLang('en')}>EN</button>
                    <button className={installLang==='id'?'active':''} onClick={()=>setInstallLang('id')}>ID</button>
                  </div>
                </div>
                <p>{t.sub}</p>
                <ul className="pwa-steps">
                  {t.steps.map((step,i)=>(
                    <li key={i} className="pwa-step">
                      <div className="pwa-step-num">{i+1}</div>
                      <div className="pwa-step-text">{step}</div>
                    </li>
                  ))}
                </ul>
                <div className="pwa-hint">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                  <span>{t.hint}</span>
                </div>
                <button className="pwa-close" onClick={()=>setShowInstall(false)}>{t.close}</button>
              </div>
            </div>
            );
          })()}
          {canInstall&&(
            <button className="install-btn" onClick={handleInstall} title="Install app">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5v-2z"/></svg>
              Install
            </button>
          )}
          {(()=>{const t=THEMES.find(t=>t.id===themeId)||THEMES[0];return(
          <button className="theme-btn" onClick={e=>{e.stopPropagation();setShowThemes(p=>!p)}} title="Change theme">
            <span className="theme-btn-label">🎨 Theme</span>
            <span className="theme-btn-circle" style={{background:t.vars['--amber']}}/>
          </button>
          );})()}
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
              <button className="add-btn" onClick={()=>fileInputRef.current?.click()}>+ Add Songs</button>
              <input ref={fileInputRef} type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.mp4,.caf"
                multiple style={{display:"none"}}
                onChange={e=>{loadFiles(e.target.files);e.target.value="";}}/>
            </div>

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
                          <div className="song-num">{idx===playingIdx&&isPlaying?<IconPlaySm/>:idx+1}</div>
                          <MarqueeText className="song-name" text={song.name}/>
                          <div className="song-badges">
                            {keyLabel(song)?(
                              <span className="badge key">Key: {keyLabel(song)}</span>
                            ):keyDetecting.has(song.id)?(
                              <span className="badge neutral" style={{fontSize:9}}>key…</span>
                            ):null}
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
                                onClick={e=>{e.stopPropagation();pausedAtRef.current=0;playFrom(idx,0);}}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                Play
                              </button>
                              <button className="export-btn"
                                disabled={exportingId===song.id}
                                onClick={e=>{e.stopPropagation();exportSong(song);}}>
                                {exportingId===song.id?(
                                  <>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                                    Exporting…
                                  </>
                                ):(
                                  <>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                    MP3
                                  </>
                                )}
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
                    songs.forEach(s=>{ dbDelete(s.id).catch(()=>{}); });
                    saveOrder([]); setSongs([]);
                  }}>Clear Setlist</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Player — bottom bar */}
        <div className="player-panel">
            <div className="now-playing">
              <div className="vinyl-wrap">
                <div className={`vinyl${isPlaying?" spin":""}`}/>
                <div className="vinyl-label">🎵</div>
              </div>
              {currentSong?(
                <div className="np-info">
                  <div className="np-eyebrow">
                    Now Playing · {playingIdx+1}/{songs.length}
                    {keyLabel(currentSong)&&<> · <span style={{color:'var(--amber3)'}}>Key: {keyLabel(currentSong)}</span></>}
                  </div>
                  <MarqueeText className="np-title" text={currentSong.name}/>
                  <div className="np-badges">
                    {keyLabel(currentSong)&&<div className="np-badge" style={{color:'var(--amber3)',borderColor:'var(--amber)'}}>Key: {keyLabel(currentSong)}</div>}
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
              <button tabIndex={-1} className="t-btn" onClick={handlePrev} disabled={songs.length===0||(playingIdx??activeIdx??-1)<=0}><IconPrev/></button>
              <button tabIndex={-1} className="t-btn play-btn"
                onClick={songs.length>0?handlePlayPause:undefined}
                disabled={songs.length===0}>
                {isPlaying?<IconPause/>:<IconPlay/>}
              </button>
              <button tabIndex={-1} className="t-btn" onClick={handleNext} disabled={songs.length===0||(playingIdx??activeIdx??-1)>=songs.length-1}><IconNext/></button>
            </div>
          </div>
      </div>
    </>
  );
}
