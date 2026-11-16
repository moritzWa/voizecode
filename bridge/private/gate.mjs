/** Durable wake metadata only, never chat text. Idle polls do not connect to Neon. */
export class WakeGate {
  constructor(state) { this.state=state;this.waiters=new Set(); }
  async fetch(request) {
    const p=await request.json(),path=new URL(request.url).pathname,s=this.state.storage;
    if(path==='/enroll') { await s.put(`token:${p.token_hash}`,p);await s.put(`pending:${p.device_id}|${p.database_epoch}`,true);return Response.json({ok:true}); }
    if(path==='/revoke') { await s.delete(`token:${p.token_hash}`);for(const wake of this.waiters)wake();return Response.json({ok:true}); }
    if(path==='/signal') {
      const generation=await s.transaction(async tx=>{const n=(await tx.get(`generation:${p.source}`)??0)+1;await tx.put({[`generation:${p.source}`]:n,[`pending:${p.source}`]:true});return n;});
      for(const wake of this.waiters)wake();
      return Response.json({generation});
    }
    if(path==='/clear') {
      await s.transaction(async tx=>{if((await tx.get(`generation:${p.source}`)??0)===p.generation)await tx.put(`pending:${p.source}`,false);});
      return Response.json({ok:true});
    }
    if(path==='/rate') {
      const minute=Math.floor(Date.now()/60_000),key=`rate:${p.key}`;
      const allowed=await s.transaction(async tx=>{const old=await tx.get(key),n=old?.minute===minute?old.n+1:1;await tx.put(key,{minute,n});return n<=30;});
      return Response.json({allowed});
    }
    if(path==='/activity') {
      const now=Date.now();await s.put(`active_until:${p.source}`,now+5*60_000);
      for(const wake of this.waiters)wake();
      const seen=await s.get(`last_seen:${p.source}`)??0;
      if(p.wait && seen>now-60_000 && (await s.get(`checked:${p.source}`)??0)<now-5000) {
        await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};this.waiters.add(wake);timer=setTimeout(wake,8000);});
      }
      return Response.json({source_checked_at:await s.get(`checked:${p.source}`)??null,mac_seen_recently:seen>now-60_000});
    }
    const credential=await s.get(`token:${p.token_hash}`);
    if(!credential || credential.expires_at<=Date.now())return Response.json({error:'unauthorized'},{status:401});
    const source=`${credential.device_id}|${credential.database_epoch}`;
    if(path==='/checked') {await s.put(`checked:${source}`,Date.now());for(const wake of this.waiters)wake();}
    if(path==='/poll') {
      await s.put(`last_seen:${source}`,Date.now());
      if(!(await s.get(`pending:${source}`))) {
        await new Promise(resolve=>{
          let timer;
          const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};
          this.waiters.add(wake);timer=setTimeout(wake,20_000);
        });
      }
      if(!(await s.get(`token:${p.token_hash}`)))return Response.json({error:'unauthorized'},{status:401});
    }
    return Response.json({principal:credential,pending:await s.get(`pending:${source}`)??false,generation:await s.get(`generation:${source}`)??0,last_seen:await s.get(`last_seen:${source}`)??null,active_until:await s.get(`active_until:${source}`)??0});
  }
}

export function gateClient(namespace,key) {
  const stub=namespace.get(namespace.idFromName(key));
  const call=async(path,p)=>{
    const response=await stub.fetch(`https://internal${path}`,{method:'POST',body:JSON.stringify(p)});
    const body=await response.json();if(!response.ok)throw Object.assign(new Error('unauthorized'),{status:response.status});return body;
  };
  return {enroll:p=>call('/enroll',p),revoke:token_hash=>call('/revoke',{token_hash}),signal:source=>call('/signal',{source}),
    clear:(source,generation)=>call('/clear',{source,generation}),poll:token_hash=>call('/poll',{token_hash}),
    inspect:token_hash=>call('/inspect',{token_hash}),checked:token_hash=>call('/checked',{token_hash}),
    activity:(source,wait=false)=>call('/activity',{source,wait}),rate:key=>call('/rate',{key})};
}
