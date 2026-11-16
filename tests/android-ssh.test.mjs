import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile('.build/android/ssh-fixture.json','utf8'));
const fixture=JSON.parse(await readFile('.build/android/server-fixture.json','utf8'));
const [target]=await(await fetch('http://127.0.0.1:9224/json')).json();
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
let index=0;const callbacks=new Map();socket.addEventListener('message',e=>{const v=JSON.parse(e.data);if(callbacks.has(v.id)){callbacks.get(v.id)(v);callbacks.delete(v.id);}});
async function evalJS(expression){const id=++index;const response=await new Promise(resolve=>{callbacks.set(id,resolve);socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(response.result.exceptionDetails)throw new Error(response.result.exceptionDetails.exception?.description);return response.result.result.value;}
const call=(c)=>`new Promise(resolve=>{const id=crypto.randomUUID();const listener=e=>{if(e.detail.id!==id)return;window.removeEventListener('android:rpc',listener);resolve(e.detail.result);};window.addEventListener('android:rpc',listener);AndroidPlatform.rpc(id,'ssh',${JSON.stringify(JSON.stringify({action:'connect',config:JSON.stringify(c)}))});})`;
const wrong=await evalJS(call({...config,fingerprint:'SHA256:wrong'}));if(wrong.ok)throw new Error('Untrusted host key accepted');console.log('PASS SSH wrong host fingerprint rejected');
const result=await evalJS(call(config));if(!result.ok)throw new Error(result.message);
const identity=await evalJS(`fetch(${JSON.stringify('http://127.0.0.1:42081/v1/identity')},{headers:{authorization:${JSON.stringify('Bearer '+fixture.token)}}}).then(r=>r.json())`);
if(identity.workspaceId!==fixture.identity.workspaceId)throw new Error('SSH forwarding identity mismatch');console.log('PASS verified SSH password authentication and real HTTP forwarding');socket.close();
