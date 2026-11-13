// The worker a batch of files is prepared in (prepare.ts), off the window's
// thread. Bundled inline, as a blob, since an installed extension has no URL
// of its own to load a worker script from.

import { prepareLutFile, type PrepareRequest, type PrepareResponse } from "./prepare";
import { browserJpegDecoder } from "./read-file";

self.addEventListener("message", (e: MessageEvent<PrepareRequest>) => {
  const { id, name, bytes } = e.data;
  void prepareLutFile(name, bytes, browserJpegDecoder)
    .catch((err: unknown) => ({ ok: false as const, error: `The file can't be read: ${err instanceof Error ? err.message : String(err)}` }))
    .then((result) => {
      const response: PrepareResponse = { id, result };
      self.postMessage(response, { transfer: result.ok ? [result.texels.buffer] : [] });
    });
});
