import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

for (const name of ["contracts", "core", "adapters", "ui", "extension-sdk", "todo-list"]) {
  for (const path of sources(`packages/${name}/src`)) {
    const source = readFileSync(path, "utf8");
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const dependency of imports) {
      assert.ok(!dependency.includes("apps/"), `${path}: packages cannot import application internals`);
      if (name !== "adapters") {
        assert.ok(!dependency.startsWith("node:") && dependency !== "electron" && (name === "ui" || dependency !== "react"), `${path}: host dependency in portable code`);
      }
      const allowed = dependency.startsWith(".") || (name === "adapters" && dependency.startsWith("node:")) ||
        (name !== "contracts" && dependency === "@workspace/contracts") ||
        (name === "ui" && ["react", "react/jsx-runtime"].includes(dependency));
      assert.ok(allowed, `${path}: undeclared boundary dependency ${dependency}`);
    }
  }
}
console.log("Package dependency boundaries: OK");
