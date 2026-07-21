/** Whether a request URL should bypass the configured HTTP proxy. */
export function shouldBypassProxy(targetUrl: string, ignore: string[]): boolean {
  if (ignore.length === 0) return false;

  let hostname: string;
  let port: string;
  try {
    const u = new URL(targetUrl);
    hostname = u.hostname.toLowerCase();
    // Strip IPv6 brackets for matching
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  } catch {
    return false;
  }

  const hostWithPort = port ? `${hostname}:${port}` : hostname;

  for (const raw of ignore) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry === hostname || entry === hostWithPort) return true;

    // ".example.com" → example.com and *.example.com
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1);
      if (
        hostname === suffix ||
        (hostname.endsWith(suffix) && hostname[hostname.length - suffix.length - 1] === ".")
      ) {
        return true;
      }
    }

    // "*.example.com"
    if (entry.startsWith("*.") && hostname.endsWith(entry.slice(1))) {
      return true;
    }
  }

  return false;
}

export function resolveProxyUrl(
  proxy: { url: string | null; ignore: string[] },
  targetUrl: string,
): string | undefined {
  if (!proxy.url) return undefined;
  if (shouldBypassProxy(targetUrl, proxy.ignore)) return undefined;
  return proxy.url;
}
