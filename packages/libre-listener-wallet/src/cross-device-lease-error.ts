import { SINGLE_DEVICE_VIOLATION_CODE } from "@libre/shared";

// Thrown by start() when the shared VSS store shows this wallet is already running (a live lease) on
// ANOTHER device. Refusing to start is the safe outcome — two devices on one channel force-close it.
// Code is mirrored in the message so it survives the extension's chrome.runtime error-flattening.
export class CrossDeviceLockError extends Error {
  readonly code = SINGLE_DEVICE_VIOLATION_CODE;
  constructor(detail?: string) {
    super(
      `[${SINGLE_DEVICE_VIOLATION_CODE}] This wallet is already running on another device. ` +
        `Close it there first, then try again${detail ? ` (${detail})` : ""}.`,
    );
    this.name = "CrossDeviceLockError";
  }
}
