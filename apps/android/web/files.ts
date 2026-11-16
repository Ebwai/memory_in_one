export function file(action: 'open' | 'save' | 'install', body = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const listener = (event: Event) => { const result = (event as CustomEvent).detail; if (result.id !== id) return; window.removeEventListener('android:file', listener); result.ok ? resolve(result.value) : reject(new Error(result.value)); };
    window.addEventListener('android:file', listener);
    try { window.AndroidPlatform.file(id, action, body); } catch (e) { window.removeEventListener('android:file', listener); reject(e); }
  });
}
