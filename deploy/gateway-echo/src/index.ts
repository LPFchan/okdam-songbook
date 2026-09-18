/**
 * An echo backend for probing the Common Auth gateway.
 *
 * It answers what it *received*, never what it decided. That is the whole
 * point: a status code can be right for the wrong reason, and client-side
 * metrics like curl's %{size_upload} only report what the instrument sent —
 * they read a perfect 5 bytes while HTTP/2 silently drops an Upgrade header.
 * Only the far side of the wire can say what actually arrived.
 *
 * Deploy route-less behind a gateway binding, exactly like a real backend.
 */

interface Echo {
  method: string;
  path: string;
  query: string;
  httpProtocol: string | null;
  /** Whether a body stream was attached at all — the GET-with-body case. */
  bodyPresent: boolean;
  /** Bytes actually read off it, which is the claim curl cannot make. */
  bodyBytes: number;
  bodyText: string | null;
  /** Every x-lost-plus-* header, decoded the way the app decodes them. */
  identity: Record<string, { raw: string; decoded: string | null }>;
  /** Present but not identity: what the gateway adds and forwards. */
  forwarded: Record<string, string>;
  /** Anything that smells like a credential must NOT reach a backend. */
  credentialLeak: string[];
  /**
   * Every header verbatim, as name/value pairs in arrival order.
   *
   * The curated sets above are a view; this is the record. A count would say
   * that something arrived or vanished and never which — and the failure that
   * motivated this backend was the absence of a header nobody had thought to
   * name. `upgrade` is in `forwarded` only because someone already lost an
   * hour finding it, and that reasoning is not available for the next one.
   *
   * Duplicates are not preserved and cannot be: the Headers API joins repeated
   * request headers into one comma-separated value before any Worker sees
   * them. What is recorded here is what arrived after that normalization,
   * which is also what the application would act on.
   */
  headers: Array<[string, string]>;
  headerCount: number;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const identity: Echo["identity"] = {};
    const forwarded: Record<string, string> = {};
    const credentialLeak: string[] = [];
    const headers: Array<[string, string]> = [];

    request.headers.forEach((value, name) => {
      headers.push([name, value]);
      if (name.startsWith("x-lost-plus-")) {
        identity[name] = { raw: value, decoded: decode(value) };
      } else if (name.startsWith("x-forwarded-") || name === "host" || name === "upgrade") {
        forwarded[name] = value;
      } else if (name === "authorization" || name === "x-api-key" || name === "cookie") {
        // The gateway is supposed to strip these. If one arrives, the
        // application is seeing a raw credential, which is the property the
        // gateway exists to prevent.
        credentialLeak.push(name);
      }
    });

    const bodyPresent = request.body !== null;
    let bodyBytes = 0;
    let bodyText: string | null = null;
    if (bodyPresent) {
      const raw = await request.arrayBuffer();
      bodyBytes = raw.byteLength;
      bodyText = new TextDecoder().decode(raw.slice(0, 256));
    }

    const echo: Echo = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      httpProtocol: typeof request.cf?.httpProtocol === "string" ? request.cf.httpProtocol : null,
      bodyPresent,
      bodyBytes,
      bodyText,
      identity,
      forwarded,
      credentialLeak,
      headers,
      headerCount: headers.length
    };

    return new Response(JSON.stringify(echo, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
} satisfies ExportedHandler;
