import { useEffect, useState } from 'react';
import type { Client } from './client';

export function ConnectionTopology({ client }: { client: Client }) {
  const endpoint = client.current?.endpoint;
  const replica = client.current?.replica;
  const [devices, setDevices] = useState<Awaited<ReturnType<Client['topology']>> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!endpoint) return;
    let active = true;
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const result = await client.topology();
        if (active) { setDevices(result); setError(false); }
      } catch {
        if (active) setError(true);
      } finally { loading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { active = false; clearInterval(timer); };
  }, [client, endpoint, replica]);

  return <section aria-labelledby="connection-topology">
    <h3 id="connection-topology">服务器连接拓扑</h3>
    {!endpoint ? <p>接入服务器空间后可查看设备连接状态。</p> :
      error ? <p role="status">暂时无法读取服务器连接状态。</p> :
      devices === null ? <p role="status">正在查询设备…</p> :
      devices.length === 0 ? <p>服务器尚未收到设备的同步记录。</p> :
      <ul>{[...devices].reverse().map(device => <li key={device.id}>
        {device.name} · {device.online ? '在线' : '离线'} · 最近同步 {new Date(device.seenAt).toLocaleString()}
      </li>)}</ul>}
  </section>;
}
