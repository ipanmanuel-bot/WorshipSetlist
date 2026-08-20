/* public/key-worker.js
   HPCP key detection — runs entirely off the main thread.
   Receives: { jobId, mono: Float32Array, sr: number }
   Posts back: { jobId, result: {root, mode} | null } */

const CHROMA_N=8192;
const CHROMA_WIN=(()=>{
  const w=new Float32Array(CHROMA_N);
  for(let i=0;i<CHROMA_N;i++) w[i]=0.5*(1-Math.cos(2*Math.PI*i/(CHROMA_N-1)));
  return w;
})();

const KS_MAJOR=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const TEMP_MAJOR=[5.0,2.0,3.5,2.0,4.5,4.0,2.0,4.5,2.0,3.5,1.5,4.0];
const TEMP_MINOR=[5.0,2.0,3.5,4.5,2.0,4.0,2.0,4.5,3.5,2.0,1.5,4.0];

function _fft(re,im,inv){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){
    let b=n>>1;
    for(;j&b;b>>=1) j^=b;
    j^=b;
    if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
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
        const br=re[k]*ur-im[k]*ui,bi=re[k]*ui+im[k]*ur;
        re[i+j]=ar+br;im[i+j]=ai+bi;
        re[k]=ar-br;im[k]=ai-bi;
        const t=ur*wr-ui*wi;ui=ur*wi+ui*wr;ur=t;
      }
    }
  }
}

function _pearson(x,y){
  let mx=0,my=0;
  for(let i=0;i<12;i++){mx+=x[i];my+=y[i];}
  mx/=12;my/=12;
  let num=0,dx=0,dy=0;
  for(let i=0;i<12;i++){const a=x[i]-mx,b=y[i]-my;num+=a*b;dx+=a*a;dy+=b*b;}
  const denom=Math.sqrt(dx*dy);
  return denom<1e-10?0:num/denom;
}

function scoreChroma(ch){
  const sc=new Array(12).fill(0);
  for(let i=0;i<12;i++) sc[i]=0.2*ch[(i+11)%12]+0.6*ch[i]+0.2*ch[(i+1)%12];
  const scores=[];
  for(let root=0;root<12;root++){
    const ksM=Array.from({length:12},(_,i)=>KS_MAJOR[(i-root+12)%12]);
    const ksm=Array.from({length:12},(_,i)=>KS_MINOR[(i-root+12)%12]);
    const tpM=Array.from({length:12},(_,i)=>TEMP_MAJOR[(i-root+12)%12]);
    const tpm=Array.from({length:12},(_,i)=>TEMP_MINOR[(i-root+12)%12]);
    const rMaj=(_pearson(sc,ksM)+_pearson(sc,tpM))/2;
    const rMin=(_pearson(sc,ksm)+_pearson(sc,tpm))/2;
    scores.push({root,mode:'major',score:rMaj});
    scores.push({root,mode:'minor',score:rMin});
  }
  scores.sort((a,b)=>b.score-a.score);
  let best=scores[0];
  /* Fifth-error correction: detectors commonly pick the dominant (V) instead
     of the tonic (I) because every root's 3rd harmonic is a perfect fifth up
     and V chords are used heavily. If a same-mode candidate a perfect fifth
     BELOW the winner scores within FIFTH_TOL, prefer it — that's the tonic.
     Also handles E/B: those keys differ by only one scale note (A vs A#),
     so their raw scores land very close and small biases flip the winner. */
  const FIFTH_TOL=0.05;
  for(let i=1;i<scores.length;i++){
    const c=scores[i];
    if(c.mode!==best.mode) continue;
    if(((best.root-c.root+12)%12)===7&&(best.score-c.score)<FIFTH_TOL){ best=c; break; }
  }
  return{root:best.root,mode:best.mode};
}

