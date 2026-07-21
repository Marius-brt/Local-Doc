/**
 * Side-effect import so Bun --compile embeds the libsql native addon.
 * The real package is injected at build time via the `localdoc-embed-libsql` plugin
 * (libsql uses require(`@libsql/${target}`) which Bun cannot statically see).
 */
import "localdoc:embed-libsql";
