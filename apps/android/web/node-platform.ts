import { canonical } from '@workspace/contracts';
export const randomUUID = () => crypto.randomUUID();
export const mkdirSync = () => undefined;
export const resolve = (value: string) => value;
export const dirname = (value: string) => value.substring(0, value.lastIndexOf('/'));
export const join = (...parts: string[]) => parts.join('/');
export const isDeepStrictEqual = (a: unknown, b: unknown) => canonical(a as never) === canonical(b as never);
export function createHash(_algorithm: string) { let source = ''; return { update(text: string) { source += text; return this; }, digest(_format: string) { return window.AndroidPlatform.hash(source); } }; }
