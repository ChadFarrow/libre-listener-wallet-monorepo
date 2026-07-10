import type { NwcMethod } from "@libre/shared";

// Permission presets for the connection-create screen. get_info and list_transactions are
// in NWC_ALWAYS_ALLOWED_METHODS (never gated), so "readonly" = balance + history only.

export const NWC_PERMISSION_PRESETS = ["full", "pay", "readonly"] as const;
export type NwcPermissionPreset = (typeof NWC_PERMISSION_PRESETS)[number];

export function presetToAllowedMethods(preset: NwcPermissionPreset): NwcMethod[] | undefined {
  switch (preset) {
    case "full":
      return undefined; // permissive legacy shape — all grantable methods
    case "pay":
      return ["pay_invoice", "pay_keysend"];
    case "readonly":
      return ["get_balance"];
  }
}

export function presetLabel(preset: NwcPermissionPreset): string {
  switch (preset) {
    case "full":
      return "Full access";
    case "pay":
      return "Pay only";
    case "readonly":
      return "Read only";
  }
}
