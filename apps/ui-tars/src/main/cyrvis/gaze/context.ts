import { screen } from 'electron';

export interface DesktopGaze {
  x: number;
  y: number;
  at: number;
  displayId: number;
  bounds: { x: number; y: number; width: number; height: number };
}
let sample: DesktopGaze | null = null;

export function setDesktopGaze(value: { x: number; y: number } | null) {
  const display = screen.getPrimaryDisplay();
  sample = value
    ? {
        ...value,
        at: Date.now(),
        displayId: display.id,
        bounds: { ...display.bounds },
      }
    : null;
}

export function getDesktopGaze(): DesktopGaze | null {
  if (!sample || Date.now() - sample.at > 3500) return null;
  const display = screen.getPrimaryDisplay();
  if (
    display.id !== sample.displayId ||
    Object.keys(sample.bounds).some(
      (key) =>
        sample!.bounds[key as keyof DesktopGaze['bounds']] !==
        display.bounds[key as keyof DesktopGaze['bounds']],
    )
  )
    return null;
  return { ...sample, bounds: { ...sample.bounds } };
}

export function desktopGazeHint() {
  const gaze = getDesktopGaze();
  if (!gaze) return '';
  return `用户近期注视主屏幕的比例位置 x=${gaze.x.toFixed(3)}, y=${gaze.y.toFixed(3)}（左上为0,0；右下为1,1）。眼动精度未验证，只是消歧线索，不是点击指令。坐标不代表屏幕内容；用户问正在看什么时，必须调用 inspect_gaze_target 获取真实截图识别结果，不能凭坐标猜测。`;
}
