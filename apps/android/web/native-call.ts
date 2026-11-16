export function nativeCall(action: 'ssh' | 'request' | 'update', args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const listener = (event: Event) => {
      const message = (event as CustomEvent).detail;
      if (message.id !== id) return;
      window.removeEventListener('android:rpc', listener);
      message.result.ok ? resolve(message.result) : reject(new Error(message.result.message ?? '平台操作尚未完成。'));
    };
    window.addEventListener('android:rpc', listener);
    try { window.AndroidPlatform.rpc(id, action, JSON.stringify(args)); }
    catch (error) { window.removeEventListener('android:rpc', listener); reject(error); }
  });
}
