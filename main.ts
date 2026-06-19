import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
  TFile,
  requestUrl
} from "obsidian";

interface WaybackLinkerSettings {
  requestDelayMs: number;
  archiveBareUrls: boolean;
  maxCaptureWaitSeconds: number;
  accessKeySecretId: string;
  secretKeySecretId: string;
  fallbackToLatestSnapshot: boolean;
  throttleRetryDelaySeconds: number;
  maxThrottleRetries: number;
}

const DEFAULT_SETTINGS: WaybackLinkerSettings = {
  requestDelayMs: 1500,
  archiveBareUrls: true,
  maxCaptureWaitSeconds: 90,
  accessKeySecretId: "",
  secretKeySecretId: "",
  fallbackToLatestSnapshot: false,
  throttleRetryDelaySeconds: 60,
  maxThrottleRetries: 3
};

interface LinkMatch {
  start: number;
  end: number;
  url: string;
  replacement: (archivedUrl: string) => string;
}

interface ArchiveResult {
  originalUrl: string;
  archivedUrl?: string;
  error?: string;
  usedFallback?: boolean;
}

interface CaptureResult {
  archivedUrl?: string;
  error?: string;
  retryableThrottle?: boolean;
}

type ArchiveState = "pending" | "working" | "success" | "fallback" | "failed";

interface ArchiveProgressItem {
  url: string;
  state: ArchiveState;
  message: string;
}

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

const HTTP_URL_PATTERN = /^https?:\/\//i;
const ACCESS_KEY_SECRET_ID = "wayback-linker-access-key";
const SECRET_KEY_SECRET_ID = "wayback-linker-secret-key";

export default class WaybackLinkerPlugin extends Plugin {
  settings: WaybackLinkerSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("archive", "Archive links with Wayback Machine", () => {
      void this.archiveActiveFileLinks();
    });