function detectKeyFromMono(mono,sr){
  if(mono.length<sr) return null; // < 1 second

  const re=new Float64Array(CHROMA_N);
  const im=new Float64Array(CHROMA_N);
  const hop=CHROMA_N;
  const N2=CHROMA_N>>1;
  const mag=new Float64Array(N2+1);
  const kLo=Math.max(2,Math.ceil(65*CHROMA_N/sr));
  const kHi=Math.min(N2-1,Math.floor(5600*CHROMA_N/sr));
  const kBass=Math.min(N2-1,Math.floor(500*CHROMA_N/sr));

  const BLOCK_FRAMES=Math.ceil(60*sr/CHROMA_N);
  const analysisStart=Math.floor(mono.length*0.05);

  let blockChroma=new Array(12).fill(0),blockW=0,blockF=0;
  const globalChroma=new Array(12).fill(0);let globalW=0;
  let prevBlockKey='';
  let prevRms=0;

  for(let pos=analysisStart;pos+CHROMA_N<=mono.length;pos+=hop){
    /* ── Compute FFT once per frame ─── */
    for(let i=0;i<CHROMA_N;i++){re[i]=mono[pos+i]*CHROMA_WIN[i];im[i]=0;}
    _fft(re,im,false);
    for(let k=0;k<=N2;k++) mag[k]=Math.sqrt(re[k]*re[k]+im[k]*im[k]);

    let rms2=0;
    for(let i=0;i<CHROMA_N;i++) rms2+=mono[pos+i]*mono[pos+i];
    const rms=Math.sqrt(rms2/CHROMA_N);

    if(rms<1e-5){
      prevRms=rms;
    } else {
      let mxf=0;
      for(let k=kLo;k<=kHi;k++) if(mag[k]>mxf) mxf=mag[k];
      if(mxf>=1e-10){
        const fc=new Array(12).fill(0);
        for(let k=kLo;k<=kHi;k++){
          if(mag[k]<=mag[k-1]||mag[k]<=mag[k+1]) continue;
          const m=mag[k]/mxf; if(m<0.01) continue;
          const f=k*sr/CHROMA_N;
          for(let h=1;h<=8;h++){
            const ff=f/h; if(ff<65||ff>700) continue;
            const midi=69+12*Math.log2(ff/440);
            const pc=((Math.round(midi)%12)+12)%12;
            const dev=midi-Math.round(midi);
            const cw=Math.cos(Math.PI*dev); if(cw<=0) continue;
            fc[pc]+=m*cw*cw/(h*h);
          }
        }
        for(let k=kLo;k<=kBass;k++){
          if(mag[k]<=mag[k-1]||mag[k]<=mag[k+1]) continue;
          const m=mag[k]/mxf; if(m<0.01) continue;
          const f=k*sr/CHROMA_N;
          const midi=69+12*Math.log2(f/440);
          const pc=((Math.round(midi)%12)+12)%12;
          const dev=midi-Math.round(midi);
          const cw=Math.cos(Math.PI*dev); if(cw<=0) continue;
          fc[pc]+=m*cw*cw;
        }
        const ft=fc.reduce((a,b)=>a+b,0);
        if(ft>1e-6){
          const norm=fc.map(v=>v/ft);
          const mn=norm.reduce((a,b)=>a+b,0)/12;
          const pk=Math.max(...norm);
          const concentration=Math.max(0,pk/Math.max(mn,1e-9)-1);
          const transientPenalty=prevRms>1e-6&&rms/prevRms>3?0.4:1.0;
          const w=rms*concentration*transientPenalty;
          /* ── Accumulate into both block and global in one pass ── */
          for(let i=0;i<12;i++){
            blockChroma[i]+=norm[i]*w;
            globalChroma[i]+=norm[i]*w;
          }
          blockW+=w;
          globalW+=w;
        }
        prevRms=rms;
      }
      /* if mxf<1e-10: prevRms intentionally not updated (preserve last good rms) */
    }

    blockF++;
    if(blockF>=BLOCK_FRAMES){
      if(blockW>1e-6){
        const bc=blockChroma.map(v=>v/blockW);
        const{root,mode}=scoreChroma(bc);
        const key=`${root}-${mode}`;
        if(key===prevBlockKey) return{root,mode};
        prevBlockKey=key;
      }
      blockChroma=new Array(12).fill(0);blockW=0;blockF=0;
    }
  }

  if(globalW<1e-6) return null;
  const gc=globalChroma.map(v=>v/globalW);
  return scoreChroma(gc);
}

self.onmessage=(e)=>{
  const{jobId,mono,sr}=e.data;
  try{
    const result=detectKeyFromMono(mono,sr);
    self.postMessage({jobId,result});
  }catch(err){
    self.postMessage({jobId,result:null});
  }
};
