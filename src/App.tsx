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

/* ─── Phase Vocoder — chunked async (yields every CHUNK hops) ─ */
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

/* ─── Styles ─────────────────────────────────────────────── */
const STYLE=`
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0c0b08;--bg2:#131108;--bg3:#1a180f;--bg4:#201e14;
  --border:#2a2718;--border2:#3a3620;
  --text:#f2ead8;--text2:#8a8070;--text3:#5a5448;
  --amber:#d4881a;--amber2:#f0a030;--amber3:#ffc060;--red:#c0392b;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.header{flex-shrink:0;height:54px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--bg2);}
.logo{font-size:18px;opacity:.7;}
.header h1{font-family:'Playfair Display',serif;font-size:19px;letter-spacing:-.3px;}
.header-sub{font-size:11px;color:var(--text2);font-weight:300;margin-left:2px;}
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
.songs-scroll{flex:1;overflow-y:auto;padding:8px;}
.songs-scroll::-webkit-scrollbar{width:3px;}
.songs-scroll::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
.song-item{background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;cursor:pointer;transition:border-color .15s;overflow:hidden;-webkit-tap-highlight-color:transparent;}
.song-item:hover{border-color:var(--border2);}
.song-item.active{border-color:var(--amber);background:var(--bg3);}
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
.drop-zone{margin:8px;border:1px dashed var(--border2);border-radius:10px;padding:22px 14px;text-align:center;color:var(--text3);transition:all .2s;cursor:pointer;}
.drop-zone.over{border-color:var(--amber);color:var(--amber);background:rgba(212,136,26,.05);}
.drop-icon{font-size:24px;opacity:.4;margin-bottom:6px;}
.drop-zone p{font-size:12px;line-height:1.6;}
.pl-footer{flex-shrink:0;padding:7px 14px;border-top:1px solid var(--border);font-size:10px;color:var(--text3);font-family:'DM Mono',monospace;background:var(--bg);text-align:center;}
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
.np-title{font-family:'Playfair Display',serif;font-size:17px;line-height:1.3;}
.np-empty{color:var(--text3);font-size:12px;font-style:italic;}
.np-badges{display:flex;gap:5px;margin-top:3px;flex-wrap:wrap;}
.np-badge{padding:3px 9px;border-radius:20px;background:var(--bg3);border:1px solid var(--border2);font-size:10px;font-family:'DM Mono',monospace;color:var(--amber2);}
.progress-wrap{padding:5px 16px;}
.prog-bar{background:var(--bg3);border-radius:3px;height:4px;cursor:pointer;position:relative;margin-bottom:5px;-webkit-tap-highlight-color:transparent;}
.prog-fill{background:linear-gradient(90deg,var(--amber),var(--amber2));height:100%;border-radius:3px;pointer-events:none;}
.prog-times{display:flex;justify-content:space-between;font-size:10px;font-family:'DM Mono',monospace;color:var(--text3);}
.transport{padding:8px 16px 16px;display:flex;align-items:center;justify-content:center;gap:10px;}
.t-btn{min-width:46px;min-height:46px;border-radius:50%;background:none;border:1px solid var(--border2);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;-webkit-tap-highlight-color:transparent;}
.t-btn:active{transform:scale(.91);}
.t-btn:hover:not(:disabled){border-color:var(--amber);color:var(--amber);}
.t-btn.play-btn{min-width:58px;min-height:58px;font-size:20px;background:var(--amber);border-color:var(--amber);color:#fff;}
.t-btn.play-btn:hover:not(:disabled){background:var(--amber2);border-color:var(--amber2);}
.t-btn:disabled{opacity:.2;cursor:not-allowed;}
.proc-wrap{padding:4px 16px;}
.proc-label{font-size:10px;color:var(--text2);text-align:center;margin-bottom:4px;font-family:'DM Mono',monospace;}
.proc-track{background:var(--bg3);border-radius:3px;height:3px;overflow:hidden;}
.proc-inner{height:100%;background:var(--amber);border-radius:3px;transition:width .15s linear;}
`;

const fmt = s => !s||isNaN(s)?"0:00":`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
const pitchLabel = s => s===0?"±0":s>0?`+${s}`:`${s}`;

export default function WorshipSetlist() {
  const [songs,      setSongs]      = useState([]);
  const [activeIdx,  setActiveIdx]  = useState(null);
  const [isPlaying,  setIsPlaying]  = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [duration,   setDuration]   = useState(0);
  const [processing, setProcessing] = useState(false);
  const [procPct,    setProcPct]    = useState(0);
  const [dragOver,   setDragOver]   = useState(false);

  const fileInputRef = useRef(null);
  const actxRef      = useRef(null);
  const sourceRef    = useRef(null);
  const startTimeRef = useRef(0);
  const pausedAtRef  = useRef(0);
  const rafRef       = useRef(null);
  const durationRef  = useRef(0);

  const songsRef     = useRef(songs);
  const activeIdxRef = useRef(activeIdx);
  const isPlayingRef = useRef(isPlaying);
  useEffect(()=>{ songsRef.current=songs; },         [songs]);
  useEffect(()=>{ activeIdxRef.current=activeIdx; }, [activeIdx]);
  useEffect(()=>{ isPlayingRef.current=isPlaying; }, [isPlaying]);

  const getCtx = () => {
    if (!actxRef.current || actxRef.current.state==="closed")
      actxRef.current = new (window.AudioContext||window.webkitAudioContext)();
    return actxRef.current;
  };

  const stopSource = () => {
    if (sourceRef.current){try{sourceRef.current.stop();}catch{}sourceRef.current.disconnect();sourceRef.current=null;}
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const getProcessedBuffer = useCallback(async (song) => {
    // Cache hit
    if (song.cachedBuffer && song.cachedPitch===song.pitch && song.cachedTempo===song.tempo)
      return song.cachedBuffer;
    // No-op
    if (song.pitch===0 && song.tempo===100) return song.audioBuffer;

    const ab=song.audioBuffer, numCh=ab.numberOfChannels;
    const pitchFactor=Math.pow(2,song.pitch/12), tempoFactor=song.tempo/100;

    // Chunked Phase Vocoder stretch — releases UI every 64 hops
    setProcPct(0);
    const stretched = await pvStretchAsync(ab, pitchFactor/tempoFactor, p=>setProcPct(p));
    setProcPct(0.95);

    // Offline resample to apply pitch shift & correct duration
    const outLen = Math.max(1, Math.round(ab.length/tempoFactor));
    const offCtx = new OfflineAudioContext(numCh, outLen, ab.sampleRate);
    const strBuf = offCtx.createBuffer(numCh, stretched[0].length, ab.sampleRate);
    for(let c=0;c<numCh;c++) strBuf.copyToChannel(stretched[c],c);
    const src=offCtx.createBufferSource();
    src.buffer=strBuf; src.playbackRate.value=pitchFactor;
    src.connect(offCtx.destination); src.start(0);
    const rendered=await offCtx.startRendering();
    setProcPct(1);

    setSongs(prev=>prev.map(s=>s.id===song.id
      ?{...s,cachedBuffer:rendered,cachedPitch:song.pitch,cachedTempo:song.tempo}:s));
    return rendered;
  },[]);

  const playFrom = useCallback(async (idx, offset=0) => {
    const song=songsRef.current[idx]; if(!song) return;
    setProcessing(true); stopSource();
    const ctx=getCtx(); if(ctx.state==="suspended") await ctx.resume();
    try {
      const buffer=await getProcessedBuffer(song);
      durationRef.current=buffer.duration;
      setDuration(buffer.duration); setProgress(offset);
      const src=ctx.createBufferSource();
      src.buffer=buffer; src.connect(ctx.destination); src.start(0,offset);
      startTimeRef.current=ctx.currentTime-offset; sourceRef.current=src;
      src.onended=()=>{
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
    } catch(e){console.error(e);}
    finally{setProcessing(false); setProcPct(0);}
  },[getProcessedBuffer]);

  const handlePlayPause=()=>{
    if(processing) return;
    const ctx=getCtx();
    if(isPlaying){
      pausedAtRef.current=Math.min(ctx.currentTime-startTimeRef.current,durationRef.current);
      stopSource(); setIsPlaying(false);
    } else { playFrom(activeIdx??0, pausedAtRef.current); }
  };

  const handlePrev=()=>{if(activeIdx!==null){pausedAtRef.current=0;playFrom(Math.max(0,activeIdx-1),0);}};
  const handleNext=()=>{if(activeIdx!==null&&activeIdx+1<songs.length){pausedAtRef.current=0;playFrom(activeIdx+1,0);}};

  const handleProgressClick=e=>{
    if(activeIdx===null||duration===0) return;
    const rect=e.currentTarget.getBoundingClientRect();
    const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    pausedAtRef.current=ratio*duration; playFrom(activeIdx,pausedAtRef.current);
  };

  const updateSong=(id,key,val)=>setSongs(prev=>prev.map(s=>s.id===id?{...s,[key]:val}:s));

  const loadFiles=async files=>{
    const ctx=getCtx();
    const loaded=await Promise.all(
      Array.from(files)
        .filter(f=>f.type.startsWith("audio/")||/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name))
        .map(async file=>{
          const ab=await file.arrayBuffer();
          const audioBuffer=await ctx.decodeAudioData(ab);
          return{id:Math.random().toString(36).slice(2,9),
            name:file.name.replace(/\.[^.]+$/,""),audioBuffer,
            pitch:0,tempo:100,cachedBuffer:null,cachedPitch:null,cachedTempo:null};
        })
    );
    setSongs(prev=>[...prev,...loaded]);
  };

  const removeSong=(id,e)=>{
    e.stopPropagation();
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

  return (
    <>
      <style>{STYLE}</style>
      <div className="app">
        <header className="header">
          <span className="logo">🎵</span>
          <h1>Worship Setlist</h1>
          <span className="header-sub">— pitch &amp; tempo studio</span>
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
              <input ref={fileInputRef} type="file" accept="audio/*" multiple style={{display:"none"}}
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
                      <div key={song.id} className={`song-item${isActive?" active":""}`}
                        onClick={()=>{pausedAtRef.current=0;playFrom(idx,0);}}>
                        <div className="song-row">
                          <div className="song-num">{isActive&&isPlaying?"▶":idx+1}</div>
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
            <div className="pl-footer">
              {songs.length>0?`${songs.length} song${songs.length!==1?"s":""} · tap to play & adjust`:"no songs loaded"}
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
                  <div className="np-eyebrow">Worship Setlist</div>
                  <p className="np-empty">{songs.length===0?"Add songs to get started":"Tap a song to play"}</p>
                </div>
              )}
            </div>

            {processing&&(
              <div className="proc-wrap">
                <div className="proc-label">Processing… {Math.round(procPct*100)}%</div>
                <div className="proc-track">
                  <div className="proc-inner" style={{width:`${procPct*100}%`}}/>
                </div>
              </div>
            )}

            <div className="progress-wrap">
              <div className="prog-bar" onClick={handleProgressClick}>
                <div className="prog-fill" style={{width:`${pct}%`}}/>
              </div>
              <div className="prog-times"><span>{fmt(progress)}</span><span>{fmt(duration)}</span></div>
            </div>

            <div className="transport">
              <button className="t-btn" onClick={handlePrev} disabled={!currentSong||activeIdx===0}>⏮</button>
              <button className="t-btn play-btn"
                onClick={songs.length>0?handlePlayPause:undefined}
                disabled={songs.length===0||processing}>
                {isPlaying?"⏸":"▶"}
              </button>
              <button className="t-btn" onClick={handleNext} disabled={!currentSong||activeIdx>=songs.length-1}>⏭</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}