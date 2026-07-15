// Script-tag entry: <script src="libre-wallet.js"></script> exposes window.LibreWallet with the
// same API as the npm package, and pre-registers the <libre-wallet> element.
import { mountLibreWallet, registerLibreWallet } from "./index";

registerLibreWallet();

export { mountLibreWallet, registerLibreWallet };
