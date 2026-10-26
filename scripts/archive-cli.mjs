import { readArchive, recoverArchive, authorityFromLocal } from "@workspace/adapters";
import { createHash } from "node:crypto";
import { todoDefinition, TODO_DOMAIN } from "@workspace/todo-list";

const [action, file, target] = process.argv.slice(2);
if (!["preview", "restore", "prepare-local-authority"].includes(action) || !file || !target) {
  console.error("用法：archive-cli.mjs preview|restore|prepare-local-authority 导出文件 空白目标目录");
  process.exitCode = 1;
} else {
  try {
    let archive = await readArchive(file);
    if (action === "prepare-local-authority") archive = authorityFromLocal(archive);
    const result = await recoverArchive(archive, target, action !== "preview", { [TODO_DOMAIN]: createHash("sha256").update(JSON.stringify(todoDefinition)).digest("hex") });
    console.log(JSON.stringify(result, null, 2));
    if (action !== "preview") console.log(result.source === "local" ? "本机恢复完成。未自动接入旧地址，原未同步操作仍待接续。" : "统一位置恢复完成，目标待迁移启用，尚不接受写入。请从客户端明确切换。");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
