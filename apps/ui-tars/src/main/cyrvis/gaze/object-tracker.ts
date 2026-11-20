import type { DesktopGaze } from './context';
import {
  ObjectMagnet,
  objectGaze,
  type GazeObject,
  type ObjectFixation,
} from './objects';
export interface ObjectScan {
  objects: GazeObject[];
  scene: string;
  error?: string;
}
export interface GazeObjectStatus {
  enabled: boolean;
  phase: ObjectFixation['phase'];
  target?: GazeObject;
  progress: number;
  error?: string;
  objects: number;
}
interface Dependencies {
  scan: (gaze: DesktopGaze) => Promise<ObjectScan>;
  render: (fixation: ObjectFixation | null) => void;
  onGaze: (gaze: DesktopGaze | null) => void;
  now?: () => number;
}
/** Discovery is local and bounded; late scans cannot resurrect a lost gaze. */
export class GazeObjectTracker {
  private magnet = new ObjectMagnet();
  private enabled = true;
  private generation = 0;
  private last: DesktopGaze | null = null;
  private scanAt = -Infinity;
  private busy = false;
  private expires: ReturnType<typeof setTimeout> | null = null;
  private status: GazeObjectStatus = {
    enabled: true,
    phase: 'searching',
    progress: 0,
    objects: 0,
  };
  private now: () => number;
  constructor(private deps: Dependencies) {
    this.now = deps.now || Date.now;
  }
  getStatus() {
    return { ...this.status };
  }
  configure(enabled: boolean) {
    this.clear();
    this.enabled = enabled;
    this.status = { enabled, phase: 'searching', progress: 0, objects: 0 };
    return this.getStatus();
  }
  clear() {
    this.generation++;
    this.last = null;
    this.magnet.reset();
    this.scanAt = -Infinity;
    if (this.expires) clearTimeout(this.expires);
    this.expires = null;
    this.status = {
      ...this.status,
      phase: 'searching',
      target: undefined,
      progress: 0,
      objects: 0,
    };
    this.deps.render(null);
    this.deps.onGaze(null);
  }
  update(gaze: DesktopGaze | null) {
    if (!this.enabled) return;
    if (!gaze || this.now() - gaze.at > 800) {
      this.clear();
      return;
    }
    this.last = gaze;
    if (this.expires) clearTimeout(this.expires);
    this.expires = setTimeout(() => this.clear(), 800);
    this.publish();
    if (this.busy || this.now() - this.scanAt < 650) return;
    this.busy = true;
    this.scanAt = this.now();
    const generation = this.generation;
    const started = this.now();
    void this.deps
      .scan(gaze)
      .then((scan) => {
        if (
          generation !== this.generation ||
          !this.last ||
          this.now() - this.last.at > 800 ||
          this.now() - started > 1800
        )
          return;
        this.magnet.refresh(scan.objects, scan.scene, started);
        this.status = {
          ...this.status,
          error: scan.error,
          objects: scan.objects.length,
        };
        this.publish();
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.magnet.reset();
        this.status = {
          ...this.status,
          error: error instanceof Error ? error.message : '对象识别失败',
          objects: 0,
        };
        this.publish();
      })
      .finally(() => {
        this.busy = false;
      });
  }
  private publish() {
    const state = this.magnet.update(this.last, this.now());
    this.status = { ...this.status, ...state, target: state.target };
    this.deps.render(state.target ? state : null);
    this.deps.onGaze(
      state.phase === 'locked' && state.target && this.last
        ? objectGaze(this.last, state.target)
        : null,
    );
  }
}
