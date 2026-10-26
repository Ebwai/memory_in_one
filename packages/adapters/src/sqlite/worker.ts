import { parentPort, workerData } from "node:worker_threads";
import { LocalStoreError } from "@workspace/contracts";
import { LocalDatabase } from "./database.js";
import type { DatabaseOptions } from "./database.js";
import type { StoreRequest, StoreResponse } from "./protocol.js";

const port = parentPort;
if (!port) throw new Error("SQLite storage requires a dedicated worker");

let database: LocalDatabase;
try {
  database = new LocalDatabase(workerData as DatabaseOptions);
  port.postMessage({ type: "ready" } satisfies StoreResponse);
  port.on("message", (request: StoreRequest) => {
    try {
      let value: Extract<StoreResponse, { type: "result" }>["value"] = null;
      switch (request.method) {
        case "commit": value = database.commit(request.input, request.expectedSequence, request.guard); break;
        case "operation": value = database.readOperation(request.input); break;
        case "read": value = database.readRecord(request.input); break;
        case "records": value = database.listRecords(request.input); break;
        case "pending": value = database.listPending(request.input); break;
        case "conflict": value = database.readConflict(request.input); break;
        case "conflicts": value = database.listConflicts(request.input); break;
        case "retain": database.writeConflict(request.input, request.expectedGeneration, request.expectedSequence); break;
        case "finish-conflict": value = database.finishConflict(request.input, request.expectedGeneration, request.expectedSequence, request.record); break;
        case "replication": value = database.replicate(request.input); break;
        case "close": database.close(); break;
      }
      port.postMessage({ type: "result", id: request.id, value } satisfies StoreResponse);
      if (request.method === "close") port.close();
    } catch (error) {
      port.postMessage({ type: "error", id: request.id,
        outcome: error instanceof LocalStoreError ? error.outcome : "not-saved" } satisfies StoreResponse);
    }
  });
} catch {
  port.postMessage({ type: "open-error" } satisfies StoreResponse);
  port.close();
}

