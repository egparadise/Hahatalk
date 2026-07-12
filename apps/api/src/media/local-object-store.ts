import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Readable } from "node:stream";
import { once } from "node:events";
import type { ObjectStore } from "./object-store.js";

export type StoredObject = {
  objectKey: string;
  sha256Hex: string;
  sizeBytes: number;
};

export type ObjectRange = {
  end: number;
  start: number;
};

@Injectable()
export class LocalObjectStore implements ObjectStore, OnModuleInit {
  readonly root = path.resolve(
    process.env.HAHATALK_OBJECT_ROOT?.trim()
      || path.join(process.cwd(), "node_modules", ".cache", "hahatalk-objects")
  );

  async onModuleInit() {
    await mkdir(this.root, { recursive: true });
  }

  absolutePath(objectKey: string) {
    const normalized = objectKey.replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
      throw new Error("Object key is invalid.");
    }
    const resolved = path.resolve(this.root, ...normalized.split("/"));
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Object key escapes the configured object root.");
    }
    return resolved;
  }

  async writeStream(objectKey: string, input: Readable, maxBytes: number): Promise<StoredObject> {
    const destination = this.absolutePath(objectKey);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const output = createWriteStream(temporary, { flags: "wx" });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of input) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          throw new Error("Object exceeds the allowed byte limit.");
        }
        hash.update(chunk);
        if (!output.write(chunk)) {
          await once(output, "drain");
        }
      }
      output.end();
      await once(output, "finish");
      await rm(destination, { force: true });
      await rename(temporary, destination);
      return { objectKey, sha256Hex: hash.digest("hex"), sizeBytes };
    } catch (error) {
      output.destroy();
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async assemble(partKeys: string[], objectKey: string, maxBytes: number): Promise<StoredObject> {
    const destination = this.absolutePath(objectKey);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.partial`;
    const output = createWriteStream(temporary, { flags: "wx" });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for (const partKey of partKeys) {
        for await (const value of createReadStream(this.absolutePath(partKey))) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          sizeBytes += chunk.length;
          if (sizeBytes > maxBytes) {
            throw new Error("Assembled object exceeds the allowed byte limit.");
          }
          hash.update(chunk);
          if (!output.write(chunk)) {
            await once(output, "drain");
          }
        }
      }
      output.end();
      await once(output, "finish");
      await rm(destination, { force: true });
      await rename(temporary, destination);
      return { objectKey, sha256Hex: hash.digest("hex"), sizeBytes };
    } catch (error) {
      output.destroy();
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async move(fromKey: string, toKey: string) {
    const source = this.absolutePath(fromKey);
    const destination = this.absolutePath(toKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { force: true });
    await rename(source, destination);
  }

  async putBuffer(objectKey: string, content: Buffer): Promise<StoredObject> {
    const destination = this.absolutePath(objectKey);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.partial`;
    await writeFile(temporary, content, { flag: "wx" });
    await rm(destination, { force: true });
    await rename(temporary, destination);
    return {
      objectKey,
      sha256Hex: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.length
    };
  }

  async readBuffer(objectKey: string, maxBytes = 104_857_600) {
    const info = await stat(this.absolutePath(objectKey));
    if (info.size > maxBytes) {
      throw new Error("Object is too large to buffer.");
    }
    return readFile(this.absolutePath(objectKey));
  }

  async describe(objectKey: string) {
    const info = await stat(this.absolutePath(objectKey));
    return { sizeBytes: info.size };
  }

  createReadStream(objectKey: string, range?: ObjectRange) {
    return createReadStream(this.absolutePath(objectKey), range ? { start: range.start, end: range.end } : undefined);
  }

  async remove(objectKey: string) {
    await rm(this.absolutePath(objectKey), { force: true });
  }

  async removePrefix(prefix: string) {
    await rm(this.absolutePath(prefix), { force: true, recursive: true });
  }

  async fsync(objectKey: string) {
    const handle = await open(this.absolutePath(objectKey), "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
