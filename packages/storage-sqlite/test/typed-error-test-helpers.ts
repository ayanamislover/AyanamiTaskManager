import { isAtmError, type AtmError } from "@ayanami-task/errors";

export function captureAtmError(action: () => unknown): AtmError {
  try {
    action();
  } catch (error) {
    if (isAtmError(error)) return error;
    throw error;
  }
  throw new Error("Expected action to throw AtmError");
}
