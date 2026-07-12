import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import exifr from "exifr";
import type { MediaKind } from "@hahatalk/contracts";
import { type ObjectStore, objectStoreToken } from "./object-store.js";

const execFileAsync = promisify(execFile);
const eicarMarker = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";
const hahaTalkMalwareTestMarker = "HAHATALK-BLOCKED-MALWARE-TEST-FILE";
const dangerousExtensions = new Set([
  ".bat", ".cmd", ".com", ".cpl", ".dll", ".exe", ".hta", ".iso", ".jar", ".js",
  ".lnk", ".msi", ".msp", ".ps1", ".reg", ".scr", ".vbs", ".wsf"
]);
const allowedExtensions = new Set([
  ".avif", ".csv", ".doc", ".docx", ".gif", ".heic", ".heif", ".jpeg", ".jpg",
  ".json", ".m4a", ".mov", ".mp3", ".mp4", ".ogg", ".pdf", ".png", ".ppt", ".pptx",
  ".txt", ".wav", ".webm", ".webp", ".xls", ".xlsx"
]);
const officeExtensions = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
const textExtensions = new Set([".csv", ".json", ".txt"]);

export type MediaInspection = {
  blockedCode?: string;
  capturedAt?: Date;
  capturedLocalAt?: string;
  capturedTimezone?: string;
  detectedMimeType: string;
  height?: number;
  latitude?: number;
  longitude?: number;
  mediaKind: MediaKind;
  privateMetadata: Record<string, string | number>;
  scanEngine: string;
  scanSummary: string;
  width?: number;
};

function normalizeMime(value: string) {
  return value.toLowerCase().split(";", 1)[0]?.trim() || "application/octet-stream";
}

function isExecutableHeader(buffer: Buffer) {
  if (buffer.length < 4) return false;
  return buffer.subarray(0, 2).equals(Buffer.from("MZ"))
    || buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(buffer.readUInt32BE(0));
}

function inferKind(mimeType: string, extension: string): MediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  if (textExtensions.has(extension) || mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  if (officeExtensions.has(extension)) return "office";
  return "file";
}

function declaredMimeMatches(declared: string, detected: string, extension: string) {
  if (declared === "application/octet-stream") return true;
  if (declared === detected) return true;
  if (declared === "image/jpg" && detected === "image/jpeg") return true;
  if (extension === ".m4a" && ["audio/mp4", "video/mp4"].includes(detected) && declared.startsWith("audio/")) return true;
  if (officeExtensions.has(extension) && ["application/zip", "application/x-cfb"].includes(detected)) return true;
  return false;
}

