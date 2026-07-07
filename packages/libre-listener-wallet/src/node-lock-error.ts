import { NODE_ALREADY_RUNNING_CODE } from "@libre/shared";

// Thrown by start() when another context in this origin already holds the single-node lock. Code is
// mirrored in the message so it survives the extension's chrome.runtime error-flattening.
export class NodeAlreadyRunningError extends Error {
  readonly code = NODE_ALREADY_RUNNING_CODE;
  constructor() {
    super(
      `[${NODE_ALREADY_RUNNING_CODE}] This wallet is already running in another tab, window, or ` +
        `context. Close the other one and try again.`,
    );
    this.name = "NodeAlreadyRunningError";
  }
}
