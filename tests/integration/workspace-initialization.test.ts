import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceInitialization } from "@workspace/core";
import { SqliteWorkspaceAuthority, HttpWorkspaceLocation, workspaceServiceUrl } from "@workspace/adapters";
import { startWorkspaceServer } from "@workspace/server/initialization";
import type { WorkspaceCreationPort, WorkspaceProposal } from "@workspace/contracts";

test("an unreachable prepared service cannot report a created workspace", async () => {
  await withTarget(async (directory) => {
    const server = await startWorkspaceServer({ directory, token });
    const url = server.url;
    await server.close();
    const result = await service(new HttpWorkspaceLocation(url, token)).create(request);
    assert.notEqual(result.status, "created");
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, "unavailable");
    assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
  });
});

test("unsuccessful HTTP responses and unsafe returned identities cannot masquerade as verified creations", async () => {
  let unsafeIdentity = false;
  const server = createServer((_request, response) => {
    response.writeHead(unsafeIdentity ? 200 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "created", workspace: { workspaceId: unsafeIdentity ? "../escape" : "space", authorityId: "authority",
      name: "我的工作空间", creationId: request.creationId, createdAt: new Date().toISOString() } }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await service(new HttpWorkspaceLocation("http://127.0.0.1:" + address.port, token)).create(request);
    assert.equal(result.status, "unconfirmed");
    unsafeIdentity = true;
    const unsafe = await service(new HttpWorkspaceLocation("http://127.0.0.1:" + address.port, token)).create(request);
    assert.equal(unsafe.status, "unconfirmed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ready) => server.close(() => ready()));
  }
});

test("concurrent copies of one initialization request converge on the original identity", async () => {
  await withTarget(async (directory) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const target = join(directory, "concurrent-" + attempt);
      const results = await Promise.all(Array.from({ length: 3 }, () => service(new SqliteWorkspaceAuthority(target)).create(request)));
      const created = results.find((item) => item.status === "created");
      assert.ok(created?.status === "created", JSON.stringify(results));
      for (const result of results) if (result.status === "created") assert.deepEqual(result, created);
      assert.deepEqual(await service(new SqliteWorkspaceAuthority(target)).create(request), created);
    }
  });
});

test("incomplete staged creation is preserved for confirmation rather than overwritten", async () => {
  await withTarget(async (directory) => {
    const staging = join(directory, ".initialize-" + request.creationId + ".sqlite");
    writeFileSync(staging, "incomplete original material");
    const before = checksum(staging);
    const initializer = service(new SqliteWorkspaceAuthority(directory));
    assert.equal((await initializer.create(request)).status, "unconfirmed");
    assert.equal((await initializer.create(request)).status, "unconfirmed");
    assert.equal(checksum(staging), before);
    assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
  });
});

