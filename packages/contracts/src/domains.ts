import type { JsonObject } from "./local-persistence.js";

export interface ExtensionDefinition {
  readonly format: 1;
  readonly domainId: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: 1;
  readonly dataVersion: 1;
  readonly access: "own-domain";
  readonly schema: JsonObject;
  readonly view: { readonly titleField: string; readonly fields: readonly string[] };
  readonly actions: readonly ("create" | "update" | "delete")[];
}
export interface DomainRegistration {
  readonly definition: ExtensionDefinition;
  readonly fingerprint: string;
  readonly enabled: boolean;
}
export interface ExtensionPrograms {
  stage(definition: ExtensionDefinition): Promise<string>;
  available(fingerprint: string): Promise<boolean>;
  remove(fingerprint: string): Promise<void>;
}
export interface DomainEntry extends DomainRegistration {
  readonly programAvailable: boolean;
}
