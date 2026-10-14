import { createTestDatabase } from "@/lib/db/testing";
import { firms } from "@/lib/db/schema";

import { createAuth } from "./index";
import { provisionUser } from "./users";

/**
 * Auth test harness: an isolated in-process database plus a Better Auth instance
 * bound to it.
 *
 * Test users are created through `provisionUser`, the same path production uses,
 * so a fixture cannot silently diverge from real password handling. No test
 * anywhere writes a pre-computed hash.
 */
export async function createAuthHarness() {
  const { db, client, close } = await createTestDatabase();
  // A fixed test-only value, never used outside the in-process harness.
  const auth = createAuth(db, { secret: "test-secret-at-least-32-chars-long-ok" }); // gitleaks:allow

  const [firm] = await db
    .insert(firms)
    .values({ name: "Alpha Accounting" })
    .returning();

  return {
    db,
    client,
    auth,
    firm: firm!,
    close,

    async createUser(input: {
      email: string;
      password: string;
      name?: string;
      firmId?: string;
    }) {
      return provisionUser(db, {
        firmId: input.firmId ?? firm!.id,
        email: input.email,
        name: input.name ?? "Test User",
        password: input.password,
      });
    },

    /**
     * Signs in and returns the raw Response plus a cookie header usable on
     * subsequent requests. Returns `cookie: null` when sign-in failed.
     */
    async signIn(email: string, password: string) {
      const response = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      const setCookie = response.headers.get("set-cookie");
      return {
        response,
        status: response.status,
        body: await response
          .clone()
          .text()
          .catch(() => ""),
        cookie: setCookie ? stripCookieAttributes(setCookie) : null,
      };
    },

    /** Headers carrying a session cookie, for authenticated requests. */
    headersFor(cookie: string): Headers {
      return new Headers({ cookie });
    },
  };
}

/** Turn a Set-Cookie value into a Cookie request header. */
function stripCookieAttributes(setCookie: string): string {
  return setCookie
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

export type AuthHarness = Awaited<ReturnType<typeof createAuthHarness>>;