    this.addCommand({
      id: "archive-active-note-links",
      name: "Archive active note links with Wayback Machine",
      callback: () => void this.archiveActiveFileLinks()
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const link = findLinkUnderEditorCursor(editor, this.settings.archiveBareUrls);

        if (!link) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Archive link with Wayback Machine")
            .setIcon("archive")
            .onClick(() => void this.archiveEditorLink(editor, link));
        });
      })
    );

    this.addSettingTab(new WaybackLinkerSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = await this.loadData() as Partial<WaybackLinkerSettings> & {
      accessKey?: string;
      secretKey?: string;
      rememberSecretKey?: boolean;
    } | null;
    const {
      accessKey: legacyAccessKey = "",
      secretKey: legacySecretKey = "",
      rememberSecretKey: _rememberSecretKey,
      ...savedSettings
    } = saved ?? {};
    const credentialRefs = migrateLegacyCredentials(this.app.secretStorage, {
      accessKeySecretId: savedSettings.accessKeySecretId,
      secretKeySecretId: savedSettings.secretKeySecretId,
      accessKey: legacyAccessKey,
      secretKey: legacySecretKey
    });

    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings, credentialRefs);

    // Re-save without legacy credential fields after migration to SecretStorage.
    await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async archiveActiveFileLinks() {
    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice("Open a note before archiving links.");
      return;
    }

    if (file.extension !== "md") {
      new Notice("Wayback Linker only works on Markdown notes.");
      return;
    }

    try {
      await this.archiveFileLinks(file, this.getActiveEditorForFile(file));
    } catch (error) {
      console.error(error);
      new Notice(`Wayback Linker failed: ${getErrorMessage(error)}`, 10000);
    }
  }

  private getActiveEditorForFile(file: TFile) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file === file ? view.editor : undefined;
  }

  private async archiveFileLinks(file: TFile, editor?: Editor) {
    const content = editor?.getValue() ?? await this.app.vault.read(file);
    const matches = findExternalLinks(content, this.settings.archiveBareUrls);

    if (matches.length === 0) {
      new Notice("No external HTTP links found in this note.");
      return;
    }

    const urls = Array.from(new Set(matches.map((match) => normalizeUrl(match.url))));
    const archivedByUrl = new Map<string, ArchiveResult>();
    const status = this.addStatusBarItem();
    const progress = new WaybackProgressModal(this.app, urls);

    status.addClass("wayback-status-item");
    status.setAttr("aria-label", "Open Wayback Linker progress");
    status.setAttr("title", "Open Wayback Linker progress");
    status.onClickEvent(() => progress.open());
    progress.open();

    try {
      for (let index = 0; index < urls.length; index++) {
        const url = urls[index];
        status.setText(`Wayback ${index + 1}/${urls.length}`);
        progress.markWorking(index);
        new Notice(`Archiving ${index + 1}/${urls.length}: ${url}`, 3500);

        const result = await archiveUrl(url, this.settings, this.app.secretStorage, (message) => {
          progress.updateMessage(index, message);
          status.setText(`Wayback ${index + 1}/${urls.length}: waiting`);
        });
        archivedByUrl.set(url, result);
        progress.markComplete(index, result);

        if (index < urls.length - 1 && this.settings.requestDelayMs > 0) {
          await sleep(this.settings.requestDelayMs);
        }
      }
    } finally {
      status.remove();
    }

    const latestContent = editor?.getValue() ?? await this.app.vault.read(file);
    const replacements = replacementsFromArchivedUrls(
      latestContent,
      archivedByUrl,
      this.settings.archiveBareUrls
    );

    if (replacements.length === 0) {
      const failures = Array.from(archivedByUrl.values())
        .filter((result) => result.error)
        .map((result) => `${result.originalUrl}: ${result.error}`)
        .join("\n");

      new Notice(
        failures ? `No links replaced. Failures:\n${failures}` : "No links were archived.",
        15000
      );
      progress.finish();
      return;
    }

    const updatedContent = applyReplacements(latestContent, replacements);

    if (editor) {
      editor.setValue(updatedContent);
    } else {
      await this.app.vault.modify(file, updatedContent);
    }

    const failedCount = Array.from(archivedByUrl.values()).filter((result) => result.error).length;
    new Notice(
      `Replaced ${replacements.length} link${replacements.length === 1 ? "" : "s"} with Wayback URL${replacements.length === 1 ? "" : "s"}.` +
        (failedCount ? ` ${failedCount} URL${failedCount === 1 ? "" : "s"} failed.` : ""),
      10000
    );
    progress.finish();
  }

  private async archiveEditorLink(editor: Editor, link: LinkMatch) {
    new Notice(`Archiving: ${link.url}`, 3500);

    const result = await archiveUrl(
      normalizeUrl(link.url),
      this.settings,
      this.app.secretStorage
    );

    if (!result.archivedUrl) {
      new Notice(`Wayback Linker failed: ${result.error ?? "No archived URL returned."}`, 10000);
      return;
    }

    const currentContent = editor.getValue();
    const currentTarget = currentContent.slice(link.start, link.end);
    const expectedTarget = currentContentFromLink(link);

    if (currentTarget !== expectedTarget) {
      new Notice("The link changed before Wayback Linker could replace it. Try again.", 10000);
      return;
    }

    editor.replaceRange(
      link.replacement(result.archivedUrl),
      editor.offsetToPos(link.start),
      editor.offsetToPos(link.end)
    );

    new Notice("Replaced link with Wayback URL.", 6000);
  }
}

export function findExternalLinks(content: string, includeBareUrls: boolean): LinkMatch[] {
  const occupiedRanges: Array<[number, number]> = [];
  const matches: LinkMatch[] = [];

  addMarkdownLinks(content, matches, occupiedRanges);
  addAutolinks(content, matches, occupiedRanges);

  if (includeBareUrls) {
    addBareUrls(content, matches, occupiedRanges);
  }

  return matches.sort((a, b) => a.start - b.start);
}

function findLinkUnderEditorCursor(editor: Editor, includeBareUrls: boolean) {
  const content = editor.getValue();
  const cursorOffset = editor.posToOffset(editor.getCursor());
  const selectionStart = editor.posToOffset(editor.getCursor("from"));
  const selectionEnd = editor.posToOffset(editor.getCursor("to"));
  const matches = findExternalLinks(content, includeBareUrls);

  return matches.find((match) => {
    if (selectionStart !== selectionEnd) {
      return match.start <= selectionStart && match.end >= selectionEnd;
    }

    return cursorOffset >= match.start && cursorOffset <= match.end;
  });
}

