import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl as requestUrlMock } from "./test/obsidian-mock";

import {
  applyReplacements,
  dateFromWaybackTimestamp,
  fallbackUrlCandidates,
  findExternalLinks,
  isFreshTimestamp,
  latestAvailableSnapshotFromCdxApi,
  migrateLegacyCredentials,
  replacementsFromArchivedUrls,
  shouldArchiveUrl
} from "./main.ts";

describe("credential migration", () => {
  it("moves legacy credentials into Obsidian SecretStorage", () => {
    const secrets = new Map<string, string>();
    const storage = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => secrets.set(id, value)
    };

    const credentials = migrateLegacyCredentials(storage, {
      accessKey: "legacy-access",
      secretKey: "legacy-secret"
    });

    expect(credentials).toEqual({
      accessKeySecretId: "wayback-linker-access-key",
      secretKeySecretId: "wayback-linker-secret-key"
    });
    expect(Array.from(secrets.values())).toEqual(["legacy-access", "legacy-secret"]);
  });

  it("prefers existing keychain credentials over legacy plugin data", () => {
    const secrets = new Map<string, string>([
      ["wayback-linker-access-key", "stored-access"],
      ["wayback-linker-secret-key", "stored-secret"]
    ]);
    const setSecret = vi.fn();
    const storage = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret
    };

    expect(migrateLegacyCredentials(storage, {
      accessKeySecretId: "wayback-linker-access-key",
      secretKeySecretId: "wayback-linker-secret-key",
      accessKey: "legacy-access",
      secretKey: "legacy-secret"
    })).toEqual({
      accessKeySecretId: "wayback-linker-access-key",
      secretKeySecretId: "wayback-linker-secret-key"
    });
    expect(setSecret).not.toHaveBeenCalled();
  });
});

describe("link discovery", () => {
  it("finds markdown links, autolinks, and bare URLs while skipping images and Wayback URLs", () => {
    const content = [
      "[Example](https://example.com/path)",
      "![Image](https://example.com/image.png)",
      "<https://docs.example.com/guide>",
      "Bare https://example.org/page.",
      "[Old](https://web.archive.org/web/20200101000000/https://example.net)"
    ].join("\n");

    const matches = findExternalLinks(content, true);

    expect(matches.map((match) => match.url)).toEqual([
      "https://example.com/path",
      "https://docs.example.com/guide",
      "https://example.org/page"
    ]);
  });

  it("can ignore bare URLs when that setting is off", () => {
    const content = "[Example](https://example.com) and https://example.org";

    expect(findExternalLinks(content, false).map((match) => match.url)).toEqual([
      "https://example.com"
    ]);
  });

  it("skips existing Wayback links in markdown, autolink, and bare URL forms", () => {
    const content = [
      "[Archived](https://web.archive.org/web/20260101000000/https://example.com)",
      "<http://web.archive.org/web/20260101000000/http://example.org>",
      "Bare https://www.web.archive.org/web/20260101000000/https://example.net"
    ].join("\n");

    expect(findExternalLinks(content, true)).toEqual([]);
  });

  it("preserves angle brackets when replacing markdown link targets", () => {
    const content = "[Example](<https://example.com/path with spaces>)";
    const [match] = findExternalLinks(content, true);

    const updated = applyReplacements(content, [
      { match, archivedUrl: "https://web.archive.org/web/20260101000000/https://example.com" }
    ]);

    expect(updated).toBe(
      "[Example](<https://web.archive.org/web/20260101000000/https://example.com>)"
    );
  });
});

describe("replacement", () => {
  it("applies replacements from the end of the document so offsets stay stable", () => {
    const content = "First https://a.example and second https://b.example";
    const matches = findExternalLinks(content, true);

    const updated = applyReplacements(content, [
      { match: matches[0], archivedUrl: "https://web.archive.org/a" },
      { match: matches[1], archivedUrl: "https://web.archive.org/b" }
    ]);

    expect(updated).toBe("First https://web.archive.org/a and second https://web.archive.org/b");
  });

  it("builds replacements from archived URL results", () => {
    const content = "Use https://example.com and https://failed.example";
    const archivedByUrl = new Map([
      ["https://example.com", {
        originalUrl: "https://example.com",
        archivedUrl: "https://web.archive.org/web/20260101000000/https://example.com"
      }],
      ["https://failed.example", {
        originalUrl: "https://failed.example",
        error: "failed"
      }]
    ]);

    const replacements = replacementsFromArchivedUrls(content, archivedByUrl, true);

    expect(replacements).toHaveLength(1);
    expect(applyReplacements(content, replacements)).toBe(
      "Use https://web.archive.org/web/20260101000000/https://example.com and https://failed.example"
    );
  });
});

describe("fallback helpers", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("creates fallback URL candidates for hashes and trailing slashes", () => {
    expect(fallbackUrlCandidates("https://example.com/path/#section")).toEqual([
      "https://example.com/path/#section",
      "https://example.com/path/",
      "https://example.com/path"
    ]);
  });

  it("uses the latest successful CDX row", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: [
        ["timestamp", "original", "statuscode"],
        ["20200101000000", "https://example.com/old", "200"],
        ["20260101000000", "https://example.com/new", "200"]
      ]
    });

    await expect(latestAvailableSnapshotFromCdxApi("https://example.com")).resolves.toBe(
      "https://web.archive.org/web/20260101000000/https://example.com/new"
    );
  });

  it("returns undefined when CDX has no capture rows", async () => {
    requestUrlMock.mockResolvedValue({
      status: 200,
      json: [["timestamp", "original", "statuscode"]]
    });

    await expect(latestAvailableSnapshotFromCdxApi("https://example.com")).resolves.toBeUndefined();
  });
});

describe("timestamps and archive filtering", () => {
  it("parses Wayback timestamps as UTC dates", () => {
    expect(dateFromWaybackTimestamp("20260616183045")?.toISOString()).toBe(
      "2026-06-16T18:30:45.000Z"
    );
  });

  it("treats captures within five minutes before the request as fresh", () => {
    const requestedAt = new Date("2026-06-16T18:35:00.000Z");

    expect(isFreshTimestamp("20260616183100", requestedAt)).toBe(true);
    expect(isFreshTimestamp("20260616182959", requestedAt)).toBe(false);
  });

  it("skips Wayback URLs and accepts normal HTTP URLs", () => {
    expect(shouldArchiveUrl("https://example.com")).toBe(true);
    expect(shouldArchiveUrl("https://web.archive.org/web/20200101000000/https://example.com")).toBe(false);
    expect(shouldArchiveUrl("http://www.web.archive.org/web/20200101000000/http://example.com")).toBe(false);
  });
});
