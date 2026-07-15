import type { WalletController } from "./wallet-controller";

// The controller's PUBLIC surface as a structural type. `keyof` only yields public members, so
// this is exactly what screens/views may call — and it stays in sync with the class automatically.
// WalletController has private fields (nominal typing), so an alternate implementation (the PWA's
// DemoController, an embed test stub) can never satisfy the CLASS type; it satisfies THIS type.
export type WalletControllerApi = { [K in keyof WalletController]: WalletController[K] };
