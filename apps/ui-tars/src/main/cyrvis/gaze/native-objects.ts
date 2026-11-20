import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, desktopCapturer, screen } from 'electron';
import type { DesktopGaze } from './context';
import {
  distanceToObject,
  type GazeObject,
  type ObjectBounds,
} from './objects';
import type { ObjectScan } from './object-tracker';

const exec = promisify(execFile);
interface NativeResult extends ObjectScan {
  permission?: boolean;
  clip?: ObjectBounds;
  windowId?: number;
}
export class NativeGazeObjects {
  private child: ChildProcessWithoutNullStreams | null = null;
  private binary: Promise<string> | null = null;
  private pending: {
    resolve: (result: NativeResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(
    private withoutOverlay: <T>(capture: () => Promise<T>) => Promise<T> = (
      capture,
    ) => capture(),
  ) {
    app.once('before-quit', () => this.close());
  }
  close() {
    this.pending?.reject(new Error('对象识别已关闭'));
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.child?.kill();
    this.child = null;
  }
  private prepare() {
    this.binary ??= (async () => {
      const source = await fs.readFile(
        path.join(__dirname, '../../resources/native/gaze-objects.swift'),
      );
      const directory = path.join(app.getPath('userData'), 'gaze-native');
      await fs.mkdir(directory, { recursive: true });
      const hash = createHash('sha256')
        .update(source)
        .digest('hex')
        .slice(0, 16);
      const binary = path.join(directory, `objects-${hash}-${process.arch}`);
      try {
        await fs.access(binary);
        return binary;
      } catch {}
      const swift = path.join(directory, `objects-${hash}.swift`);
      await fs.writeFile(swift, source);
      try {
        await exec('/usr/bin/xcrun', ['swiftc', '-O', swift, '-o', binary], {
          timeout: 90_000,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new Error(
          '本地对象识别需要 Xcode 命令行工具（swiftc），请安装后重启。',
        );
      }
      return binary;
    })();
    return this.binary;
  }
  private async request(payload: object): Promise<NativeResult> {
    if (this.pending) throw new Error('本地对象识别繁忙');
    if (!this.child) {
      const binary = await this.prepare();
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.resume();
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1_000_000) {
          this.close();
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          try {
            pending.resolve(JSON.parse(line));
          } catch {
            pending.reject(new Error('本地对象识别返回无效'));
          }
        }
      });
      const fail = () => {
        if (this.child !== child) return;
        this.close();
      };
      child.on('error', fail);
      child.on('exit', fail);
      child.stdin.on('error', fail);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 1400);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify(payload) + '\n');
    });
  }
  async scan(gaze: DesktopGaze): Promise<ObjectScan> {
    if (process.platform !== 'darwin')
      return {
        scene: 'unsupported',
        objects: [],
        error: '当前对象吸附适配 macOS；其他系统可关闭吸附使用原光标。',
      };
    const point = {
      x: gaze.bounds.x + gaze.x * gaze.bounds.width,
      y: gaze.bounds.y + gaze.y * gaze.bounds.height,
    };
    const native = await this.request({ ...point, bounds: gaze.bounds });
    const objects = Array.isArray(native.objects) ? native.objects : [];
    // Prefer app semantics. Local Vision fills in image cards/canvases when
    // accessibility exposes only containers or no nearby objects.
    const nearby = objects.some(
      (o) =>
        o.source === 'accessibility' &&
        o.role !== 'AXStaticText' &&
        distanceToObject(point.x, point.y, o.bounds) < 90,
    );
    if (nearby) return { ...native, objects };
    const display = screen.getPrimaryDisplay();
    if (display.id !== gaze.displayId)
      throw new Error('主屏幕已改变，请重新校准。');
    // A window thumbnail excludes our independent highlight overlay, so it
    // can remain visible while image regions are refreshed. Desktop fallback
    // briefly removes the overlay when no capturable app window exists.
    const windows = native.windowId
      ? await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: display.size,
        })
      : [];
    let image = windows.find(
      (item) => item.id.split(':')[1] === String(native.windowId),
    )?.thumbnail;
    let imageBounds = native.clip || gaze.bounds;
    if (!image || image.isEmpty()) {
      const sources = await this.withoutOverlay(() =>
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: display.size,
        }),
      );
      image = sources.find(
        (item) => item.display_id === String(gaze.displayId),
      )?.thumbnail;
      imageBounds = gaze.bounds;
    }
    if (!image || image.isEmpty())
      return {
        ...native,
        objects,
        error: '请允许 Electron/CYRVIS 录制屏幕，才能本地识别图像区域。',
      };
    const visual = await this.request({
      image: image.toJPEG(65).toString('base64'),
      bounds: imageBounds,
      scene: native.scene,
      clip: native.clip || gaze.bounds,
      ...point,
    });
    // AX text and OCR often describe the same line; prefer native elements.
    const extra = (visual.objects || []).filter(
      (o) =>
        !objects.some(
          (a) =>
            distanceToObject(
              o.bounds.x + o.bounds.width / 2,
              o.bounds.y + o.bounds.height / 2,
              a.bounds,
            ) === 0,
        ),
    );
    return {
      scene: native.scene,
      objects: [...objects, ...extra] as GazeObject[],
      error:
        native.permission === false
          ? '辅助功能权限未开启，正在使用本地图像区域识别。'
          : visual.error,
    };
  }
}
