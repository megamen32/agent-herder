import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { MessageImage } from "./types/index.js";

export interface UploadedImage { id: string; fileName: string; mimeType: string; bytes: number; url: string }
interface StoredImage extends UploadedImage { harness: string; sessionId: string; path: string }
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Immutable image references survive queued delivery and browser reload. */
export class SessionImageStore {
  constructor(private readonly directory: string) {}
  async upload(input: { harness: string; sessionId: string; fileName: string; mimeType: string; dataBase64: string }): Promise<UploadedImage> {
    const extension = EXTENSIONS[input.mimeType];
    if (!extension || typeof input.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw new Error("Прикрепите изображение PNG, JPEG или WebP.");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Изображение должно быть не больше 5 МБ.");
    const valid = input.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : input.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("Содержимое файла не соответствует формату изображения.");
    const fileName = input.fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || `image.${extension}`;
    const id = createHash("sha256").update(`${input.harness}\0${input.sessionId}\0${fileName}\0`).update(bytes).digest("hex");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, "store.lock"); await writeFile(target, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(target, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    try {
      try { return this.public(await this.read(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const files = await readdir(this.directory, { withFileTypes: true });
      if (files.length > 2000) throw new Error("Хранилище изображений заполнено.");
      let used = 0;
      for (const file of files) if (file.isFile() && /\.(png|jpg|webp)$/.test(file.name)) used += (await stat(join(this.directory, file.name))).size;
      if (used + bytes.length > MAX_STORE_BYTES) throw new Error("Хранилище изображений заполнено.");
      const path = join(this.directory, `${id}.${extension}`);
      const image: StoredImage = { id, harness: input.harness, sessionId: input.sessionId, fileName, mimeType: input.mimeType, bytes: bytes.length, url: `/api/session-images/${id}`, path };
      try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { // Recover an immutable blob left before metadata publication.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error;
      }
      await writeFile(join(this.directory, `${id}.json`), JSON.stringify(image), { flag: "wx", mode: 0o600 });
      return this.public(image);
    } finally { await release(); }
  }
  async resolve(harness: string, sessionId: string, ids: unknown): Promise<MessageImage[]> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => typeof id !== "string")) throw new Error("Можно прикрепить до четырёх изображений.");
    return Promise.all(ids.map(async (id) => {
      const image = await this.read(id);
      if (image.harness !== harness || image.sessionId !== sessionId) throw new Error("Изображение принадлежит другому чату.");
      return { id: image.id, path: image.path, fileName: image.fileName, mimeType: image.mimeType, bytes: image.bytes };
    }));
  }
  async content(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const image = await this.read(id); return { bytes: await readFile(image.path), mimeType: image.mimeType };
  }
  private async read(id: string): Promise<StoredImage> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Неверный идентификатор изображения.");
    return JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as StoredImage;
  }
  private public(image: StoredImage): UploadedImage {
    return { id: image.id, fileName: image.fileName, mimeType: image.mimeType, bytes: image.bytes, url: image.url };
  }
}
