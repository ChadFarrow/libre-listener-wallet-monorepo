// Immutable screen-stack state for the app's push/pop navigation. Pure — the DOM layer
// (ui/screen-shell.ts) applies transitions from these transitions' results.

export type ScreenStack = readonly string[];

export function initialStack(root: string): ScreenStack {
  return [root];
}

export function current(stack: ScreenStack): string {
  return stack[stack.length - 1];
}

export function push(stack: ScreenStack, id: string): ScreenStack {
  if (current(stack) === id) return stack; // double-tap can't stack duplicates
  return [...stack, id];
}

export function pop(stack: ScreenStack): ScreenStack {
  if (stack.length <= 1) return stack; // never pop past the root
  return stack.slice(0, -1);
}

export function resetToRoot(stack: ScreenStack): ScreenStack {
  return [stack[0]];
}
