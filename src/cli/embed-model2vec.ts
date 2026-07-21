/**
 * Compile-only: embed the Model2Vec Rust sidecar into the standalone executable.
 * `scripts/build.ts` builds this binary before `Bun.build({ compile })`.
 */

import bin from "../../native/model2vec-cli/target/release/localdoc-model2vec" with {
  type: "file",
};
import { setEmbeddedModel2VecPath } from "../embed/model2vec-bin.ts";

setEmbeddedModel2VecPath(bin);
