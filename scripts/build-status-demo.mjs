import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("apps/desktop/dist/renderer", { recursive: true });
await Promise.all([
  build({ entryPoints: ["apps/desktop/renderer/main.tsx"], outfile: "apps/desktop/dist/renderer/app.js",
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ entryPoints: ["apps/desktop/bridge/preload.ts"], outfile: "apps/desktop/dist/bridge/preload.cjs",
    bundle: true, platform: "node", format: "cjs", external: ["electron"] }),
  build({ entryPoints: ["apps/desktop/renderer/workspace.tsx"], outfile: "apps/desktop/dist/renderer/workspace.js",
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }),
  build({ entryPoints: ["apps/desktop/bridge/workspace-preload.ts"], outfile: "apps/desktop/dist/bridge/workspace-preload.cjs",
    bundle: true, platform: "node", format: "cjs", external: ["electron"] }),
  copyFile("apps/desktop/renderer/workspace.html", "apps/desktop/dist/renderer/workspace.html"),
  copyFile("apps/desktop/renderer/workspace.css", "apps/desktop/dist/renderer/workspace.css"),
  copyFile("apps/desktop/renderer/index.html", "apps/desktop/dist/renderer/index.html"),
  copyFile("apps/desktop/renderer/style.css", "apps/desktop/dist/renderer/style.css"),
]);
console.log("Windows save status demo built.");

