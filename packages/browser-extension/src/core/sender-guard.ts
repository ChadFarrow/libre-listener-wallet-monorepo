// Distinguishes a message from one of the extension's OWN contexts (popup, options page, approval
// window, background service worker, offscreen document) from one relayed by a content script that
// runs inside a web page.
//
// Both carry our extension id — content scripts belong to us too — so `sender.id` alone can't tell
// them apart. And `sender.tab` is NOT a reliable discriminator: an extension page opened via
// chrome.windows.create (the approval popup) or chrome tabs (the options page) is hosted in a tab
// and DOES carry `sender.tab`. The reliable signal is the URL scheme: an extension context's
// `sender.url` is `chrome-extension://<id>/…`, while a content script's is the web page (http(s)).

export interface MessageSenderLike {
  id?: string;
  url?: string;
}

// True only when the message came from this extension's own page/worker (not a content script).
// `extensionUrlPrefix` is chrome.runtime.getURL("") → "chrome-extension://<id>/".
export function isFromExtensionContext(
  sender: MessageSenderLike | undefined,
  runtimeId: string,
  extensionUrlPrefix: string
): boolean {
  return (
    !!sender &&
    sender.id === runtimeId &&
    typeof sender.url === "string" &&
    sender.url.startsWith(extensionUrlPrefix)
  );
}
