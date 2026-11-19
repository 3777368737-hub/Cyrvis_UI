/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDesktopHost } from './desktop-host';
import { createFastToolMatrix, type FastToolMatrix } from './matrix';

describe('foundation atomic tools', () => {
  let root: string;
  let matrix: FastToolMatrix;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-foundation-'));
    matrix = createFastToolMatrix(new LocalDesktopHost(), root);
  });

  afterEach(async () => {
    matrix.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('registers observation, execution, condition, and system primitives', () => {
    const toolIds = new Set(matrix.registry.list().map((tool) => tool.name));
    for (const toolId of [
      'screen.capture',
      'screen.ocr',
      'ui.inspect',
      'ui.action',
      'condition.check',
      'condition.wait',
      'process.run',
      'process.start',
      'process.stop',
      'process.inspect',
      'web.fetch',
      'web.download',
      'system.time',
      'system.media',
      'system.power',
      'network.interfaces',
      'fs.exists',
      'fs.hash',
    ]) {
      expect(toolIds.has(toolId)).toBe(true);
    }
    expect(matrix.surface.snapshot().visibleToolIds.length).toBeLessThanOrEqual(
      24,
    );
  });

  it('checks a missing path and waits for it to appear', async () => {
    const target = path.join(root, 'arrives-later.txt');
    const missing = await matrix.registry.execute('condition.check', {
      kind: 'path_missing',
      target,
    });
    expect(missing.ok).toBe(true);

    const waiter = matrix.registry.execute('condition.wait', {
      kind: 'path_exists',
      target,
      timeoutMs: 2_000,
      intervalMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(target, 'ready', 'utf8');

    await expect(waiter).resolves.toMatchObject({ ok: true });
  });

  it('reports existence and a streaming SHA-256 hash', async () => {
    const target = path.join(root, 'hash.txt');
    await fs.writeFile(target, 'cyrvis', 'utf8');

    await expect(
      matrix.registry.execute('fs.exists', { path: target }),
    ).resolves.toMatchObject({
      ok: true,
      data: { exists: true, kind: 'file' },
    });
    const hashed = await matrix.registry.execute('fs.hash', { path: target });
    expect(hashed).toMatchObject({
      ok: true,
      data: {
        algorithm: 'sha256',
        digest:
          '44ac655d2e825ca0761597f7a590f376b4dd427a229fe26c935450a103e8b1cf',
      },
    });
  });

  it('runs an executable without invoking a shell', async () => {
    const result = await matrix.registry.execute(
      'process.run',
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("cyrvis-process-ok")'],
        cwd: root,
        timeoutMs: 5_000,
      },
      { confirmed: true },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        code: 0,
        stdout: 'cyrvis-process-ok',
        timedOut: false,
      },
    });
  });

  it('fetches and downloads bounded content from an HTTP endpoint', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(
        request.url === '/large'
          ? 'x'.repeat(2_048)
          : `response:${request.url}`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('HTTP test server did not expose a port');
    }
    const url = `http://127.0.0.1:${address.port}/hello`;

    try {
      const fetched = await matrix.registry.execute(
        'web.fetch',
        { url, maxBytes: 4_096 },
        { confirmed: true },
      );
      expect(fetched).toMatchObject({
        ok: true,
        data: {
          status: 200,
          encoding: 'utf8',
          content: 'response:/hello',
        },
      });

      const destination = path.join(root, 'download.txt');
      const downloaded = await matrix.registry.execute(
        'web.download',
        { url, path: destination, maxBytes: 4_096 },
        { confirmed: true },
      );
      expect(downloaded).toMatchObject({ ok: true });
      await expect(fs.readFile(destination, 'utf8')).resolves.toBe(
        'response:/hello',
      );

      const tooLargePath = path.join(root, 'too-large.bin');
      const tooLarge = await matrix.registry.execute(
        'web.download',
        {
          url: `http://127.0.0.1:${address.port}/large`,
          path: tooLargePath,
          maxBytes: 1_024,
        },
        { confirmed: true },
      );
      expect(tooLarge).toMatchObject({
        ok: false,
        error: { code: 'DOWNLOAD_TOO_LARGE' },
      });
      await expect(fs.stat(tooLargePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('exposes current time and network interfaces as structured data', async () => {
    const time = await matrix.registry.execute('system.time', {
      timezone: 'Asia/Shanghai',
    });
    expect(time).toMatchObject({
      ok: true,
      data: { timeZone: 'Asia/Shanghai' },
    });

    const network = await matrix.registry.execute('network.interfaces', {});
    expect(network.ok).toBe(true);
    expect(
      Array.isArray((network.data as { interfaces?: unknown[] }).interfaces),
    ).toBe(true);
  });
});
