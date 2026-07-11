import { registerScreen, resetToHome, showScreen } from "../ui/nav";
import { $ } from "./util";

export function initChanSuccessScreen(): void {
  $("chan-receive-btn").addEventListener("click", () => {
    resetToHome();
    showScreen("screen-receive");
  });
  $("chan-later-btn").addEventListener("click", () => resetToHome());
  registerScreen("screen-chan-success", {});
}