function addMarkdownLinks(
  content: string,
  matches: LinkMatch[],
  occupiedRanges: Array<[number, number]>
) {
  const markdownLinkPattern = /(!?)\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+["'][^"'\n]*["'])?\)/g;
  let match: RegExpExecArray | null;

  while ((match = markdownLinkPattern.exec(content)) !== null) {
    const isImage = match[1] === "!";
    occupiedRanges.push([match.index, match.index + match[0].length]);

    if (isImage) {
      continue;
    }

    const rawTarget = match[3];
    const unwrappedUrl = unwrapAngleBrackets(rawTarget);

    if (!shouldArchiveUrl(unwrappedUrl)) {
      continue;
    }

    const targetStart = match.index + match[0].indexOf(rawTarget);
    const targetEnd = targetStart + rawTarget.length;
    const isWrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">");

    matches.push({
      start: targetStart,
      end: targetEnd,
      url: unwrappedUrl,
      replacement: (archivedUrl) => (isWrapped ? `<${archivedUrl}>` : archivedUrl)
    });
  }
}

function addAutolinks(
  content: string,
  matches: LinkMatch[],
  occupiedRanges: Array<[number, number]>
) {
  const autolinkPattern = /<https?:\/\/[^>\s]+>/gi;
  let match: RegExpExecArray | null;

  while ((match = autolinkPattern.exec(content)) !== null) {
    if (isInOccupiedRange(match.index, occupiedRanges)) {
      continue;
    }

    const rawUrl = match[0].slice(1, -1);
    if (!shouldArchiveUrl(rawUrl)) {
      continue;
    }

    matches.push({
      start: match.index + 1,
      end: match.index + match[0].length - 1,
      url: rawUrl,
      replacement: (archivedUrl) => archivedUrl
    });
    occupiedRanges.push([match.index, match.index + match[0].length]);
  }
}

function addBareUrls(
  content: string,
  matches: LinkMatch[],
  occupiedRanges: Array<[number, number]>
) {
  const bareUrlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  let match: RegExpExecArray | null;

  while ((match = bareUrlPattern.exec(content)) !== null) {
    if (isInOccupiedRange(match.index, occupiedRanges)) {
      continue;
    }

    const trimmed = trimTrailingPunctuation(match[0]);
    if (!shouldArchiveUrl(trimmed.url)) {
      continue;
    }

    matches.push({
      start: match.index,
      end: match.index + trimmed.url.length,
      url: trimmed.url,
      replacement: (archivedUrl) => archivedUrl
    });
    occupiedRanges.push([match.index, match.index + trimmed.url.length]);
  }
}

function isInOccupiedRange(index: number, occupiedRanges: Array<[number, number]>) {
  return occupiedRanges.some(([start, end]) => index >= start && index < end);
}

export function shouldArchiveUrl(url: string) {
  if (!HTTP_URL_PATTERN.test(url)) {
    return false;
  }

  try {
    return normalizeArchiveHost(new URL(url).hostname) !== "web.archive.org";
  } catch {
    return false;
  }
}

function normalizeArchiveHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function normalizeUrl(url: string) {
  return url.trim();
}

function unwrapAngleBrackets(url: string) {
  return url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
}

function trimTrailingPunctuation(url: string) {
  let next = url;

  while (/[.,;:!?]$/.test(next)) {
    next = next.slice(0, -1);
  }

  return { url: next };
}

async function archiveUrl(
  url: string,
  settings: WaybackLinkerSettings,
  secretStorage: SecretStorageLike,
  onProgress?: (message: string) => void
): Promise<ArchiveResult> {
  const headers = waybackHeaders(settings, secretStorage);

  try {
    let capture: CaptureResult = {};

    for (let attempt = 0; attempt <= settings.maxThrottleRetries; attempt++) {
      const requestedAt = new Date();

      if (attempt > 0) {
        onProgress?.(`Retrying after throttle (${attempt}/${settings.maxThrottleRetries})`);
      }

      const response = await requestUrl({
        url: "https://web.archive.org/save",
        method: "POST",
        headers,
        body: new URLSearchParams({
          url,
          if_not_archived_within: "0",
          skip_first_archive: "1"
        }).toString(),
        throw: false
      });

      capture = await captureFromSaveResponse(
        response,
        url,
        requestedAt,
        settings.maxCaptureWaitSeconds,
        headers
      );

      if (capture.archivedUrl || !capture.retryableThrottle || attempt >= settings.maxThrottleRetries) {
        break;
      }

      onProgress?.(
        `Throttled by active Save Page Now sessions. Waiting ${settings.throttleRetryDelaySeconds}s before retry ${attempt + 1}/${settings.maxThrottleRetries}.`
      );
      await sleep(settings.throttleRetryDelaySeconds * 1000);
    }

    if (!capture.archivedUrl && settings.fallbackToLatestSnapshot) {
      onProgress?.("Fresh capture failed. Looking for latest existing snapshot.");
      const fallbackUrl = await latestAvailableSnapshot(url);

      if (fallbackUrl) {
        return { originalUrl: url, archivedUrl: fallbackUrl, usedFallback: true };
      }
    }

    if (!capture.archivedUrl) {
      return {
        originalUrl: url,
        error: capture.error ?? "Wayback did not return a fresh archived URL."
      };
    }

    return { originalUrl: url, archivedUrl: capture.archivedUrl };
  } catch (error) {
    return { originalUrl: url, error: getErrorMessage(error) };
  }
}

