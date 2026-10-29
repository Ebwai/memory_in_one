import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SshTunnel,validateTunnel} from '../../apps/desktop/dist/host/ssh-tunnel.js';
test('SSH rejects command-like configuration and pins host identity before forwarding',async()=>{
 const root=resolve('.build/ssh-tests'); await mkdir(root,{recursive:true});
 const dir=await mkdtemp(join(root,'identity-'));
 await writeFile(join(dir,'identity'),'isolated fixture, not a private key');
 const original=childProcess.spawn;let forwards=0;let scanned=0;let child;
 const fingerprint='SHA256:'+'A'.repeat(43);
 let mismatch=true;
 childProcess.spawn=(program,args,options)=>{
   assert.equal(options.windowsHide,true);
   const process=new EventEmitter();process.stdout=new EventEmitter();process.stderr=new EventEmitter();process.exitCode=null;
   process.kill=()=>{process.exitCode=0;queueMicrotask(()=>process.emit('exit',0));return true;};
   queueMicrotask(()=>{
    if(program==='ssh.exe' && args.includes('PreferredAuthentications=none')){scanned++;const destination=args.find(value=>value.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length);void writeFile(destination,'fixture public key').then(()=>process.emit('exit',255));}
    else if(program==='ssh-keygen.exe'){process.stdout.emit('data',Buffer.from('256 '+(mismatch?'SHA256:'+'B'.repeat(43):fingerprint)+' fixture'));process.emit('exit',0);}
    else if(program==='ssh.exe'){forwards++;child=process;assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('127.0.0.1:43128:127.0.0.1:43127'));}
    else assert.fail(program);
   });return process;
 };syncBuiltinESMExports();
 const tunnel=new SshTunnel(dir);
 try{
  await tunnel.load();
  const config={...tunnel.status().config,fingerprint,enabled:true};
  assert.throws(()=>validateTunnel({...config,host:'-oProxyCommand=evil'}));
  assert.throws(()=>validateTunnel({...config,user:'root;command'}));
  assert.throws(()=>validateTunnel({...config,port:0}));
  await tunnel.save(config); assert.equal(forwards,0);assert.match(tunnel.status().message,/指纹不匹配/);
  mismatch=false;await tunnel.save(config);await delay(30);assert.equal(forwards,1);
  child.exitCode=1;child.emit('exit',1);await delay(5300);assert.equal(forwards,2);
  await tunnel.stop(); const before=scanned;await delay(50);assert.equal(scanned,before);assert.equal(tunnel.status().phase,'disconnected');
 }finally{await tunnel.stop();childProcess.spawn=original;syncBuiltinESMExports();}
});
