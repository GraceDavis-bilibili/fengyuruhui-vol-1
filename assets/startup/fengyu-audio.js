/* Real rooster (alys, public domain) + real wind/rain field recordings.
 * Sources: 鸡鸣来源与修订说明.md and 真实风雨来源与处理.md.
 * Audio data supplied by fengyu-audio-data.js.
 * Works from a local preview file without fetching audio or contacting a service.
 */
(function(global){
  'use strict';
  // Real recordings layered: the storm (wind howl, distant thunder) behind, close heavy rain in front,
  // and now and then a single drop falling from the eaves nearby.
  const MIX={wind:.71,rain:.58,drip:[.3,.5],dripGap:[1.6,5],rooster:1,fadeIn:2.2};
  const DRIP_SLOT=.5,DRIP_LENGTH=.45;
  // Shared by the game and the preview renderer, so the preview sounds like the game.
  function buildBeds(ctx,buffers,output){
    const nodes=[],sources=[];
    const comp=ctx.createDynamicsCompressor();
    comp.threshold.value=-26;comp.knee.value=10;comp.ratio.value=2.2;comp.attack.value=.03;comp.release.value=.5;
    const makeup=ctx.createGain();makeup.gain.value=.53; // the compressor already adds its own makeup gain
    comp.connect(makeup);makeup.connect(output);nodes.push(comp,makeup);
    function bed(buffer,chain,volume,offset){
      const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;
      const gain=ctx.createGain();gain.gain.value=volume;
      let last=source;
      for(const node of chain){last.connect(node);last=node;nodes.push(node);}
      last.connect(gain);gain.connect(comp);nodes.push(gain);
      source.start(0,offset%buffer.duration);sources.push(source);
    }
    function filter(type,frequency,gainDb=0,q=.7){
      const node=ctx.createBiquadFilter();node.type=type;node.frequency.value=frequency;node.gain.value=gainDb;node.Q.value=q;return node;
    }
    if(buffers.wind){
      // Less rumble and boxiness, a little more air: the howl stays, the mud goes.
      bed(buffers.wind,[filter('highpass',45),filter('lowshelf',130,-5),filter('peaking',380,-2.5,.9),filter('highshelf',3200,3)],buffers.rain?MIX.wind:.7,0);
    }
    if(buffers.rain)bed(buffers.rain,[filter('highpass',70)],MIX.rain,Math.random()*buffers.rain.duration);
    return {output:makeup,stop(){
      for(const source of sources){try{source.stop();}catch{}source.disconnect();}
      for(const node of nodes)node.disconnect();
    }};
  }
  // One drop from the eaves: a random take, pitch and side, played at time `when`.
  function playDrip(ctx,buffers,output,when,random=Math.random){
    const buffer=buffers.drips;if(!buffer)return null;
    const takes=Math.max(1,Math.floor(buffer.duration/DRIP_SLOT));
    const source=ctx.createBufferSource(),gain=ctx.createGain();
    source.buffer=buffer;source.playbackRate.value=.9+random()*.2;
    gain.gain.value=MIX.drip[0]+random()*(MIX.drip[1]-MIX.drip[0]);
    let last=gain;
    if(ctx.createStereoPanner){const pan=ctx.createStereoPanner();pan.pan.value=random()*1.4-.7;gain.connect(pan);last=pan;}
    source.connect(gain);last.connect(output);
    source.onended=()=>{source.disconnect();gain.disconnect();if(last!==gain)last.disconnect();};
    source.start(when,Math.floor(random()*takes)*DRIP_SLOT,DRIP_LENGTH);
    return source;
  }
  function nextDripGap(random=Math.random){return MIX.dripGap[0]+random()*(MIX.dripGap[1]-MIX.dripGap[0]);}
  async function decodeAll(ctx,data){
    const entries=Object.entries(data);
    const decoded=await Promise.all(entries.map(([,b64])=>{
      const raw=atob(b64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      return ctx.decodeAudioData(bytes.buffer);
    }));
    const buffers={};entries.forEach(([name],i)=>buffers[name]=decoded[i]);
    return buffers;
  }
  function audioData(){
    if(global.FengyuAudioDataV3)return global.FengyuAudioDataV3;
    const old=global.FengyuAudioDataV2;if(!old)return null;
    const [wind,rooster]=Object.values(old);return {wind,rooster};
  }
  global.FengyuAmbientMix={MIX,buildBeds,playDrip,nextDripGap,decodeAll,audioData};
  global.createFengyuAmbientAudio=function({onChange=()=>{},onError=()=>{}}={}){
    let ctx=null, buffers=null, pending=null, master=null, beds=null, timer=null, dripTimer=null, closed=false;
    let enabled=false, revision=0;
    const firstDeadline=performance.now()+8000;
    let firstCalled=false;
    const voices=new Set();
    function ensureContext(){
      if(!ctx){
        const AC=global.AudioContext||global.webkitAudioContext;if(!AC)throw new Error('当前浏览器不支持环境声');
        ctx=new AC();master=ctx.createGain();master.gain.value=0;master.connect(ctx.destination);
      }
      return ctx;
    }
    function load(){
      if(buffers)return Promise.resolve(buffers);
      if(pending)return pending;
      const data=audioData();if(!data)return Promise.reject(new Error('缺少环境声资源'));
      pending=decodeAll(ctx,data).then(v=>buffers=v).catch(e=>{pending=null;throw e;});
      return pending;
    }
    function stopVoices(){
      clearTimeout(timer);timer=null;clearTimeout(dripTimer);dripTimer=null;
      for(const source of voices){try{source.stop();}catch{}source.disconnect();}
      voices.clear();beds?.stop();beds=null;
      if(master){master.gain.cancelScheduledValues(0);master.gain.value=0;}
    }
    function playBuffer(name,volume){
      if(!buffers[name])return null;
      const source=ctx.createBufferSource(),gain=ctx.createGain();
      source.buffer=buffers[name];gain.gain.value=volume;
      source.connect(gain);gain.connect(master);voices.add(source);
      source.onended=()=>{voices.delete(source);source.disconnect();gain.disconnect();};
      source.start();return source;
    }
    function call(){
      firstCalled=true;
      playBuffer('rooster',MIX.rooster);
    }
    function schedule(){
      clearTimeout(timer);
      const ms=!firstCalled?Math.max(0,firstDeadline-performance.now()):35000+Math.random()*30000;
      timer=setTimeout(()=>{
        timer=null;if(closed||!enabled||document.hidden)return;
        call();schedule();
      },ms);
    }
    function drips(){
      clearTimeout(dripTimer);
      if(!buffers.drips)return;
      dripTimer=setTimeout(()=>{
        dripTimer=null;if(closed||!enabled||document.hidden||!beds)return;
        const source=playDrip(ctx,buffers,master,ctx.currentTime+.02);
        if(source){voices.add(source);source.addEventListener('ended',()=>voices.delete(source));}
        drips();
      },nextDripGap()*1000);
    }
    function startBed(){
      if(!beds){
        beds=buildBeds(ctx,buffers,master);
        const now=ctx.currentTime;
        master.gain.cancelScheduledValues(now);master.gain.setValueAtTime(0,now);master.gain.linearRampToValueAtTime(1,now+MIX.fadeIn);
        drips();
      }
      schedule();
    }
    async function setEnabled(value){
      if(closed)return false;
      enabled=!!value;const own=++revision;
      if(!enabled){stopVoices();if(ctx)await ctx.suspend().catch(()=>{});if(!closed&&own===revision)onChange(false);return false;}
      try{
        ensureContext();const resumed=ctx.resume(); // Called within the user's click gesture.
        await Promise.all([resumed,load()]);
        if(closed||!enabled||own!==revision)return false;
        if(!document.hidden)startBed();onChange(true);return true;
      }catch(error){
        if(own===revision&&!closed){enabled=false;stopVoices();onChange(false);onError(error);}return false;
      }
    }
    async function audition(){
      if(closed)return;
      const own=revision;
      try{ensureContext();await Promise.all([ctx.resume(),load()]);if(!closed&&own===revision&&!document.hidden)call();}
      catch(error){if(!closed)onError(error);}
    }
    async function visibility(){
      const own=++revision;stopVoices();
      if(!ctx)return;
      if(document.hidden){await ctx.suspend().catch(()=>{});return;}
      if(enabled){
        try{await Promise.all([ctx.resume(),load()]);if(!closed&&enabled&&own===revision&&!document.hidden)startBed();}
        catch(error){if(!closed)onError(error);}
      }
    }
    function release(){stopVoices();if(ctx)ctx.close().catch(()=>{});buffers=null;pending=null;}
    document.addEventListener('visibilitychange',visibility);
    return {
      get enabled(){return enabled;},setEnabled,audition,
      resumeWithGesture(){if(!closed&&enabled&&ctx&&ctx.state==='suspended')ctx.resume().catch(onError);},
      // fade: seconds to fade out first (used when a mode is chosen); 0 stops at once.
      dispose(fade=0){
        if(closed)return;closed=true;enabled=false;++revision;clearTimeout(timer);timer=null;clearTimeout(dripTimer);dripTimer=null;
        document.removeEventListener('visibilitychange',visibility);
        if(fade>0&&ctx&&ctx.state==='running'&&master){
          const now=ctx.currentTime;
          master.gain.cancelScheduledValues(now);master.gain.setValueAtTime(master.gain.value,now);master.gain.linearRampToValueAtTime(0,now+fade);
          setTimeout(release,fade*1000+80);return;
        }
        release();
      }
    };
  };
})(globalThis);
