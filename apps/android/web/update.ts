export interface AndroidUpdate { version: string; notes: string; url: string; sha256: string; size: number }
export function selectAndroidUpdate(releases: any, current='1.3.5'): AndroidUpdate|null {
  if(!Array.isArray(releases))throw new Error('版本响应无效。');
  const parts=(v:string)=>/^v?\d+\.\d+\.\d+$/.test(v)?v.replace(/^v/,'').split('.').map(Number):null;
  const compare=(a:number[],b:number[])=>a[0]!-b[0]!||a[1]!-b[1]!||a[2]!-b[2]!;
  const offers:AndroidUpdate[]=[];
  for(const release of releases){
    if(release.draft!==false||release.prerelease!==false||!parts(release.tag_name??''))continue;
    const version=release.tag_name.replace(/^v/,'');if(compare(parts(version)!,parts(current)!)<=0)continue;
    const name='workspace-android-v'+version+'.apk';
    const asset=release.assets?.find((a:any)=>a.name===name&&a.state==='uploaded');
    const expected='https://github.com/Ebwai/memory_in_one/releases/download/'+encodeURIComponent(release.tag_name)+'/'+name;
    if(asset?.browser_download_url!==expected||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??'')||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>512*1024*1024)continue;
    offers.push({version,notes:String(release.body??'').slice(0,6000),url:expected,sha256:asset.digest.slice(7),size:asset.size});
  }
  return offers.sort((a,b)=>compare(parts(b.version)!,parts(a.version)!))[0]??null;
}