const token = "workspace-test-owner-credential-0123456789";
const request = { creationId: "stable-creation", name: "  我的工作空间  " };
const service = (location: WorkspaceCreationPort) => new WorkspaceInitialization(location, randomUUID, () => new Date().toISOString());
async function withTarget(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "workspace-initialization-test-"));
  try { await run(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[/\\]/).at(-1)?.startsWith("workspace-initialization-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
}
const checksum = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("local initialization trims the name and durably publishes a unique space and authority", async () => {
  await withTarget(async (directory) => {
    const location = new SqliteWorkspaceAuthority(directory);
    const result = await service(location).create(request);
    assert.equal(result.status, "created");
    if (result.status !== "created") return;
    assert.equal(result.workspace.name, "我的工作空间");
    assert.notEqual(result.workspace.workspaceId, result.workspace.authorityId);
    assert.deepEqual(await new SqliteWorkspaceAuthority(directory).inspect(), result.workspace);
    assert.ok(existsSync(join(directory, "workspace.sqlite")));
  });
});

test("same request after reopen returns the original identities without rewriting the target", async () => {
  await withTarget(async (directory) => {
    const first = await service(new SqliteWorkspaceAuthority(directory)).create(request);
    const before = checksum(join(directory, "workspace.sqlite"));
    const second = await service(new SqliteWorkspaceAuthority(directory)).create(request);
    assert.deepEqual(second, first);
    assert.equal(checksum(join(directory, "workspace.sqlite")), before);
  });
});

test("same name at two selected targets creates two independent workspace identities", async () => {
  await withTarget(async (directory) => {
    const a = await service(new SqliteWorkspaceAuthority(join(directory, "one"))).create(request);
    const b = await service(new SqliteWorkspaceAuthority(join(directory, "two"))).create(request);
    assert.equal(a.status, "created"); assert.equal(b.status, "created");
    if (a.status === "created" && b.status === "created") assert.notEqual(a.workspace.workspaceId, b.workspace.workspaceId);
  });
});

test("existing workspace is not overwritten by a different creation request", async () => {
  await withTarget(async (directory) => {
    const location = new SqliteWorkspaceAuthority(directory);
    const first = await service(location).create(request);
    const before = checksum(join(directory, "workspace.sqlite"));
    const next = await service(location).create({ creationId: "another-request", name: "新名字" });
    assert.equal(next.status, "rejected");
    if (next.status === "rejected") assert.equal(next.reason, "target-occupied");
    assert.equal(checksum(join(directory, "workspace.sqlite")), before);
    if (first.status === "created") assert.deepEqual(await location.inspect(), first.workspace);
  });
});

test("an unrelated occupied SQLite target remains byte-for-byte unchanged", async () => {
  await withTarget(async (directory) => {
    const path = join(directory, "workspace.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep me');");
    db.close();
    const before = checksum(path);
    const result = await service(new SqliteWorkspaceAuthority(directory)).create(request);
    assert.equal(result.status, "rejected");
    assert.equal(checksum(path), before);
  });
});

test("reusing a successful creation identity with another name is rejected", async () => {
  await withTarget(async (directory) => {
    const location = new SqliteWorkspaceAuthority(directory);
    const original = await service(location).create(request);
    const result = await service(location).create({ ...request, name: "changed" });
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, "request-mismatch");
    if (original.status === "created") assert.deepEqual(await location.inspect(), original.workspace);
  });
});

test("empty names and unsafe request identities do not create workspace data", async () => {
  await withTarget(async (directory) => {
    const initializer = service(new SqliteWorkspaceAuthority(directory));
    assert.equal((await initializer.create({ ...request, name: "  " })).status, "rejected");
    assert.equal((await initializer.create({ ...request, creationId: "../escape" })).status, "rejected");
    assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
  });
});

test("competing independent requests publish exactly one canonical workspace", async () => {
  await withTarget(async (directory) => {
    const [a, b] = await Promise.all([
      service(new SqliteWorkspaceAuthority(directory)).create({ creationId: "race-a", name: "竞争空间" }),
      service(new SqliteWorkspaceAuthority(directory)).create({ creationId: "race-b", name: "竞争空间" }),
    ]);
    assert.equal([a, b].filter((item) => item.status === "created").length, 1);
    const winner = [a, b].find((item) => item.status === "created");
    assert.ok(winner?.status === "created");
    assert.deepEqual(await new SqliteWorkspaceAuthority(directory).inspect(), winner.workspace);
  });
});

test("remote authority requires owner credentials and does not accept an anonymous claim", async () => {
  await withTarget(async (directory) => {
    const server = await startWorkspaceServer({ directory, token });
    try {
      assert.equal((await fetch(server.url + "/v1/identity")).status, 401);
      const denied = await service(new HttpWorkspaceLocation(server.url, "invalid")).create(request);
      assert.equal(denied.status, "rejected");
      if (denied.status === "rejected") assert.equal(denied.reason, "unauthorized");
      assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
    } finally { await server.close(); }
  });
});

