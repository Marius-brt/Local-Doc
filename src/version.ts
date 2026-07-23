import pkg from "../package.json" with { type: "json" };

/** Package version from package.json (single source of truth). */
export const VERSION: string = pkg.version;
