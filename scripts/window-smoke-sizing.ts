export type WindowSize = {
  width: number;
  height: number;
};

export const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1920, height: 1080 };
export const MINIMUM_WINDOW_SIZE: WindowSize = { width: 1100, height: 680 };
export const WINDOW_SIZE_TOLERANCE_PX = 4;

export function expectedInitialWindowSize(
  displayBounds: WindowSize,
  displayWorkArea: WindowSize,
): WindowSize {
  return {
    width:
      displayBounds.width >= DEFAULT_WINDOW_SIZE.width
        ? DEFAULT_WINDOW_SIZE.width
        : Math.max(MINIMUM_WINDOW_SIZE.width, displayWorkArea.width),
    height:
      displayBounds.height >= DEFAULT_WINDOW_SIZE.height
        ? DEFAULT_WINDOW_SIZE.height
        : Math.max(MINIMUM_WINDOW_SIZE.height, displayWorkArea.height),
  };
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