async function captureFromSaveResponse(
  response: { headers: Record<string, string>; json: unknown; status: number; text: string },
  originalUrl: string,
  requestedAt: Date,
  maxWaitSeconds: number,
  headers: Record<string, string>
): Promise<CaptureResult> {
  const data = parseCaptureResponse(response.json);

  if (data.job_id) {
    return pollCaptureStatus(data.job_id, originalUrl, requestedAt, maxWaitSeconds, headers);
  }

  const timestamp = data.timestamp ?? timestampFromWaybackUrl(data.url);
  const archivedUrl =
    data.url ??
    archivedUrlFromHeaders(response.headers, originalUrl) ??
    archivedUrlFromBody(response.text, originalUrl);

  if (timestamp && archivedUrl) {
    return isFreshTimestamp(timestamp, requestedAt)
      ? { archivedUrl: normalizeWaybackPlaybackUrl(archivedUrl, originalUrl) }
      : {
          error: `Wayback returned an older snapshot from ${formatWaybackTimestamp(timestamp)} instead of a new capture.`
        };
  }

  const error = data.message ?? data.status ?? response.text.slice(0, 200);
  return { error, retryableThrottle: isActiveSessionThrottle(error) };
}

async function pollCaptureStatus(
  jobId: string,
  originalUrl: string,
  requestedAt: Date,
  maxWaitSeconds: number,
  headers: Record<string, string>
): Promise<CaptureResult> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastMessage = "";

  while (Date.now() < deadline) {
    await sleep(3000);

    const response = await requestUrl({
      url: `https://web.archive.org/save/status/${encodeURIComponent(jobId)}?_t=${Date.now()}`,
      method: "GET",
      headers,
      throw: false
    });
    const status = parseCaptureResponse(response.json);

    lastMessage = status.message ?? status.status ?? lastMessage;

    if (status.status === "success" && status.timestamp) {
      if (!isFreshTimestamp(status.timestamp, requestedAt)) {
        return {
          error: `Wayback returned an older snapshot from ${formatWaybackTimestamp(status.timestamp)} instead of a new capture.`
        };
      }

      return {
        archivedUrl: `https://web.archive.org/web/${status.timestamp}/${status.original_url ?? originalUrl}`
      };
    }

    if (status.status === "error") {
      const error = status.message ?? "Wayback capture failed.";
      return { error, retryableThrottle: isActiveSessionThrottle(error) };
    }
  }

  return {
    error: lastMessage
      ? `Timed out waiting for a fresh Wayback capture. Last status: ${lastMessage}`
      : "Timed out waiting for a fresh Wayback capture."
  };
}

function isActiveSessionThrottle(message: string | undefined) {
  return Boolean(message?.toLowerCase().includes("limit of active save page now sessions"));
}

function waybackHeaders(settings: WaybackLinkerSettings, secretStorage: SecretStorageLike) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
  };

  const accessKey = settings.accessKeySecretId
    ? secretStorage.getSecret(settings.accessKeySecretId) ?? ""
    : "";
  const secretKey = settings.secretKeySecretId
    ? secretStorage.getSecret(settings.secretKeySecretId) ?? ""
    : "";

  if (accessKey && secretKey) {
    headers.Authorization = `LOW ${accessKey}:${secretKey}`;
  }

  return headers;
}

