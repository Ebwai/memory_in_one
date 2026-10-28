export const RELEASE_API = "https://api.github.com/repos/Ebwai/memory_in_one/releases?per_page=100";
const downloadPrefix = "https://github.com/Ebwai/memory_in_one/releases/download/";
export interface UpdateOffer {
  readonly version: string;
  readonly notes: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export function versionParts(version: string): number[] {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("版本格式无效。");
  const parts = version.replace(/^v/, "").split(".").map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error("版本格式无效。");
  return parts;
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  return 0;
}

export function selectUpdate(releases: unknown, current: string, arch: string): UpdateOffer | null {
  versionParts(current);
  if (!Array.isArray(releases)) throw new Error("GitHub 版本响应无效。");
  const offers: UpdateOffer[] = [];
  for (const release of releases) {
    if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") continue;
    let version: string;
    try { versionParts(release.tag_name); version = release.tag_name.replace(/^v/, ""); } catch { continue; }
    if (compareVersions(version, current) <= 0) continue;
    const names = [`workspace-windows-v${version}-${arch}.zip`, ...(arch === "x64" ? [`workspace-windows-v${version}.zip`] : [])];
    const asset = names.map(name => release.assets?.find((item: { name?: string }) => item.name === name)).find(Boolean);
    if (!asset || asset.state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) continue;
    const expected = downloadPrefix + encodeURIComponent(release.tag_name) + "/" + asset.name;
    if (asset.browser_download_url !== expected) continue;
    offers.push({ version, notes: typeof release.body === "string" ? release.body.slice(0, 6000) : "", url: expected, sha256: asset.digest.slice(7), size: asset.size });
  }
  return offers.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}
