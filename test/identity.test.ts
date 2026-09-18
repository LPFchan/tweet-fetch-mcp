import { describe, expect, it } from "vitest";
import { identityFrom } from "../identity";

// The encoder these expectations are written against is the gateway's
// `encodedIdentityValue` (auth/gateway/src/identity.ts): form-urlencode with
// the unreserved set `A-Z a-z 0-9 * - . _`, then rewrite `+` to `%20`. The
// literal encoded strings below are what that produces, so a change on either
// side shows up here.

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

/** A well-formed set, as the gateway sends it. */
function gatewayHeaders(overrides: Record<string, string> = {}): Headers {
  return headers({
    "x-lost-plus-sub": "42",
    "x-lost-plus-email": "me%40lost.plus",
    "x-lost-plus-name": "yeowool",
    "x-lost-plus-role": "user",
    "x-lost-plus-encoding": "percent-utf8",
    ...overrides,
  });
}

describe("identityFrom", () => {
  describe("accepts what the gateway sends", () => {
    it("reads all four values", () => {
      expect(identityFrom(gatewayHeaders())).toEqual({
        sub: "42",
        email: "me@lost.plus",
        name: "yeowool",
        role: "user",
      });
    });

    it("decodes a non-ASCII display name", () => {
      // "사용자", UTF-8 then percent-encoded, which is what a Korean display
      // name actually arrives as.
      const identity = identityFrom(
        gatewayHeaders({ "x-lost-plus-name": "%EC%82%AC%EC%9A%A9%EC%9E%90" }),
      );
      expect(identity?.name).toBe("사용자");
    });

    it("decodes a space, which arrives as %20 and never as +", () => {
      const identity = identityFrom(gatewayHeaders({ "x-lost-plus-name": "Yeo%20Wool" }));
      expect(identity?.name).toBe("Yeo Wool");
    });

    it("leaves a literal + alone, because the gateway sends one as %2B", () => {
      const identity = identityFrom(gatewayHeaders({ "x-lost-plus-email": "me%2Btag%40lost.plus" }));
      expect(identity?.email).toBe("me+tag@lost.plus");

      // And if a raw + ever did arrive it is a plus sign, not a space.
      const raw = identityFrom(gatewayHeaders({ "x-lost-plus-name": "a+b" }));
      expect(raw?.name).toBe("a+b");
    });

    it("carries an administrator role through without interpreting it", () => {
      const identity = identityFrom(gatewayHeaders({ "x-lost-plus-role": "administrator" }));
      expect(identity?.role).toBe("administrator");
    });

    it("does not care about a role it has never heard of", () => {
      // The gateway already refuses anything outside administrator/user, so a
      // second list here would only be one more place to edit.
      const identity = identityFrom(gatewayHeaders({ "x-lost-plus-role": "moderator" }));
      expect(identity?.role).toBe("moderator");
    });
  });

  describe("refuses anything else", () => {
    it("refuses an empty header set", () => {
      expect(identityFrom(headers({}))).toBeNull();
    });

    it("refuses values sent without the encoding declaration", () => {
      const withoutEncoding = gatewayHeaders();
      withoutEncoding.delete("x-lost-plus-encoding");
      expect(identityFrom(withoutEncoding)).toBeNull();
    });

    it("refuses an encoding it does not understand", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-encoding": "utf-8" }))).toBeNull();
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-encoding": "" }))).toBeNull();
    });

    for (const missing of [
      "x-lost-plus-sub",
      "x-lost-plus-email",
      "x-lost-plus-name",
      "x-lost-plus-role",
    ]) {
      it(`refuses a set missing ${missing}`, () => {
        const partial = gatewayHeaders();
        partial.delete(missing);
        expect(identityFrom(partial)).toBeNull();
      });

      it(`refuses an empty ${missing}`, () => {
        expect(identityFrom(gatewayHeaders({ [missing]: "" }))).toBeNull();
      });
    }

    it("refuses a truncated percent escape rather than throwing", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%E" }))).toBeNull();
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%" }))).toBeNull();
    });

    it("refuses a non-hex escape", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-sub": "%zz" }))).toBeNull();
    });

    it("refuses bytes that are not valid UTF-8", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%FF" }))).toBeNull();
    });

    it("refuses an overlong encoding and an encoded surrogate", () => {
      // `%C0%AF` is an overlong `/`; `%ED%A0%80` is U+D800. decodeURIComponent
      // rejects both, and so must this.
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%C0%AF" }))).toBeNull();
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%ED%A0%80" }))).toBeNull();
    });

    it("refuses the encoding name in any other spelling", () => {
      // Exact match. The gateway sends exactly `percent-utf8`, and accepting a
      // variant would mean guessing what a different gateway meant by it.
      for (const variant of ["Percent-UTF8", "PERCENT-UTF8", "percent_utf8", "percent-utf-8", "percent-utf8;q=1"]) {
        expect(identityFrom(gatewayHeaders({ "x-lost-plus-encoding": variant }))).toBeNull();
      }
    });

    it("refuses a doubled header, which `Headers.get` joins with a comma", () => {
      // Two `x-lost-plus-encoding` headers read back as
      // `percent-utf8, percent-utf8`, which is not the declaration. The
      // gateway uses `set`, so a doubled header can only mean something
      // appended one after the gateway did.
      const doubled = gatewayHeaders();
      doubled.append("x-lost-plus-encoding", "percent-utf8");
      expect(identityFrom(doubled)).toBeNull();

      // A doubled value field is not refused, but it is not two identities
      // either: it is one string with a comma in it, and it is the gateway's
      // job never to send one.
      const twoSubs = gatewayHeaders();
      twoSubs.append("x-lost-plus-sub", "43");
      expect(identityFrom(twoSubs)?.sub).toBe("42, 43");
    });
  });

  describe("cannot be used to inject", () => {
    it("keeps an encoded CRLF inside the value it was sent in", () => {
      // The classic header-injection payload. Percent-decoding happens after
      // the runtime has already split the headers, so the CRLF ends up as two
      // characters inside `name`; `role` is untouched.
      const identity = identityFrom(
        gatewayHeaders({ "x-lost-plus-name": "eve%0D%0Ax-lost-plus-role%3A%20administrator" }),
      );
      expect(identity?.name).toBe("eve\r\nx-lost-plus-role: administrator");
      expect(identity?.role).toBe("user");
    });

    it("decodes lowercase hex the same as uppercase", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "%ec%82%ac" }))?.name).toBe("사");
    });

    it("reads a literal percent sign only when it was encoded as %25", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "100%25" }))?.name).toBe("100%");
      // An unencoded `%` followed by hex is an escape, not a percent sign.
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": "100%41" }))?.name).toBe("100A");
    });
  });

  describe("does not re-check what the hub already enforces", () => {
    it("carries a display name at the hub's 80-scalar cap", () => {
      const name = "가".repeat(80);
      const encoded = encodeURIComponent(name);
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": encoded }))?.name).toBe(name);
    });

    it("does not cap a longer name itself", () => {
      // The hub caps display names at 80 scalars, so a longer one is a hub
      // fault, not a caller's doing. Nothing here uses the name as a key or a
      // header, so there is nothing to protect by refusing it.
      const name = "a".repeat(4096);
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-name": name }))?.name).toBe(name);
    });

    it("does not trim or normalize a role it passes through", () => {
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-role": "%20user" }))?.role).toBe(" user");
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-role": "User" }))?.role).toBe("User");
    });

    it("does not filter control characters out of a decoded value", () => {
      // Documented, not endorsed: a NUL in `sub` reaches the caller. Nothing
      // in this Worker keys storage on `sub`, so today this is harmless. The
      // day something does, this test is the reminder to refuse it first.
      expect(identityFrom(gatewayHeaders({ "x-lost-plus-sub": "4%002" }))?.sub).toBe("4 2");
    });
  });
});