test("HTTP initialization and inspection use the same durable identity and idempotent request", async () => {
  await withTarget(async (directory) => {
    const server = await startWorkspaceServer({ directory, token });
    try {
      const location = new HttpWorkspaceLocation(server.url, token);
      assert.equal(await location.inspect(), null);
      const first = await service(location).create(request);
      assert.equal(first.status, "created");
      assert.deepEqual(await service(location).create(request), first);
      if (first.status === "created") assert.deepEqual(await location.inspect(), first.workspace);
    } finally { await server.close(); }
  });
});

test("two services cannot own one data directory, while restart can resume the same space", async () => {
  await withTarget(async (directory) => {
    const first = await startWorkspaceServer({ directory, token });
    const result = await service(new HttpWorkspaceLocation(first.url, token)).create(request);
    try { await assert.rejects(startWorkspaceServer({ directory, token })); }
    finally { await first.close(); }
    const restarted = await startWorkspaceServer({ directory, token });
    try { assert.deepEqual(await service(new HttpWorkspaceLocation(restarted.url, token)).create(request), result); }
    finally { await restarted.close(); }
  });
});

test("invalid JSON is a clear rejection and does not initialize a space", async () => {
  await withTarget(async (directory) => {
    const server = await startWorkspaceServer({ directory, token });
    try {
      const response = await fetch(server.url + "/v1/initialize", { method: "POST",
        headers: { authorization: "Bearer " + token }, body: "invalid json" });
      assert.equal(response.status, 400);
      assert.equal(existsSync(join(directory, "workspace.sqlite")), false);
    } finally { await server.close(); }
  });
});

test("public plaintext URLs and credential-bearing URLs are rejected before transport", () => {
  assert.throws(() => workspaceServiceUrl("http://example.com"));
  assert.throws(() => workspaceServiceUrl("https://user:password@example.com"));
  assert.equal(workspaceServiceUrl("https://example.com/base").pathname, "/base/");
  assert.equal(workspaceServiceUrl("http://127.0.0.1:1234").protocol, "http:");
});

test("lost HTTP creation response can be inspected and retried without creating a second identity", async () => {
  await withTarget(async (directory) => {
    const server = await startWorkspaceServer({ directory, token });
    try {
      const real = new HttpWorkspaceLocation(server.url, token);
      const lossy: WorkspaceCreationPort = {
        create: async (proposal: WorkspaceProposal) => { await real.create(proposal); throw new Error("lost response"); },
        inspect: () => real.inspect(),
      };
      assert.equal((await service(lossy).create(request)).status, "unconfirmed");
      const identity = await real.inspect();
      assert.ok(identity);
      const retried = await service(real).create(request);
      assert.deepEqual(retried, { status: "created", workspace: identity });
    } finally { await server.close(); }
  });
});


test("existing connection compares both identities without creating or trusting the display name", async () => {
  const { inspectExistingWorkspace } = await import("@workspace/core");
  const original = { workspaceId: "space-1", authorityId: "authority-1", creationId: "request-1", name: "相同名称", createdAt: "2026-10-25T00:00:00.000Z" };
  const renamed = { ...original, name: "修改后的名称" };
  assert.deepEqual(await inspectExistingWorkspace({ inspect: async () => renamed }, original), renamed);
  for (const identity of [{ ...original, workspaceId: "space-2" }, { ...original, authorityId: "authority-2" }]) {
    await assert.rejects(inspectExistingWorkspace({ inspect: async () => identity }, original), /身份.*不一致/);
  }
  await assert.rejects(inspectExistingWorkspace({ inspect: async () => null }, null), /不存在工作空间/);
});

test("existing connection checks identity again when the target changes after preview", async () => {
  const { inspectExistingWorkspace } = await import("@workspace/core");
  const first = { workspaceId: "space-1", authorityId: "authority-1", creationId: "request-1", name: "名称", createdAt: "2026-10-25T00:00:00.000Z" };
  let current = first;
  const location = { inspect: async () => current };
  const preview = await inspectExistingWorkspace(location, null);
  current = { ...first, authorityId: "replaced-authority" };
  await assert.rejects(inspectExistingWorkspace(location, preview), /身份.*不一致/);
});
