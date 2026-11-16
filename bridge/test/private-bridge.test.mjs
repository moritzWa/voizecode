import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPair,SignJWT } from 'jose';
import { OwnerAuth,OWNER,challenge,verifyGoogleIdToken } from '../private/auth.mjs';
import { WakeGate,gateClient } from '../private/gate.mjs';
import { application } from '../private/worker.mjs';
import { Outbox } from '../private/outbox.mjs';
import { SyncStore } from '../sync/store.mjs';
import { digest } from '../sync/projection.mjs';

let db,auth,gate,env,namespace;
const writerToken='s'.repeat(43),readerToken='r'.repeat(43);
const state={title:'Synthetic penguin project',archived:false,deleted:false,visible_before:null};
function storage() {
  const map=new Map();
  const s={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>{if(typeof k==='object')for(const [a,b] of Object.entries(k))map.set(a,structuredClone(b));else map.set(k,structuredClone(v));},delete:async k=>map.delete(k),transaction:async fn=>fn(s)};
  return s;
}
before(async()=>{
  db=new PGlite();
  await db.exec(await readFile(new URL('../sync/schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../private/schema.sql',import.meta.url),'utf8'));
  const object=new WakeGate({storage:storage()});
  namespace={idFromName:x=>x,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
  gate=gateClient(namespace,OWNER);
  env={ISSUER:'https://bridge.invalid',GOOGLE_CLIENT_ID:'test-google-client',GOOGLE_CLIENT_SECRET:'synthetic-secret',GATE:namespace,DATABASE_URL:'synthetic'};
  auth=new OwnerAuth(db,env,{gate,googleFetch:async()=>Response.json({id_token:'fixture'}),verify:async()=> 'google-owner-sub'});
  await db.query('INSERT INTO av_owner_source VALUES ($1,$2,$3)',[OWNER,'device123','epoch123']);
  for(const [token,audience,scopes] of [[writerToken,'sync','history:sync messages:deliver'],[readerToken,'read','history:read messages:send']])await db.query('INSERT INTO av_credentials (token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)',[await digest(token),OWNER,'device123','epoch123',audience,Date.now()+3600_000,scopes]);
  await gate.enroll({token_hash:await digest(writerToken),owner_id:OWNER,device_id:'device123',database_epoch:'epoch123',expires_at:Date.now()+3600_000});
  const store=new SyncStore(db),writer=await store.authenticate(writerToken,'sync');
  await store.apply(writer,{version:1,batch_id:'baseline',session_id:'ses_fixture',kind:'baseline',from:0,through:10,upload_id:'initial',chunk:0,complete:true,session:state,messages:[{id:'msg_one',role:'user',order:1,created_at:1,updated_at:1,text:'Penguin canary visible text'},{id:'msg_two',role:'assistant',order:2,created_at:2,updated_at:2,text:'An assistant response'}],delete_ids:[]});
});
after(async()=>db?.close());
const req=(path,options={})=>new Request(`https://bridge.invalid${path}`,options);
async function googleFlow(response) {
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const state=new URL(response.headers.get('location')).searchParams.get('state');
  const page=await auth.handle(req(`/auth/google/callback?state=${state}&code=fake-google-code`,{headers:{cookie}}));
  const html=await page.text(),code=html.match(/name="code" value="([^"]+)"/)[1];
  return {cookie,code,page};
}
test('Google token validation pins owner, audience, issuer, nonce and verified email',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const sign=claims=>new SignJWT({email:OWNER,email_verified:true,nonce:'n',...claims}).setProtectedHeader({alg:'RS256'}).setIssuer('https://accounts.google.com').setAudience(env.GOOGLE_CLIENT_ID).setSubject('google-sub').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal(await verifyGoogleIdToken(await sign({}),env,'n',publicKey),'google-sub');
  for(const claims of [{email:'another@example.com'},{email_verified:false},{nonce:'wrong'},{azp:'other-client'}])await assert.rejects(verifyGoogleIdToken(await sign(claims),env,'n',publicKey));
  await assert.rejects(verifyGoogleIdToken(await sign({}),{GOOGLE_CLIENT_ID:'other-client'},'n',publicKey));
});
test('OAuth code is browser-bound, one-use, PKCE/resource checked; refresh replay revokes the family',async()=>{
  await assert.rejects(auth.handle(req('/register',{method:'POST',body:JSON.stringify({redirect_uris:['https://evil.invalid/callback']})})),/invalid_client_metadata/);
  const client=await (await auth.handle(req('/register',{method:'POST',body:JSON.stringify({redirect_uris:['https://bridge.invalid/oauth/test-callback']})}))).json();
  const verifier='v'.repeat(43),url=`/authorize?${new URLSearchParams({client_id:client.client_id,redirect_uri:'https://bridge.invalid/oauth/test-callback',response_type:'code',code_challenge_method:'S256',code_challenge:await challenge(verifier),scope:'history:read messages:send',state:'client-state',resource:'https://bridge.invalid/mcp'})}`;
  const started=await auth.handle(req(url));
  const flowState=new URL(started.headers.get('location')).searchParams.get('state');
  await assert.rejects(auth.handle(req(`/auth/google/callback?state=${flowState}&code=bad`,{headers:{cookie:'av_browser=wrong'}})),/invalid_login_state/);
  const {cookie,code}=await googleFlow(started);
  const rendered=await googleFlow(await auth.handle(req(url)));
  assert.match(rendered.page.headers.get('content-security-policy'),/form-action 'self' https:\/\/chatgpt\.com/);
  const consent=await auth.handle(req('/consent',{method:'POST',headers:{cookie,origin:env.ISSUER},body:new URLSearchParams({code,decision:'approve'})}));
  const callback=new URL(consent.headers.get('location'));assert.equal(callback.searchParams.get('state'),'client-state');
  const data={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'https://bridge.invalid/oauth/test-callback',code:callback.searchParams.get('code'),code_verifier:verifier,resource:'https://bridge.invalid/mcp'};
  await assert.rejects(auth.token(new Map(Object.entries({...data,code_verifier:'x'.repeat(43)}))),/invalid_grant/);
  await assert.rejects(auth.token(new Map(Object.entries({...data,resource:'https://evil.invalid'}))),/invalid_target/);
  const access=await (await auth.token(new Map(Object.entries(data)))).json();
  await assert.rejects(auth.token(new Map(Object.entries(data))),/invalid_grant/);
  const next=await (await auth.token(new Map(Object.entries({grant_type:'refresh_token',client_id:client.client_id,refresh_token:access.refresh_token})))).json();
  assert.notEqual(next.refresh_token,access.refresh_token);
  await assert.rejects(auth.token(new Map(Object.entries({grant_type:'refresh_token',client_id:client.client_id,refresh_token:access.refresh_token}))),/invalid_grant/);
  await assert.rejects(new SyncStore(db).authenticate(next.access_token,'read'),/unauthorized/);
});
test('pairing requires Google owner consent and is consumed once',async()=>{
  const start=await (await auth.handle(req('/pair/start',{method:'POST',body:JSON.stringify({device_id:'device456',database_epoch:'epoch456',label:'Synthetic Mac'})}))).json();
  await assert.rejects(auth.handle(req('/pair/token',{method:'POST',body:JSON.stringify({device_code:start.device_code})})),/authorization_pending/);
  const consent=await googleFlow(await auth.handle(new Request(start.verification_uri)));
  await assert.rejects(auth.handle(req('/consent',{method:'POST',headers:{cookie:consent.cookie,origin:'https://evil.invalid'},body:new URLSearchParams({code:consent.code,decision:'approve'})})),/invalid_origin/);
  await auth.handle(req('/consent',{method:'POST',headers:{cookie:consent.cookie,origin:env.ISSUER},body:new URLSearchParams({code:consent.code,decision:'approve'})}));
  const result=await (await auth.handle(req('/pair/token',{method:'POST',body:JSON.stringify({device_code:start.device_code})}))).json();
  assert.equal(result.device_id,'device456');assert.equal((await gate.inspect(await digest(result.access_token))).principal.device_id,'device456');
  await assert.rejects(auth.handle(req('/pair/token',{method:'POST',body:JSON.stringify({device_code:start.device_code})})),/pairing_expired/);
});
test('MCP exposes real read/search tools but rejects ungranted sends and bypass attempts',async()=>{
  const app=application({database:async()=>({query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn),close:async()=>{}})});
  const rpc=async(method,params={})=>{
    const response=await app.fetch(req('/mcp',{method:'POST',headers:{authorization:`Bearer ${readerToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
    assert.equal(response.status,200);return response.json();
  };
  const tools=(await rpc('tools/list')).result.tools;
  assert.equal(tools.find(t=>t.name==='send_session_message').annotations.readOnlyHint,false);
  const search=await rpc('tools/call',{name:'search_history',arguments:{query:'penguin'}});
  assert.match(search.result.content[0].text,/canary visible/);
  const forbidden=await rpc('tools/call',{name:'send_session_message',arguments:{operation_id:'op-short',session_id:'ses_fixture',text:'Do not run',base_cursor:10,confirmed:false}});
  assert(forbidden.error || forbidden.result?.isError);
  assert.equal((await app.fetch(req('/mcp'),env)).status,401);
});
test('outbox is idempotent, source-scoped, ordered and checks stale context',async()=>{
  const store=new SyncStore(db),reader=await store.authenticate(readerToken,'read'),writer=await store.authenticate(writerToken,'sync'),outbox=new Outbox(db,gate);
  const input={operation_id:'operation123',session_id:'ses_fixture',text:'Synthetic no-op instruction',base_cursor:10};
  await assert.rejects(outbox.send({...reader,scopes:'history:read'},input),/write_permission_required/);
  const first=await outbox.send(reader,input);assert.deepEqual(await outbox.send(reader,input),first);
  await assert.rejects(outbox.send(reader,{...input,text:'changed'}),/operation_id_conflict/);
  await assert.rejects(outbox.send(reader,{...input,operation_id:'operationbad',base_cursor:9}),/context_changed/);
  await outbox.send(reader,{...input,operation_id:'operation456'});
  const leased=await outbox.lease(writer);assert.equal(leased.operation_id,'operation123');assert(leased.message_id.startsWith('msg_'));
  assert.equal(await outbox.lease(writer),null); // Same-session successor waits for admission.
  await outbox.ack(writer,{operation_id:leased.operation_id,message_id:leased.message_id,status:'accepted'});
  assert.equal((await outbox.lease(writer)).operation_id,'operation456');
  assert.equal((await outbox.status(reader,'operation123')).status,'accepted');
});
test('idle connector poll does not open Postgres; wake generations cannot be cleared by an older ACK',async()=>{
  const hash=await digest(writerToken),source='device123|epoch123';
  const a=await gate.signal(source),b=await gate.signal(source);await gate.clear(source,a.generation);
  assert.equal((await gate.inspect(hash)).pending,true);
  let opened=0;
  const app=application({database:async()=>{opened++;throw new Error('Must not open');}});
  const response=await app.fetch(req('/v1/connector/poll',{method:'POST',headers:{authorization:`Bearer ${writerToken}`}}),env);
  assert.equal(response.status,200);assert.equal((await response.json()).generation,b.generation);assert.equal(opened,0);
  await gate.revoke(hash);
  assert.equal((await app.fetch(req('/v1/connector/poll',{method:'POST',headers:{authorization:`Bearer ${writerToken}`}}),env)).status,401);
  assert.equal(opened,0);
});

test('owner-wide OAuth follows primary source without widening connector credentials',async()=>{
  const token='o'.repeat(43);
  await db.query('INSERT INTO av_credentials (token_hash,owner_id,device_id,database_epoch,audience,expires_at,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)',[await digest(token),OWNER,'*','*','read',Date.now()+3600_000,'history:read']);
  const store=new SyncStore(db);
  await db.query('UPDATE av_owner_source SET device_id=$2,database_epoch=$3 WHERE owner_id=$1',[OWNER,'device123','epoch123']);
  assert.equal((await store.authenticate(token,'read')).device_id,'device123');
  await db.query('UPDATE av_owner_source SET device_id=$2,database_epoch=$3 WHERE owner_id=$1',[OWNER,'new-device','new-epoch']);
  assert.equal((await store.authenticate(token,'read')).device_id,'new-device');
  assert.equal((await store.authenticate(writerToken,'sync')).device_id,'device123');
});

test('stale sends require confirmation, cancellation unblocks the queue and expiry distinguishes uncertain admission',async()=>{
  const store=new SyncStore(db),writer=await store.authenticate(writerToken,'sync'),reader=await store.authenticate(readerToken,'read'),outbox=new Outbox(db,gate);
  await store.apply(writer,{version:1,batch_id:'ttl-baseline',session_id:'ses_ttl',kind:'baseline',from:0,through:1,upload_id:'ttl-gen',chunk:0,complete:true,session:state,messages:[],delete_ids:[]});
  await outbox.send(reader,{operation_id:'ttl_operation1',session_id:'ses_ttl',text:'Fixture',base_cursor:1});
  await db.query('UPDATE av_sessions SET cursor=2 WHERE session_id=$1',['ses_ttl']);
  assert.equal((await outbox.lease(writer)).needs_confirmation,'ttl_operation1');
  assert.equal((await outbox.cancel(reader,'ttl_operation1')).status,'cancelled');
  await outbox.send(reader,{operation_id:'ttl_operation2',session_id:'ses_ttl',text:'Fixture',base_cursor:2});
  await outbox.send(reader,{operation_id:'ttl_operation3',session_id:'ses_ttl',text:'Fixture',base_cursor:2});
  const leased=await outbox.lease(writer);assert.equal(leased.operation_id,'ttl_operation2');
  await db.query('UPDATE av_outbox SET expires_at=0 WHERE operation_id IN ($1,$2)',['ttl_operation2','ttl_operation3']);
  assert.equal((await outbox.status(reader,'ttl_operation2')).status,'uncertain');
  assert.equal((await outbox.status(reader,'ttl_operation3')).status,'expired');
  await assert.rejects(outbox.cancel(reader,'ttl_operation2'),/cannot_cancel/);
  assert.equal((await outbox.ack(writer,{operation_id:leased.operation_id,message_id:leased.message_id,status:'accepted'})).status,'accepted');
});