function parseCaptureResponse(data: unknown) {
  const response = isRecord(data) ? data : {};

  return {
    job_id: getString(response, "job_id"),
    message: getString(response, "message"),
    original_url: getString(response, "original_url"),
    status: getString(response, "status"),
    timestamp: getString(response, "timestamp"),
    url: getString(response, "url")
  };
}

function archivedUrlFromHeaders(headers: Record<string, string>, originalUrl: string) {
  const location = getHeader(headers, "content-location") ?? getHeader(headers, "location");

  if (!location) {
    return undefined;
  }

  return absoluteWaybackUrl(location, originalUrl);
}

function archivedUrlFromBody(body: string, originalUrl: string) {
  const directMatch = body.match(/https:\/\/web\.archive\.org\/web\/\d+\/[^"'<\s]+/i);
  if (directMatch) {
    return directMatch[0];
  }

  const relativeMatch = body.match(/\/web\/\d+\/[^"'<\s]+/i);
  if (relativeMatch) {
    return absoluteWaybackUrl(relativeMatch[0], originalUrl);
  }

  return undefined;
}

function absoluteWaybackUrl(location: string, originalUrl: string) {
  if (/^https?:\/\//i.test(location)) {
    return location;
  }

  if (location.startsWith("/web/")) {
    return `https://web.archive.org${location}`;
  }

  if (/^web\/\d+\//i.test(location)) {
    return `https://web.archive.org/${location}`;
  }

  const timestamp = location.match(/\d{14}/)?.[0];
  return timestamp ? `https://web.archive.org/web/${timestamp}/${originalUrl}` : undefined;
}

async function latestAvailableSnapshot(url: string) {
  for (const candidate of fallbackUrlCandidates(url)) {
    const snapshot = await latestAvailableSnapshotFromAvailabilityApi(candidate) ??
      await latestAvailableSnapshotFromCdxApi(candidate);

    if (snapshot) {
      return snapshot;
    }
  }

  return undefined;
}

async function latestAvailableSnapshotFromAvailabilityApi(url: string) {
  const response = await requestUrl({
    url: `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }

  const data = isRecord(response.json) ? response.json : {};
  const snapshots = isRecord(data.archived_snapshots) ? data.archived_snapshots : {};
  const closest = isRecord(snapshots.closest) ? snapshots.closest : {};
  const available = closest.available === true || closest.available === "true";
  const snapshotUrl = getString(closest, "url");

  return available ? snapshotUrl : undefined;
}

export async function latestAvailableSnapshotFromCdxApi(url: string) {
  const response = await requestUrl({
    url: `https://web.archive.org/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&limit=-1`,
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }

  const rows = Array.isArray(response.json) ? response.json : [];
  const lastRow = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .filter((row) => typeof row[0] === "string" && /^\d{14}$/.test(row[0]))
    .at(-1);

  if (!lastRow) {
    return undefined;
  }

  const timestamp = String(lastRow[0]);
  const original = typeof lastRow[1] === "string" ? lastRow[1] : url;

  return `https://web.archive.org/web/${timestamp}/${original}`;
}

export function fallbackUrlCandidates(url: string) {
  const candidates = [url];
  const withoutHash = url.split("#")[0];

  if (withoutHash !== url) {
    candidates.push(withoutHash);
  }

  if (withoutHash.endsWith("/")) {
    candidates.push(withoutHash.slice(0, -1));
  } else {
    candidates.push(`${withoutHash}/`);
  }

  return Array.from(new Set(candidates));
}

function getHeader(headers: Record<string, string>, name: string) {
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return matchingKey ? headers[matchingKey] : undefined;
}

function normalizeWaybackPlaybackUrl(url: string, originalUrl: string) {
  return absoluteWaybackUrl(url, originalUrl) ?? url;
}

function timestampFromWaybackUrl(url: string | undefined) {
  return url?.match(/\/web\/(\d{14})\//)?.[1];
}

export function isFreshTimestamp(timestamp: string, requestedAt: Date) {
  const captureDate = dateFromWaybackTimestamp(timestamp);
  return Boolean(captureDate && captureDate.getTime() >= requestedAt.getTime() - 5 * 60 * 1000);
}

export function dateFromWaybackTimestamp(timestamp: string) {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);

  if (!match) {
    return undefined;
  }

  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  ));
}

function formatWaybackTimestamp(timestamp: string) {
  return dateFromWaybackTimestamp(timestamp)?.toISOString() ?? timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function migrateLegacyCredentials(
  secretStorage: SecretStorageLike,
  legacy: {
    accessKeySecretId?: string;
    secretKeySecretId?: string;
    accessKey?: string;
    secretKey?: string;
  }
) {
  const defaultAccessKeyExists = secretStorage.getSecret(ACCESS_KEY_SECRET_ID) !== null;
  const defaultSecretKeyExists = secretStorage.getSecret(SECRET_KEY_SECRET_ID) !== null;
  const accessKeySecretId = legacy.accessKeySecretId ??
    (legacy.accessKey || defaultAccessKeyExists ? ACCESS_KEY_SECRET_ID : "");
  const secretKeySecretId = legacy.secretKeySecretId ??
    (legacy.secretKey || defaultSecretKeyExists ? SECRET_KEY_SECRET_ID : "");

  if (
    accessKeySecretId &&
    secretStorage.getSecret(accessKeySecretId) === null &&
    legacy.accessKey
  ) {
    secretStorage.setSecret(accessKeySecretId, legacy.accessKey);
  }

  if (
    secretKeySecretId &&
    secretStorage.getSecret(secretKeySecretId) === null &&
    legacy.secretKey
  ) {
    secretStorage.setSecret(secretKeySecretId, legacy.secretKey);
  }

  return { accessKeySecretId, secretKeySecretId };
}

export function replacementsFromArchivedUrls(
  content: string,
  archivedByUrl: Map<string, ArchiveResult>,
  includeBareUrls: boolean
) {
  return findExternalLinks(content, includeBareUrls)
    .map((match) => {
      const result = archivedByUrl.get(normalizeUrl(match.url));
      return result?.archivedUrl
        ? { match, archivedUrl: result.archivedUrl }
        : undefined;
    })
    .filter((item): item is { match: LinkMatch; archivedUrl: string } => Boolean(item));
}

export function applyReplacements(
  content: string,
  replacements: Array<{ match: LinkMatch; archivedUrl: string }>
) {
  let updated = content;

  for (const { match, archivedUrl } of [...replacements].sort((a, b) => b.match.start - a.match.start)) {
    updated =
      updated.slice(0, match.start) +
      match.replacement(archivedUrl) +
      updated.slice(match.end);
  }

  return updated;
}

function currentContentFromLink(link: LinkMatch) {
  return link.replacement(link.url);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class WaybackLinkerSettingTab extends PluginSettingTab {
  plugin: WaybackLinkerPlugin;

  constructor(app: App, plugin: WaybackLinkerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Delay between archive requests")
      .setDesc("Milliseconds to wait between Wayback Machine requests.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.requestDelayMs))
          .setValue(String(this.plugin.settings.requestDelayMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.requestDelayMs = Number.isFinite(parsed) && parsed >= 0
              ? parsed
              : DEFAULT_SETTINGS.requestDelayMs;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive bare URLs")
      .setDesc("Also replace plain pasted URLs that are not inside Markdown links.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.archiveBareUrls)
          .onChange(async (value) => {
            this.plugin.settings.archiveBareUrls = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum wait for fresh captures")
      .setDesc("Seconds to wait for Wayback Machine to finish a new capture before leaving the original link unchanged.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxCaptureWaitSeconds))
          .setValue(String(this.plugin.settings.maxCaptureWaitSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxCaptureWaitSeconds = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : DEFAULT_SETTINGS.maxCaptureWaitSeconds;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Fall back to latest existing snapshot")
      .setDesc("If a fresh capture fails, replace the URL with Wayback's most recent existing snapshot instead.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.fallbackToLatestSnapshot)
          .onChange(async (value) => {
            this.plugin.settings.fallbackToLatestSnapshot = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Throttle retry delay")
      .setDesc("Seconds to wait before retrying when Wayback says active Save Page Now sessions are at the limit.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.throttleRetryDelaySeconds))
          .setValue(String(this.plugin.settings.throttleRetryDelaySeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.throttleRetryDelaySeconds = Number.isFinite(parsed) && parsed > 0
              ? parsed
              : DEFAULT_SETTINGS.throttleRetryDelaySeconds;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum throttle retries")
      .setDesc("How many times to retry a URL after Wayback reports the active-session limit.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxThrottleRetries))
          .setValue(String(this.plugin.settings.maxThrottleRetries))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxThrottleRetries = Number.isFinite(parsed) && parsed >= 0
              ? parsed
              : DEFAULT_SETTINGS.maxThrottleRetries;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Internet Archive access key")
      .setDesc("Select or create an Obsidian keychain secret containing the access key from archive.org/account/s3.php.")
      .addComponent((containerEl) => {
        const comp = new SecretComponent(this.app, containerEl);
        if (this.plugin.settings.accessKeySecretId) {
          comp.setValue(this.plugin.settings.accessKeySecretId);
        }
        comp.onChange(async (value) => {
          this.plugin.settings.accessKeySecretId = value;
          await this.plugin.saveSettings();
        });
        return comp;
      });

    new Setting(containerEl)
      .setName("Internet Archive secret key")
      .setDesc("Select or create an Obsidian keychain secret containing the Internet Archive secret key.")
      .addComponent((containerEl) => {
        const comp = new SecretComponent(this.app, containerEl);
        if (this.plugin.settings.secretKeySecretId) {
          comp.setValue(this.plugin.settings.secretKeySecretId);
        }
        comp.onChange(async (value) => {
          this.plugin.settings.secretKeySecretId = value;
          await this.plugin.saveSettings();
        });
        return comp;
      });
  }
}

class WaybackProgressModal extends Modal {
  private items: ArchiveProgressItem[];
  private headingEl: HTMLElement;
  private summaryEl: HTMLElement;
  private currentEl: HTMLElement;
  private listEl: HTMLElement;
  private finished = false;

  constructor(app: App, urls: string[]) {
    super(app);
    this.items = urls.map((url) => ({
      url,
      state: "pending",
      message: "Waiting"
    }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("wayback-progress-shell");
    contentEl.addClass("wayback-progress-modal");

    this.headingEl = contentEl.createEl("h2", { text: "Wayback Linker" });
    this.summaryEl = contentEl.createDiv("wayback-progress-summary");
    this.currentEl = contentEl.createDiv("wayback-progress-current");
    this.listEl = contentEl.createDiv("wayback-progress-list");

    this.render();
  }

  onClose() {
    this.modalEl.removeClass("wayback-progress-shell");
  }

  markWorking(index: number) {
    this.items[index].state = "working";
    this.items[index].message = "Requesting fresh capture";
    this.render();
  }

  markComplete(index: number, result: ArchiveResult) {
    if (result.archivedUrl) {
      this.items[index].state = result.usedFallback ? "fallback" : "success";
      this.items[index].message = result.usedFallback
        ? "Used latest existing snapshot"
        : "Fresh capture saved";
    } else {
      this.items[index].state = "failed";
      this.items[index].message = result.error ?? "Failed";
    }

    this.render();
  }

  updateMessage(index: number, message: string) {
    this.items[index].state = "working";
    this.items[index].message = message;
    this.render();
  }

  finish() {
    this.finished = true;
    this.render();
  }

  private render() {
    if (!this.summaryEl || !this.currentEl || !this.listEl) {
      return;
    }

    const completed = this.items.filter((item) => item.state !== "pending" && item.state !== "working").length;
    const successes = this.items.filter((item) => item.state === "success").length;
    const fallbacks = this.items.filter((item) => item.state === "fallback").length;
    const failures = this.items.filter((item) => item.state === "failed").length;
    const current = this.items.find((item) => item.state === "working");

    this.headingEl.setText(this.finished ? "Wayback Linker complete" : "Wayback Linker running");
    this.summaryEl.setText(
      `${completed}/${this.items.length} done | ${successes} fresh | ${fallbacks} fallback | ${failures} failed`
    );
    this.currentEl.setText(current ? `Current: ${current.url}` : "Current: none");
    this.listEl.empty();

    for (const item of this.items) {
      const row = this.listEl.createDiv(`wayback-progress-row wayback-progress-${item.state}`);
      row.createSpan({ cls: "wayback-progress-state", text: stateLabel(item.state) });
      const detail = row.createDiv("wayback-progress-detail");
      detail.createDiv({ cls: "wayback-progress-url", text: item.url });
      detail.createDiv({ cls: "wayback-progress-message", text: item.message });
    }
  }
}

function stateLabel(state: ArchiveState) {
  switch (state) {
    case "pending":
      return "Pending";
    case "working":
      return "Working";
    case "success":
      return "Fresh";
    case "fallback":
      return "Fallback";
    case "failed":
      return "Failed";
  }
}
