import { mkdtemp, rm, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { SessionImageStore } from '../src/session-images.js';
// Fast unit: expected <1s, maximum5s. Detects lost queue blobs and cross-chat references.
it('persists immutable, session-bound image references and recovers an unpublished blob', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herder-images-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmcAAAAASUVORK5CYII=', 'base64');
  const input = { harness: 'zcode', sessionId: 'native-a', fileName: 'tiny.png', mimeType: 'image/png', dataBase64: png.toString('base64') };
  try {
    const store = new SessionImageStore(directory), image = await store.upload(input);
    const resolved = await new SessionImageStore(directory).resolve('zcode', 'native-a', [image.id]);
    expect(await readFile(resolved[0].path)).toEqual(png);
    expect((await stat(resolved[0].path)).mode & 0o777).toBe(0o600);
    await expect(store.resolve('zcode', 'native-b', [image.id])).rejects.toThrow('другому чату');
    await expect(store.resolve('codex', 'native-a', [image.id])).rejects.toThrow('другому чату');
    expect(await store.upload(input)).toEqual(image);
    await unlink(join(directory, `${image.id}.json`));
    expect(await store.upload(input)).toEqual(image);
    expect((await store.content(image.id)).bytes).toEqual(png);
    await expect(store.upload({ ...input, dataBase64: Buffer.from('text').toString('base64') })).rejects.toThrow('формату');
    await expect(store.resolve('zcode', 'native-a', ['../private'])).rejects.toThrow('идентификатор');
    await expect(store.upload({ ...input, dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).rejects.toThrow('5 МБ');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stores a session-bound generic file for Codex mention input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herder-files-'));
  const input = { harness: 'codex', sessionId: 'native-file', fileName: 'notes.txt', mimeType: 'text/plain', kind: 'file' as const, dataBase64: Buffer.from('hello Codex').toString('base64') };
  try {
    const store = new SessionImageStore(directory), file = await store.upload(input);
    expect(file.kind).toBe('file');
    expect(file.url).toBe(`/api/session-files/${file.id}`);
    const resolved = await store.resolve('codex', 'native-file', [file.id]);
    expect(resolved[0]).toMatchObject({ kind: 'file', fileName: 'notes.txt', mimeType: 'text/plain' });
    expect(await readFile(resolved[0].path, 'utf8')).toBe('hello Codex');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
