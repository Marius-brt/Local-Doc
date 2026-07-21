/**
 * Compile-only: embed Chonkie WASM into the standalone executable.
 */

import wasm from "../../node_modules/@chonkiejs/chunk/pkg/chonkiejs_chunk_bg.wasm" with {
  type: "file",
};
import { setEmbeddedChonkieWasmPath } from "../chunk/chonkie-wasm.ts";

setEmbeddedChonkieWasmPath(wasm);
