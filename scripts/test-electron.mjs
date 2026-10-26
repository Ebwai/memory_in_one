import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(electron, ["--test", "--test-concurrency=1", ".build/tests/integration/local-persistence.test.js", ".build/tests/integration/save-status.test.js", ".build/tests/integration/reliable-save.test.js", ".build/tests/integration/workspace-initialization.test.js", ".build/tests/integration/domains.test.js", ".build/tests/integration/todo-review.test.js", ".build/tests/integration/todo-progress.test.js", ".build/tests/integration/todo-tree.test.js", ".build/tests/integration/conflicts.test.js", ".build/tests/integration/replication.test.js", ".build/tests/integration/mcp.test.js", ".build/tests/integration/export-scope.test.js", ".build/tests/integration/snapshot.test.js", ".build/tests/integration/archive.test.js", ".build/tests/integration/recovery.test.js", ".build/tests/integration/migration.test.js"], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });

