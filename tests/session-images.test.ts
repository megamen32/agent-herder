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
