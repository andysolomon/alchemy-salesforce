/**
 * An enrichment API that Salesforce calls through a Named Credential.
 *
 * Apex never sees the shared secret: the External Credential stores it and
 * adds `Authorization: Bearer <secret>` to each callout. The Worker gets the
 * same value as a Cloudflare secret from the Alchemy stack.
 *
 * The enrichment data is a deterministic stand-in. Replace `enrich` with a
 * call to your data provider.
 */
interface Env {
  readonly SHARED_SECRET: string;
}

const INDUSTRIES = ["Software", "Manufacturing", "Healthcare", "Financial Services", "Retail", "Energy"];
const EMPLOYEE_BANDS = ["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"];

const hash = (text: string): number => {
  let value = 2166136261;
  for (const char of text) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return value;
};

const enrich = (domain: string) => {
  const seed = hash(domain);
  return {
    domain,
    industry: INDUSTRIES[seed % INDUSTRIES.length],
    employees: EMPLOYEE_BANDS[(seed >>> 8) % EMPLOYEE_BANDS.length],
    source: "alchemy-salesforce example",
  };
};

/** Compare without returning early, so response time does not reveal how much of the secret matched. */
const sameSecret = (presented: string, expected: string): boolean => {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  for (let index = 0; index < right.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0 && expected.length > 0;
};

const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameSecret(presented, env.SHARED_SECRET)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method === "GET" && url.pathname === "/enrich") {
      const domain = url.searchParams.get("domain")?.trim().toLowerCase() ?? "";
      if (!DOMAIN.test(domain)) {
        return Response.json({ error: "pass ?domain=example.com" }, { status: 400 });
      }
      return Response.json(enrich(domain));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
