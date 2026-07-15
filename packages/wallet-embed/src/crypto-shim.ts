// IIFE-build shim for Node's "crypto". The LDK bindings only reach `import('crypto')` inside a
// `typeof crypto === "undefined"` fallback that never runs in a browser (global WebCrypto always
// exists), but an IIFE bundle has no import mechanism at all, so the specifier must resolve at
// build time. Same unreachable-fallback rationale as the extension/SW builds' `external: crypto`.
export const webcrypto = undefined;
export default { webcrypto };
