// WalletRpc (the webln-mapping contract) over the headless WalletController.
import type { WalletControllerApi, WalletRpc } from "@libre/wallet-core";

export function controllerRpc(controller: WalletControllerApi): WalletRpc {
  return {
    async getInfo() {
      const [state, config] = await Promise.all([controller.getState(), controller.getConfig()]);
      return {
        pubkey: state.nodeId ?? "",
        alias: config.nodeAlias || "Libre Listener Wallet",
        network: state.network,
      };
    },
    async getBalanceSats() {
      const state = await controller.getState();
      return state.balance?.spendableSat ?? 0;
    },
    async makeInvoice(args) {
      return controller.createInvoice(args.amountSats, args.memo, args.expirySeconds);
    },
    async payInvoice(bolt11) {
      const { preimage } = await controller.payLightning(bolt11);
      return { preimage };
    },
    async keysend(args) {
      return controller.payKeysend(args);
    },
  };
}
