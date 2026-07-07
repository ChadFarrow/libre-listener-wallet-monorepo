// Escape untrusted strings before assignment to innerHTML (boostagram notes, counterparty
// pubkeys, grant origins). Mirrors the standard HTML-entity set used across the UI so every
// innerHTML sink shares one hardened implementation.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
