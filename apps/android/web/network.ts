import { nativeCall } from './native-call';
export function installNetwork() {
  globalThis.fetch = async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    const result = await nativeCall('request', {url:String(input),method:options.method??'GET',token:(headers.get('authorization')??'').replace(/^Bearer /,''),body:String(options.body??'')});
    if (!result.ok) throw new Error(result.message);
    return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}
