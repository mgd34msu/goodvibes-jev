import { describe, expect, test } from "bun:test";
import {
  categoryLabelForKey,
  displayConfigValue,
  flattenConfig,
  isSecretConfigKey,
  maskSecretValue,
  isUnresolvedConfigKey,
  SECRET_CONFIG_KEYS,
} from "./config-redaction";
import { CONFIG_SCHEMA_ENTRIES } from "./generated/config-schema";
import { SECRET_BEARING_CONFIG_PATHS } from "@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs";

describe("isSecretConfigKey", () => {
  test("recognizes canonical declared secret keys", () => {
    expect(isSecretConfigKey("surfaces.slack.botToken")).toBe(true);
    expect(isSecretConfigKey("surfaces.whatsapp.signingSecret")).toBe(true);
    expect(isSecretConfigKey("surfaces.matrix.accessToken")).toBe(true);
  });

  test("recognizes surfaces.telephony.* directly from the declared list, not merely via the suffix fallback", () => {
    // surfaces.telephony.* keys are real (schema-domain-surfaces.ts) and were
    // previously caught only by the generic suffix heuristic (or, for
    // .webhookSecret, not distinguished from being declared at all). They are
    // now named in SECRET_CONFIG_KEYS itself, the declared list is the
    // primary classifier, not the fallback.
    expect(isSecretConfigKey("surfaces.telephony.token")).toBe(true);
    expect(isSecretConfigKey("surfaces.telephony.authToken")).toBe(true);
    expect(isSecretConfigKey("surfaces.telephony.webhookSecret")).toBe(true);
  });

  test("mail and calendar credentials are declared, the mail/calendar passwords", () => {
    expect(isSecretConfigKey("surfaces.email.password")).toBe(true);
    expect(isSecretConfigKey("surfaces.email.imapPassword")).toBe(true);
    expect(isSecretConfigKey("surfaces.calendar.caldavPassword")).toBe(true);
  });

  test("mail and calendar secret REFERENCES are declared; none of these end in a suffix the old fallback caught", () => {
    // These are DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS (app-layer paths, not
    // CONFIG_SCHEMA scalars), the old suffix-only implementation never even
    // saw them in a schema scan, and several (icsUrl, clientSecretRef,
    // passwordRef) do not end in "token"/"secret"/"password" either.
    for (const key of [
      "email.passwordRef",
      "calendar.google.clientSecretRef",
      "calendar.microsoft.clientSecretRef",
      "calendar.google.icsUrl",
      "google.oauth.refreshToken",
    ]) {
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });

  test("the cluster coordination secret and key material are declared", () => {
    expect(isSecretConfigKey("cluster.secret")).toBe(true);
    // cluster.groupMaterial is the case the OLD suffix-only heuristic missed:
    // "groupMaterial" does not end in token/secret/password/apikey.
    expect(isSecretConfigKey("cluster.groupMaterial")).toBe(true);
  });

  test('Cloudflare provisioning tokens are declared; every one ends in "Ref", which the suffix fallback does not match', () => {
    for (const key of [
      "cloudflare.apiTokenRef",
      "cloudflare.workerTokenRef",
      "cloudflare.workerClientTokenRef",
      "cloudflare.tunnelTokenRef",
      "cloudflare.accessServiceTokenRef",
    ]) {
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });

  test("resource identifiers that sit next to a secret are deliberately NOT masked; they are not the secret itself", () => {
    // Same shape as calendar.google.clientId (not masked): an id that names or
    // locates a credential, not the credential's value.
    expect(isSecretConfigKey("surfaces.telegram.discoveredBotTokenId")).toBe(false);
    expect(isSecretConfigKey("cloudflare.accessServiceTokenId")).toBe(false);
    expect(isSecretConfigKey("cloudflare.secretsStoreName")).toBe(false);
    expect(isSecretConfigKey("cloudflare.secretsStoreId")).toBe(false);
    expect(isSecretConfigKey("calendar.google.clientId")).toBe(false);
  });

  test("masks every unknown key without guessing from its spelling", () => {
    for (const key of ["some.newSurface.apiKey", "some.newSurface.title", "arbitrary.value"]) {
      expect(isSecretConfigKey(key)).toBe(true);
      expect(isUnresolvedConfigKey(key)).toBe(true);
    }
  });

  test("an ordinary, non-secret key is not flagged", () => {
    expect(isSecretConfigKey("display.theme")).toBe(false);
    expect(isSecretConfigKey("helper.globalProvider")).toBe(false);
    expect(isSecretConfigKey("provider.model")).toBe(false);
  });

  test('LLM-token settings are not credential-shaped despite containing the word "token"', () => {
    // These are canonical schema facts. The browser does not infer a key
    // classification from the occurrence or position of the word "token".
    expect(isSecretConfigKey("display.showTokenSpeed")).toBe(false);
    expect(isSecretConfigKey("planner.tokenCeiling")).toBe(false);
    expect(isSecretConfigKey("tools.defaultTokenBudget")).toBe(false);
  });
});

describe("canonical structural classification", () => {
  test("uses the exact canonical declared secret paths without a second maintained list", () => {
    expect([...SECRET_CONFIG_KEYS]).toEqual([...SECRET_BEARING_CONFIG_PATHS]);
    for (const key of SECRET_BEARING_CONFIG_PATHS) {
      expect(isSecretConfigKey(key)).toBe(true);
      expect(isUnresolvedConfigKey(key)).toBe(false);
    }
  });

  test("declared schema keys are resolved by structural metadata alone", () => {
    for (const entry of CONFIG_SCHEMA_ENTRIES) {
      expect(isUnresolvedConfigKey(entry.key)).toBe(false);
      expect(isSecretConfigKey(entry.key)).toBe(SECRET_CONFIG_KEYS.has(entry.key));
    }
  });
});

describe("maskSecretValue", () => {
  test("keeps the last 4 chars, stars the rest", () => {
    expect(maskSecretValue("sk-abcdefgh1234")).toBe(`${"•".repeat(11)}1234`);
  });

  test("short values mask fully", () => {
    expect(maskSecretValue("abc")).toBe("••••");
  });

  test("empty string reads as a visible marker, not a masked zero-length value", () => {
    expect(maskSecretValue("").length).toBeGreaterThan(0);
    expect(maskSecretValue("")).not.toBe(maskSecretValue("abc"));
  });
});

describe("displayConfigValue", () => {
  test("declared fallback arrays expose only strict detached references", () => {
    const references = [
      { endpoint: "https://fallback.example.test/v1", model: "jev-latest", keySource: "env", keyName: "FALLBACK_API_KEY" },
      { endpoint: "https://second.example.test", model: "jev-1.13.0", keySource: "secret", keyName: "judgment/fallback-key" },
    ];
    expect(isSecretConfigKey("judgment.fallbacks")).toBe(false);
    expect(isUnresolvedConfigKey("judgment.fallbacks")).toBe(false);
    expect(displayConfigValue("judgment.fallbacks", references)).toBe(JSON.stringify(references));
    expect(displayConfigValue("judgment.fallbacks", [])).toBe("[]");
  });

  test("malformed declared arrays are wholly masked even with name clearance", () => {
    const reference = { endpoint: "https://fallback.example.test", model: "jev-1.13.0", keySource: "env", keyName: "FALLBACK_API_KEY" };
    for (const value of [
      undefined, null, "synthetic-private-value", reference,
      [{ ...reference, apiKey: "synthetic-private-value" }],
      [{ ...reference, keyName: "synthetic-private-value" }],
      [{ ...reference, endpoint: "https://user:synthetic-private-value@fallback.example.test" }],
      [{ ...reference, model: "" }],
    ]) {
      expect(displayConfigValue("judgment.fallbacks", value)).toBe("••••");
      expect(displayConfigValue("judgment.fallbacks", value, true)).toBe("••••");
    }
  });

  test("fallback display rejects accessors and serialization hooks without invoking them", () => {
    let invoked = 0;
    const accessor = { endpoint: "https://fallback.example.test", model: "jev-1.13.0", keySource: "env" };
    Object.defineProperty(accessor, "keyName", { enumerable: true, get: () => { invoked++; return "synthetic-private-value"; } });
    const indexed: unknown[] = [];
    Object.defineProperty(indexed, 0, { enumerable: true, get: () => { invoked++; return accessor; } });
    const hook = [{ endpoint: "https://fallback.example.test", model: "jev-1.13.0", keySource: "env", keyName: "FALLBACK_KEY", toJSON: () => { invoked++; return "synthetic-private-value"; } }];
    for (const value of [[accessor], indexed, hook]) {
      expect(displayConfigValue("judgment.fallbacks", value)).toBe("••••");
    }
    expect(invoked).toBe(0);
  });

  test("never renders a secret key's value raw", () => {
    const displayed = displayConfigValue("surfaces.slack.botToken", "xoxb-real-secret-value");
    expect(displayed).not.toContain("real-secret-value");
    expect(displayed).toContain("alue"); // last 4 chars only
  });

  test("renders a non-secret string value verbatim", () => {
    expect(displayConfigValue("display.theme", "vaporwave")).toBe("vaporwave");
  });

  test("unset, empty and boolean values render distinctly, never a fabricated value", () => {
    const unset = displayConfigValue("provider.model", null);
    expect(unset.length).toBeGreaterThan(0);
    expect(displayConfigValue("provider.model", undefined)).toBe(unset);
    const empty = displayConfigValue("tts.llmModel", "");
    expect(empty.length).toBeGreaterThan(0);
    expect(empty).not.toBe(unset);
    expect(displayConfigValue("helper.enabled", true)).toBe("true");
    expect(displayConfigValue("helper.enabled", false)).toBe("false");
  });

  test("numbers and objects render without throwing", () => {
    expect(displayConfigValue("tts.speed", 1.5)).toBe("1.5");
    expect(displayConfigValue("cache.gates", [{ name: "lint" }])).toBe("••••");
    expect(displayConfigValue("cache.gates", [{ name: "lint" }], true)).toContain("lint");
  });
});

describe("unknown key display authorization", () => {
  test.each([
    "synthetic-private-value",
    4815162342,
    true,
    { nested: "synthetic-private-value" },
    ["synthetic-private-value"],
    null,
    undefined,
  ])("unknown value %j is fully masked until explicitly cleared", (value) => {
    expect(displayConfigValue("extension.unknown", value)).toBe("••••");
  });

  test("clearance only affects unresolved names, never canonical declared secrets", () => {
    for (const key of SECRET_BEARING_CONFIG_PATHS) {
      expect(displayConfigValue(key, "synthetic-private-value", true)).not.toContain(
        "synthetic-private-value"
      );
      for (const value of [
        4815162342,
        true,
        { nested: "synthetic-private-value" },
        ["synthetic-private-value"],
      ]) {
        expect(displayConfigValue(key, value, true)).toBe("••••");
      }
    }
  });
});

describe("categoryLabelForKey", () => {
  test("keys group by their namespace", () => {
    expect(categoryLabelForKey("helper.globalModel")).toBe(categoryLabelForKey("helper.enabled"));
    expect(categoryLabelForKey("tts.llmModel")).not.toBe(categoryLabelForKey("helper.enabled"));
    expect(categoryLabelForKey("surfaces.slack.botToken")).toBe(
      categoryLabelForKey("surfaces.email.password")
    );
  });

  test("an unmapped namespace falls back to a Title Case of itself, never a fabricated label", () => {
    expect(categoryLabelForKey("someNewDomain.key")).toBe("Some New Domain");
  });
});

describe("flattenConfig", () => {
  test("structured-reference values are terminal rows even when malformed or accessor-backed", () => {
    const value = { apiKey: "synthetic-private-value" };
    expect(flattenConfig({ judgment: { fallbacks: value } })).toEqual([
      { key: "judgment.fallbacks", value, category: "Judgment" },
    ]);
    let invoked = false;
    const judgment = Object.defineProperty({}, "fallbacks", { enumerable: true, get: () => { invoked = true; return value; } });
    const entries = flattenConfig({ judgment });
    expect(entries).toEqual([{ key: "judgment.fallbacks", value: undefined, category: "Judgment" }]);
    expect(displayConfigValue(entries[0]!.key, entries[0]!.value)).toBe("••••");
    expect(invoked).toBe(false);
  });
  test("declared secret objects remain terminal rows rather than clearable child names", () => {
    const value = { ordinaryName: "synthetic-private-value" };
    const entries = flattenConfig({ cluster: { groupMaterial: value } });
    expect(entries).toEqual([{ key: "cluster.groupMaterial", value, category: "Cluster" }]);
    expect(displayConfigValue(entries[0]!.key, entries[0]!.value, true)).toBe("••••");
  });

  test("flattens nested objects into dotted keys, categorized", () => {
    const entries = flattenConfig({
      helper: { enabled: true, globalModel: "gpt-5" },
      display: { theme: "vaporwave" },
    });
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(["display.theme", "helper.enabled", "helper.globalModel"]);
    expect(entries.find((e) => e.key === "helper.enabled")?.category).toBe(
      categoryLabelForKey("helper.enabled")
    );
  });

  test("arrays are treated as leaf values, not descended into", () => {
    const entries = flattenConfig({ notifications: { webhookUrls: ["a", "b"] } });
    expect(entries).toEqual([
      { key: "notifications.webhookUrls", value: ["a", "b"], category: "Notifications" },
    ]);
  });

  test("an empty or non-object input yields no entries", () => {
    expect(flattenConfig(undefined)).toEqual([]);
    expect(flattenConfig(null)).toEqual([]);
    expect(flattenConfig("not an object")).toEqual([]);
  });
});
