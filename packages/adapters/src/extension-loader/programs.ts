import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionPrograms } from "@workspace/contracts";

export class FileExtensionPrograms implements ExtensionPrograms {
  constructor(private readonly directory: string) {}
  private path(fingerprint: string): string {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("无效程序身份。");
    return join(this.directory, fingerprint + ".json");
  }
  async stage(definition: ExtensionDefinition): Promise<string> {
    const source = JSON.stringify(definition);
    const fingerprint = createHash("sha256").update(source).digest("hex");
    await mkdir(this.directory, { recursive: true });
    if (await this.available(fingerprint)) return fingerprint;
    // Publish only a complete, flushed package; a damaged copy can be repaired from the exact original source.
    const temp = this.path(fingerprint) + "." + randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(source); await file.sync(); } finally { await file.close(); }
    try { await rename(temp, this.path(fingerprint)); }
    finally { await unlink(temp).catch(() => undefined); }
    if (!await this.available(fingerprint)) throw new Error("本机程序材料无法核验，未替换原程序。");
    return fingerprint;
  }
  async available(fingerprint: string): Promise<boolean> {
    try { return createHash("sha256").update(await readFile(this.path(fingerprint))).digest("hex") === fingerprint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async remove(fingerprint: string): Promise<void> {
    try { await unlink(this.path(fingerprint)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
