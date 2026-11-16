import { build } from 'esbuild';
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const debug = process.argv.includes('--debug');
const sdk = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
const java = process.env.ANDROID_JAVA_HOME ?? 'C:/Program Files/Android/Android Studio/jbr';
const bt = path.join(sdk, 'build-tools/35.0.1');
const dependencies = path.join(root, '.build/android/dependencies');
await mkdir(dependencies, {recursive:true});
const ssh = path.join(dependencies, 'jsch.jar');
if (!existsSync(ssh)) { const response = await fetch('https://repo.maven.apache.org/maven2/com/github/mwiede/jsch/0.2.26/jsch-0.2.26.jar'); if (!response.ok) throw new Error('SSH dependency download failed'); await (await import('node:fs/promises')).writeFile(ssh, new Uint8Array(await response.arrayBuffer())); }
const sshDigest = (await import('node:crypto')).createHash('sha256').update(await (await import('node:fs/promises')).readFile(ssh)).digest('hex');
if (sshDigest !== '5ad82d1a9534404d0a519c525e796c8ef69f4fe47b19bc4d16bbd296686ac9f2') throw new Error('SSH dependency integrity check failed');
for (const dependency of JSON.parse(await (await import('node:fs/promises')).readFile('apps/android/dependencies.json','utf8'))) {
  const destination = path.join(dependencies,dependency.file);
  if (!existsSync(destination)) { const response=await fetch(dependency.url); if(!response.ok)throw new Error('Android dependency download failed');await(await import('node:fs/promises')).writeFile(destination,new Uint8Array(await response.arrayBuffer())); }
  const digest=(await import('node:crypto')).createHash('sha256').update(await(await import('node:fs/promises')).readFile(destination)).digest('hex');
  if(digest!==dependency.sha256)throw new Error('Android dependency integrity check failed: '+dependency.file);
}
const prepared=spawnSync('python',['scripts/prepare-android-dependencies.py',dependencies],{stdio:'inherit'});if(prepared.status!==0)throw new Error('Android dependency extraction failed');
const libraries=[ssh,...['sqlite.jar','support-sqlite.jar','cancellation.jar','collection.jar','kotlin.jar'].map(file=>path.join(dependencies,file))];
const android = path.join(sdk, 'platforms/android-35/android.jar');
const out = path.join(root, '.build/android');
const assets = path.join(out, 'assets');
for (const dir of [assets, path.join(out, 'classes'), path.join(out, 'dex'), path.join(root, 'output/android')]) await mkdir(dir, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})`);
}
await build({ entryPoints: ['apps/android/web/client-ui.tsx'], outfile: path.join(assets, 'app.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome100', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@workspace/todo-list': path.join(root, 'packages/todo-list/src/index.ts'), '@workspace/contracts': path.join(root, 'packages/contracts/src/index.ts'), '@workspace/core': path.join(root, 'packages/core/src/index.ts'), '@workspace/extension-sdk': path.join(root, 'packages/extension-sdk/src/index.ts'), 'node:sqlite': path.join(root, 'apps/android/web/sqlite-platform.ts'), 'node:fs': path.join(root, 'apps/android/web/node-platform.ts'), 'node:path': path.join(root, 'apps/android/web/node-platform.ts'), 'node:crypto': path.join(root, 'apps/android/web/node-platform.ts'), 'node:util': path.join(root, 'apps/android/web/node-platform.ts') } });
await Promise.all(['index.html', 'app.css'].map(file => copyFile(path.join(root, 'apps/android/web', file), path.join(assets, file))));
const manifest = path.join(out,'AndroidManifest.xml');
const manifestText = await(await import('node:fs/promises')).readFile('apps/android/AndroidManifest.xml','utf8');
await(await import('node:fs/promises')).writeFile(manifest,debug?manifestText:manifestText.replace('android:debuggable="true"','android:debuggable="false"').replace('1.3.2-dev','1.3.2').replace(' · 开发版',''));
run(path.join(bt, 'aapt.exe'), ['package', '-f', '-M', manifest, '-I', android, '-S', 'apps/android/res', '-A', assets, '-F', path.join(out, 'resources.apk')]);
run(path.join(java, 'bin/javac.exe'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', [android,...libraries].join(path.delimiter), '-d', path.join(out, 'classes'), 'apps/android/native/com/workspace/mobile/MainActivity.java', 'apps/android/native/com/workspace/mobile/Platform.java', 'apps/android/native/com/workspace/mobile/SshTunnel.java','apps/android/native/com/workspace/mobile/Updater.java','apps/android/native/com/workspace/mobile/UpdateProvider.java']);
async function files(dir) { const result = []; for (const name of await readdir(dir)) { const file = path.join(dir, name); if ((await stat(file)).isDirectory()) result.push(...await files(file)); else if (file.endsWith('.class')) result.push(file); } return result; }
run(path.join(java, 'bin/java.exe'), ['-cp', path.join(bt, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '26', '--lib', android, '--output', path.join(out, 'dex'), ...await files(path.join(out, 'classes')), ...libraries]);
run(path.join(java, 'bin/jar.exe'), ['uf', path.join(out, 'resources.apk'), '-C', path.join(out, 'dex'), 'classes.dex', '-C', path.join(dependencies,'native'), 'lib']);
run(path.join(bt, 'zipalign.exe'), ['-f', '4', path.join(out, 'resources.apk'), path.join(out, 'aligned.apk')]);
const key = path.join(out, 'development.keystore');
if (!existsSync(key)) run(path.join(java, 'bin/keytool.exe'), ['-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddev', '-dname', 'CN=Workspace Development', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650']);
const apk = path.join(root, debug?'output/android/workspace-android-dev.apk':'output/android/workspace-android.apk');
run(path.join(java, 'bin/java.exe'), ['-jar', path.join(bt, 'lib/apksigner.jar'), 'sign', '--ks', key, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, path.join(out, 'aligned.apk')]);
run(path.join(java, 'bin/java.exe'), ['-jar', path.join(bt, 'lib/apksigner.jar'), 'verify', '--verbose', apk]);
console.log(`Android ${debug?'debug':'application'} APK: ${apk}`);
