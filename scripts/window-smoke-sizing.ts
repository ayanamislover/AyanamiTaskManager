export type WindowSize = {
  width: number;
  height: number;
};

/**
 * 原生宿主的窗口契约（apps/desktop/native/host/src/app.rs ensure_window）：
 * with_inner_size(1440×900) 与 with_min_inner_size(1100×680)，都是逻辑像素、指客户区。
 * Electron 时代默认 1920×1080 并按工作区收缩；原生宿主不按工作区收缩。
 */
export const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1440, height: 900 };
export const MINIMUM_WINDOW_SIZE: WindowSize = { width: 1100, height: 680 };
export const WINDOW_SIZE_TOLERANCE_PX = 4;

/** 物理像素换逻辑像素（GetDpiForWindow，96 = 100%）。 */
export function logicalWindowSize(physical: WindowSize, dpi: number): WindowSize {
  const scale = dpi / 96;
  return { width: physical.width / scale, height: physical.height / scale };
}

/**
 * 首次打开时客户区应有的逻辑尺寸。显示器放得下默认尺寸时必须严格是默认值；
 * 放不下时由系统按最大可拖尺寸裁掉，宿主自己没有约定，这里返回 null，只做区间检查。
 */
export function expectedInitialWindowSize(displayBounds: WindowSize): WindowSize | null {
  return displayBounds.width >= DEFAULT_WINDOW_SIZE.width &&
    displayBounds.height >= DEFAULT_WINDOW_SIZE.height
    ? DEFAULT_WINDOW_SIZE
    : null;
}

/** 放不下默认尺寸时的兜底：不小于最小尺寸，也不超出显示器。 */
export function initialWindowSizeAcceptable(
  actual: WindowSize,
  displayBounds: WindowSize,
  tolerance = WINDOW_SIZE_TOLERANCE_PX,
): boolean {
  const expected = expectedInitialWindowSize(displayBounds);
  if (expected) return windowSizeMatches(actual, expected, tolerance);
  return (["width", "height"] as const).every(
    (side) =>
      actual[side] >= MINIMUM_WINDOW_SIZE[side] - tolerance &&
      actual[side] <= Math.max(MINIMUM_WINDOW_SIZE[side], displayBounds[side]) + tolerance,
  );
}

export function windowSizeMatches(
  actual: WindowSize,
  expected: WindowSize,
  tolerance = WINDOW_SIZE_TOLERANCE_PX,
): boolean {
  return (
    Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance
  );
}
