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
  });
});
