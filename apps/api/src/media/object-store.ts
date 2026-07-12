import type { Readable } from "node:stream";
import type { ObjectRange, StoredObject } from "./local-object-store.js";

export const objectStoreToken = Symbol("HahaTalkObjectStore");

export interface ObjectStore {
  absolutePath(objectKey: string): string;
  assemble(partKeys: string[], objectKey: string, maxBytes: number): Promise<StoredObject>;
  createReadStream(objectKey: string, range?: ObjectRange): Readable;
  describe(objectKey: string): Promise<{ sizeBytes: number }>;
  fsync(objectKey: string): Promise<void>;
  move(fromKey: string, toKey: string): Promise<void>;
  putBuffer(objectKey: string, content: Buffer): Promise<StoredObject>;
  readBuffer(objectKey: string, maxBytes?: number): Promise<Buffer>;
  remove(objectKey: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  writeStream(objectKey: string, input: Readable, maxBytes: number): Promise<StoredObject>;
}