function formatLocalExifDate(value: unknown) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function parseOffsetDate(localValue: string | undefined, offset: string | undefined) {
  if (!localValue || !offset || !/^[+-]\d{2}:\d{2}$/.test(offset)) return undefined;
  const isoLocal = localValue.replace(" ", "T");
  const value = new Date(`${isoLocal}${offset}`);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

@Injectable()
export class MediaInspector {
  constructor(@Inject(objectStoreToken) private readonly objects: ObjectStore) {}

  async inspect(objectKey: string, originalFileName: string, declaredMimeType: string): Promise<MediaInspection> {
    const extension = path.extname(originalFileName).toLowerCase();
    const absolutePath = this.objects.absolutePath(objectKey);
    const content = await this.objects.readBuffer(objectKey, 104_857_600);
    const head = content.subarray(0, 8192);
    const declared = normalizeMime(declaredMimeType);
    const detectedFileType = await fileTypeFromBuffer(content);
    let detected = normalizeMime(detectedFileType?.mime ?? "application/octet-stream");

    if (textExtensions.has(extension) && !head.includes(0)) {
      detected = extension === ".json" ? "application/json" : "text/plain";
    }
    if (extension === ".pdf" && head.subarray(0, 5).toString("ascii") === "%PDF-") {
      detected = "application/pdf";
    }

    const base: MediaInspection = {
      detectedMimeType: detected,
      mediaKind: inferKind(detected, extension),
      privateMetadata: {},
      scanEngine: "baseline-signature-v1",
      scanSummary: "clean"
    };

    if (!allowedExtensions.has(extension) || dangerousExtensions.has(extension)) {
      return { ...base, blockedCode: "extension_not_allowed", scanSummary: "blocked" };
    }
    if (isExecutableHeader(head)) {
      return { ...base, blockedCode: "executable_signature", scanSummary: "blocked" };
    }
    if (
      content.includes(Buffer.from(eicarMarker, "ascii"))
      || content.includes(Buffer.from(hahaTalkMalwareTestMarker, "ascii"))
    ) {
      return { ...base, blockedCode: "malware_test_signature", scanSummary: "blocked" };
    }
    if (detected === "application/octet-stream" && !officeExtensions.has(extension)) {
      return { ...base, blockedCode: "unknown_binary_type", scanSummary: "blocked" };
    }
    if (!declaredMimeMatches(declared, detected, extension)) {
      return { ...base, blockedCode: "mime_mismatch", scanSummary: "blocked" };
    }

    const clamPath = process.env.HAHATALK_CLAMSCAN_PATH?.trim();
    if (clamPath) {
      try {
        await execFileAsync(clamPath, ["--no-summary", absolutePath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        base.scanEngine = "clamav";
      } catch (error) {
        const exitCode = (error as { code?: number }).code;
        return {
          ...base,
          blockedCode: exitCode === 1 ? "clamav_infected" : "clamav_scan_failed",
          scanEngine: "clamav",
          scanSummary: exitCode === 1 ? "blocked" : "failed"
        };
      }
    }

    if (base.mediaKind === "image") {
      try {
        const metadata = await exifr.parse(absolutePath, [
          "DateTimeOriginal", "CreateDate", "DateTimeDigitized", "OffsetTimeOriginal",
          "latitude", "longitude", "ImageWidth", "ImageHeight", "ExifImageWidth", "ExifImageHeight",
          "Make", "Model", "Orientation"
        ]) as Record<string, unknown> | undefined;
        if (metadata) {
          const localDate = formatLocalExifDate(metadata.DateTimeOriginal ?? metadata.CreateDate ?? metadata.DateTimeDigitized);
          const offset = typeof metadata.OffsetTimeOriginal === "string" ? metadata.OffsetTimeOriginal : undefined;
          const latitude = typeof metadata.latitude === "number" ? metadata.latitude : undefined;
          const longitude = typeof metadata.longitude === "number" ? metadata.longitude : undefined;
          const width = Number(metadata.ExifImageWidth ?? metadata.ImageWidth) || undefined;
          const height = Number(metadata.ExifImageHeight ?? metadata.ImageHeight) || undefined;
          const capturedAt = parseOffsetDate(localDate, offset);
          return {
            ...base,
            ...(localDate ? { capturedLocalAt: localDate } : {}),
            ...(offset ? { capturedTimezone: offset } : {}),
            ...(capturedAt ? { capturedAt } : {}),
            ...(latitude !== undefined ? { latitude } : {}),
            ...(longitude !== undefined ? { longitude } : {}),
            ...(width ? { width } : {}),
            ...(height ? { height } : {}),
            privateMetadata: Object.fromEntries(
              ["Make", "Model", "Orientation"].flatMap((key) => {
                const value = metadata[key];
                return typeof value === "string" || typeof value === "number" ? [[key, value]] : [];
              })
            )
          };
        }
      } catch {
        return { ...base, scanSummary: "clean" };
      }
    }
    return base;
  }

  createGpsStrippedImage(content: Buffer, mimeType: string) {
    if (mimeType === "image/jpeg") return stripJpegMetadata(content);
    if (mimeType === "image/png") return stripPngMetadata(content);
    if (mimeType === "image/webp") return stripWebpMetadata(content);
    return undefined;
  }
}

function stripJpegMetadata(content: Buffer) {
  if (content.length < 4 || content[0] !== 0xff || content[1] !== 0xd8) return undefined;
  const chunks: Buffer[] = [content.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= content.length) {
    if (content[offset] !== 0xff) return undefined;
    const marker = content[offset + 1]!;
    if (marker === 0xda) {
      chunks.push(content.subarray(offset));
      return Buffer.concat(chunks);
    }
    if (marker === 0xd9) {
      chunks.push(content.subarray(offset, offset + 2));
      return Buffer.concat(chunks);
    }
    const length = content.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > content.length) return undefined;
    if (![0xe1, 0xed, 0xfe].includes(marker)) {
      chunks.push(content.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return undefined;
}

function stripPngMetadata(content: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!content.subarray(0, 8).equals(signature)) return undefined;
  const chunks: Buffer[] = [signature];
  const blocked = new Set(["eXIf", "iTXt", "tEXt", "zTXt", "tIME"]);
  let offset = 8;
  while (offset + 12 <= content.length) {
    const length = content.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > content.length) return undefined;
    const type = content.subarray(offset + 4, offset + 8).toString("ascii");
    if (!blocked.has(type)) chunks.push(content.subarray(offset, end));
    offset = end;
    if (type === "IEND") return Buffer.concat(chunks);
  }
  return undefined;
}

function stripWebpMetadata(content: Buffer) {
  if (content.length < 12 || content.subarray(0, 4).toString("ascii") !== "RIFF" || content.subarray(8, 12).toString("ascii") !== "WEBP") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= content.length) {
    const type = content.subarray(offset, offset + 4).toString("ascii");
    const length = content.readUInt32LE(offset + 4);
    const paddedLength = length + (length % 2);
    const end = offset + 8 + paddedLength;
    if (end > content.length) return undefined;
    if (!["EXIF", "XMP "].includes(type)) chunks.push(content.subarray(offset, end));
    offset = end;
  }
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
