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
  ignoredDomains: string[];
  maxCaptureWaitSeconds: number;
  accessKeySecretId: string;
  secretKeySecretId: string;
  fallbackToLatestSnapshot: boolean;
  throttleRetryDelaySeconds: number;
  maxThrottleRetries: number;
  debugMode: boolean;
}

const DEFAULT_SETTINGS: WaybackLinkerSettings = {
  requestDelayMs: 1500,
  archiveBareUrls: true,
  ignoredDomains: [],
  maxCaptureWaitSeconds: 90,
  accessKeySecretId: "",
  secretKeySecretId: "",
  fallbackToLatestSnapshot: false,
  throttleRetryDelaySeconds: 60,
  maxThrottleRetries: 3,
  debugMode: false
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
  canceled?: boolean;
}

interface CaptureResult {
  archivedUrl?: string;
  error?: string;
  retryableThrottle?: boolean;
}

type ArchiveState = "pending" | "working" | "success" | "fallback" | "failed" | "canceled";

interface ArchiveProgressItem {
  url: string;
  state: ArchiveState;
  message: string;
}

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

interface CancellationToken {
  cancelled: boolean;
}

const HTTP_URL_PATTERN = /^https?:\/\//i;

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

    this.addCommand({
      id: "archive-vault-links",
      name: "Archive all vault links with Wayback Machine",
      callback: () => void this.archiveVaultLinks()
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const link = findLinkUnderEditorCursor(
          editor,
          this.settings.archiveBareUrls,
          this.settings.ignoredDomains
        );

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
    const saved = await this.loadData() as (Partial<WaybackLinkerSettings> & {
      ignoredDomains?: string[] | string;
    }) | null;
    const { ignoredDomains, ...savedSettings } = saved ?? {};

    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.settings.ignoredDomains = Array.isArray(ignoredDomains)
      ? normalizedIgnoredDomains(ignoredDomains)
      : typeof ignoredDomains === "string"
      ? parseIgnoredDomainsSetting(ignoredDomains)
      : DEFAULT_SETTINGS.ignoredDomains;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async archiveActiveFileLinks() {
    const file = this.app.workspace.getActiveFile();

    if (!file) {
      logDebug(this.settings, "Open a note before archiving links.");
      new Notice("Open a note before archiving links.");
      return;
    }

    if (file.extension !== "md") {
      logDebug(this.settings, "Wayback Linker only works on Markdown notes.");
      new Notice("Wayback Linker only works on Markdown notes.");
      return;
    }

    try {
      await this.archiveFileLinks(file, this.getActiveEditorForFile(file));
    } catch (error) {
      logError(this.settings, "Wayback Linker failed", error);
      new Notice(`Wayback Linker failed: ${getErrorMessage(error)}`, 10000);
    }
  }

  private getActiveEditorForFile(file: TFile) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file === file ? view.editor : undefined;
  }

  private async archiveVaultLinks() {
    try {
      new Notice("Wayback Linker is scanning the vault for external links.", 5000);

      const scans = await this.scanVaultForLinks();
      const urls = Array.from(new Set(scans.reduce<string[]>((all, scan) => all.concat(scan.urls), [])));
      const linkCount = scans.reduce((total, scan) => total + scan.linkCount, 0);

      if (urls.length === 0) {
        new Notice("No archivable external HTTP links found in the vault.");
        return;
      }

      const confirmed = await confirmVaultArchive(this.app, {
        linkCount,
        noteCount: scans.length,
        uniqueUrlCount: urls.length
      });

      if (!confirmed) {
        new Notice("Wayback Linker vault scan canceled.");
        return;
      }

      const { archivedByUrl, progress, canceled } = await this.archiveUrlsWithProgress(
        urls,
        "Wayback vault",
        "Wayback vault scan"
      );

      let replacedCount = 0;
      let changedFileCount = 0;

      for (const scan of scans) {
        const editor = this.getActiveEditorForFile(scan.file);
        const latestContent = editor?.getValue() ?? await this.app.vault.read(scan.file);
        const replacements = replacementsFromArchivedUrls(
          latestContent,
          archivedByUrl,
          this.settings.archiveBareUrls,
          this.settings.ignoredDomains
        );

        if (replacements.length === 0) {
          continue;
        }

        const updatedContent = applyReplacements(latestContent, replacements);

        if (editor) {
          editor.setValue(updatedContent);
        } else {
          await this.app.vault.modify(scan.file, updatedContent);
        }

        replacedCount += replacements.length;
        changedFileCount++;
      }

      const failedCount = countFailedResults(archivedByUrl);

      new Notice(
        canceled
          ? replacedCount
            ? `Wayback Linker canceled. Replaced ${replacedCount} completed link${replacedCount === 1 ? "" : "s"} across ${changedFileCount} note${changedFileCount === 1 ? "" : "s"}.`
            : "Wayback Linker canceled. No links were replaced."
          : replacedCount
          ? `Replaced ${replacedCount} link${replacedCount === 1 ? "" : "s"} across ${changedFileCount} note${changedFileCount === 1 ? "" : "s"}.` +
              (failedCount ? ` ${failedCount} URL${failedCount === 1 ? "" : "s"} failed.` : "")
          : "No links were replaced after the vault scan.",
        15000
      );
      progress.finish(canceled);
    } catch (error) {
      logError(this.settings, "Wayback Linker vault scan failed", error);
      new Notice(`Wayback Linker vault scan failed: ${getErrorMessage(error)}`, 10000);
    }
  }

  private async scanVaultForLinks() {
    const scans: Array<{ file: TFile; linkCount: number; urls: string[] }> = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file);
      const matches = findExternalLinks(
        content,
        this.settings.archiveBareUrls,
        this.settings.ignoredDomains
      );

      if (matches.length === 0) {
        continue;
      }

      scans.push({
        file,
        linkCount: matches.length,
        urls: uniqueNormalizedUrls(matches)
      });
    }

    return scans;
  }

  private async archiveFileLinks(file: TFile, editor?: Editor) {
    const content = editor?.getValue() ?? await this.app.vault.read(file);
    const matches = findExternalLinks(
      content,
      this.settings.archiveBareUrls,
      this.settings.ignoredDomains
    );

    if (matches.length === 0) {
      logDebug(this.settings, "No archivable external HTTP links found in this note.");
      new Notice("No archivable external HTTP links found in this note.");
      return;
    }

    const urls = uniqueNormalizedUrls(matches);
    const { archivedByUrl, progress, canceled } = await this.archiveUrlsWithProgress(
      urls,
      "Wayback",
      "Wayback Linker"
    );

    const latestContent = editor?.getValue() ?? await this.app.vault.read(file);
    const replacements = replacementsFromArchivedUrls(
      latestContent,
      archivedByUrl,
      this.settings.archiveBareUrls,
      this.settings.ignoredDomains
    );

    if (replacements.length === 0) {
      const failures = Array.from(archivedByUrl.values())
        .filter((result) => result.error && !result.canceled)
        .map((result) => `${result.originalUrl}: ${result.error}`)
        .join("\n");

      const msg = canceled
        ? "Wayback Linker canceled. No links were replaced."
        : failures
        ? `No links replaced. Failures:\n${failures}`
        : "No links were archived.";
      logDebug(this.settings, msg);
      new Notice(msg, 15000);
      progress.finish(canceled);
      return;
    }

    const updatedContent = applyReplacements(latestContent, replacements);

    if (editor) {
      editor.setValue(updatedContent);
    } else {
      await this.app.vault.modify(file, updatedContent);
    }

    const failedCount = countFailedResults(archivedByUrl);
    new Notice(
      canceled
        ? `Wayback Linker canceled. Replaced ${replacements.length} completed link${replacements.length === 1 ? "" : "s"} with Wayback URL${replacements.length === 1 ? "" : "s"}.`
        : `Replaced ${replacements.length} link${replacements.length === 1 ? "" : "s"} with Wayback URL${replacements.length === 1 ? "" : "s"}.` +
          (failedCount ? ` ${failedCount} URL${failedCount === 1 ? "" : "s"} failed.` : ""),
      10000
    );
    progress.finish(canceled);
  }

  private async archiveUrlsWithProgress(
    urls: string[],
    statusPrefix: string,
    progressTitle: string
  ) {
    const archivedByUrl = new Map<string, ArchiveResult>();
    const cancellation: CancellationToken = { cancelled: false };
    const status = this.addStatusBarItem();
    const progress = new WaybackProgressModal(this.app, urls, progressTitle, () => {
      cancellation.cancelled = true;
      status.setText(`${statusPrefix}: canceling`);
    });

    status.addClass("wayback-status-item");
    status.setAttr("aria-label", "Open Wayback Linker progress");
    status.setAttr("title", "Open Wayback Linker progress");
    status.onClickEvent(() => progress.open());
    progress.open();

    try {
      for (let index = 0; index < urls.length; index++) {
        if (cancellation.cancelled) {
          break;
        }

        const url = urls[index];
        status.setText(`${statusPrefix} ${index + 1}/${urls.length}`);
        progress.markWorking(index);
        new Notice(`Archiving ${index + 1}/${urls.length}: ${url}`, 3500);

        const result = await archiveUrl(
          url,
          this.settings,
          this.app.secretStorage,
          (message) => {
            progress.updateMessage(index, message);
            status.setText(`${statusPrefix} ${index + 1}/${urls.length}: waiting`);
          },
          cancellation
        );
        archivedByUrl.set(url, result);
        progress.markComplete(index, result);

        if (index < urls.length - 1 && this.settings.requestDelayMs > 0) {
          await cancellableSleep(this.settings.requestDelayMs, cancellation);
        }
      }
    } finally {
      status.remove();
    }

    return { archivedByUrl, progress, canceled: cancellation.cancelled };
  }

  private async archiveEditorLink(editor: Editor, link: LinkMatch) {
    new Notice(`Archiving: ${link.url}`, 3500);

    const result = await archiveUrl(
      normalizeUrl(link.url),
      this.settings,
      this.app.secretStorage
    );

    if (!result.archivedUrl) {
      const errorMsg = result.error ?? "No archived URL returned.";
      logError(this.settings, `Wayback Linker failed: ${errorMsg}`);
      new Notice(`Wayback Linker failed: ${errorMsg}`, 10000);
      return;
    }

    const currentContent = editor.getValue();
    const currentTarget = currentContent.slice(link.start, link.end);
    const expectedTarget = currentContentFromLink(link);

    if (currentTarget !== expectedTarget) {
      logDebug(this.settings, `The link changed before Wayback Linker could replace it. Expected: ${expectedTarget}, Actual: ${currentTarget}`);
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

export function findExternalLinks(
  content: string,
  includeBareUrls: boolean,
  ignoredDomains: string[] = []
): LinkMatch[] {
  const occupiedRanges: Array<[number, number]> = [];
  const matches: LinkMatch[] = [];

  addMarkdownLinks(content, matches, occupiedRanges, ignoredDomains);
  addAutolinks(content, matches, occupiedRanges, ignoredDomains);

  if (includeBareUrls) {
    addBareUrls(content, matches, occupiedRanges, ignoredDomains);
  }

  return matches.sort((a, b) => a.start - b.start);
}

function findLinkUnderEditorCursor(
  editor: Editor,
  includeBareUrls: boolean,
  ignoredDomains: string[] = []
) {
  const content = editor.getValue();
  const cursorOffset = editor.posToOffset(editor.getCursor());
  const selectionStart = editor.posToOffset(editor.getCursor("from"));
  const selectionEnd = editor.posToOffset(editor.getCursor("to"));
  const matches = findExternalLinks(content, includeBareUrls, ignoredDomains);

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
  occupiedRanges: Array<[number, number]>,
  ignoredDomains: string[]
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

    if (!shouldArchiveUrl(unwrappedUrl, ignoredDomains)) {
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
  occupiedRanges: Array<[number, number]>,
  ignoredDomains: string[]
) {
  const autolinkPattern = /<https?:\/\/[^>\s]+>/gi;
  let match: RegExpExecArray | null;

  while ((match = autolinkPattern.exec(content)) !== null) {
    if (isInOccupiedRange(match.index, occupiedRanges)) {
      continue;
    }

    const rawUrl = match[0].slice(1, -1);
    if (!shouldArchiveUrl(rawUrl, ignoredDomains)) {
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
  occupiedRanges: Array<[number, number]>,
  ignoredDomains: string[]
) {
  const bareUrlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  let match: RegExpExecArray | null;

  while ((match = bareUrlPattern.exec(content)) !== null) {
    if (isInOccupiedRange(match.index, occupiedRanges)) {
      continue;
    }

    const trimmed = trimTrailingPunctuation(match[0]);
    if (!shouldArchiveUrl(trimmed.url, ignoredDomains)) {
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

export function shouldArchiveUrl(url: string, ignoredDomains: string[] = []) {
  if (!HTTP_URL_PATTERN.test(url)) {
    return false;
  }

  try {
    const hostname = normalizeArchiveHost(new URL(url).hostname);
    return hostname !== "web.archive.org" && !isIgnoredHostname(hostname, ignoredDomains);
  } catch {
    return false;
  }
}

function normalizeArchiveHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isIgnoredHostname(hostname: string, ignoredDomains: string[]) {
  return normalizedIgnoredDomains(ignoredDomains).some((ignoredDomain) =>
    hostname === ignoredDomain || hostname.endsWith(`.${ignoredDomain}`)
  );
}

export function parseIgnoredDomainsSetting(value: string) {
  return normalizedIgnoredDomains(value.split(/[\n,]/));
}

function normalizedIgnoredDomains(domains: string[]) {
  return Array.from(new Set(domains.map(normalizeIgnoredDomain).filter(Boolean)));
}

function normalizeIgnoredDomain(domain: string) {
  const trimmed = domain.trim().toLowerCase();

  if (!trimmed) {
    return "";
  }

  const withoutWildcard = trimmed.replace(/^\*\./, "").replace(/^\./, "");

  try {
    return normalizeArchiveHost(new URL(withoutWildcard).hostname);
  } catch {
    return normalizeArchiveHost(withoutWildcard.split("/")[0] ?? "");
  }
}

function normalizeUrl(url: string) {
  return url.trim();
}

function uniqueNormalizedUrls(matches: LinkMatch[]) {
  return Array.from(new Set(matches.map((match) => normalizeUrl(match.url))));
}

export function uniqueArchiveUrlsFromContent(
  content: string,
  includeBareUrls: boolean,
  ignoredDomains: string[] = []
) {
  return uniqueNormalizedUrls(findExternalLinks(content, includeBareUrls, ignoredDomains));
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
  onProgress?: (message: string) => void,
  cancellation?: CancellationToken
): Promise<ArchiveResult> {
  const headers = waybackHeaders(settings, secretStorage);

  try {
    let capture: CaptureResult = {};

    for (let attempt = 0; attempt <= settings.maxThrottleRetries; attempt++) {
      if (cancellation?.cancelled) {
        return { originalUrl: url, error: "Canceled", canceled: true };
      }

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
        headers,
        cancellation
      );

      if (capture.archivedUrl || !capture.retryableThrottle || attempt >= settings.maxThrottleRetries) {
        break;
      }

      onProgress?.(
        `Throttled by active Save Page Now sessions. Waiting ${settings.throttleRetryDelaySeconds}s before retry ${attempt + 1}/${settings.maxThrottleRetries}.`
      );
      await cancellableSleep(settings.throttleRetryDelaySeconds * 1000, cancellation);
    }

    if (cancellation?.cancelled) {
      return { originalUrl: url, error: "Canceled", canceled: true };
    }

    if (!capture.archivedUrl && settings.fallbackToLatestSnapshot) {
      onProgress?.("Fresh capture failed. Looking for latest existing snapshot.");
      const fallbackUrl = await latestAvailableSnapshot(url);

      if (fallbackUrl) {
        return { originalUrl: url, archivedUrl: fallbackUrl, usedFallback: true };
      }
    }

    if (!capture.archivedUrl) {
      const errorMsg = capture.error ?? "Wayback did not return a fresh archived URL.";
      logError(settings, `Capture failed for ${url}: ${errorMsg}`);
      return {
        originalUrl: url,
        error: errorMsg
      };
    }

    return { originalUrl: url, archivedUrl: capture.archivedUrl };
  } catch (error) {
    logError(settings, `Exception while archiving ${url}`, error);
    return { originalUrl: url, error: getErrorMessage(error) };
  }
}

async function captureFromSaveResponse(
  response: { headers: Record<string, string>; json: unknown; status: number; text: string },
  originalUrl: string,
  requestedAt: Date,
  maxWaitSeconds: number,
  headers: Record<string, string>,
  cancellation?: CancellationToken
): Promise<CaptureResult> {
  const data = parseCaptureResponse(response.json);

  if (data.job_id) {
    return pollCaptureStatus(data.job_id, originalUrl, requestedAt, maxWaitSeconds, headers, cancellation);
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
  headers: Record<string, string>,
  cancellation?: CancellationToken
): Promise<CaptureResult> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastMessage = "";

  while (Date.now() < deadline) {
    if (cancellation?.cancelled) {
      return { error: "Canceled" };
    }

    await cancellableSleep(3000, cancellation);

    if (cancellation?.cancelled) {
      return { error: "Canceled" };
    }

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

  const json: unknown = response.json;
  const rows: unknown[] = Array.isArray(json) ? json : [];
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

export function logDebug(settings: WaybackLinkerSettings, message: string, ...args: unknown[]) {
  if (settings.debugMode) {
    console.log(`[Wayback Linker] ${message}`, ...args);
  }
}

export function logError(settings: WaybackLinkerSettings, message: string, error?: unknown) {
  if (settings.debugMode) {
    if (error) {
      console.error(`[Wayback Linker] ${message}`, error);
    } else {
      console.error(`[Wayback Linker] ${message}`);
    }
  }
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function replacementsFromArchivedUrls(
  content: string,
  archivedByUrl: Map<string, ArchiveResult>,
  includeBareUrls: boolean,
  ignoredDomains: string[] = []
) {
  return findExternalLinks(content, includeBareUrls, ignoredDomains)
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

function countFailedResults(archivedByUrl: Map<string, ArchiveResult>) {
  return Array.from(archivedByUrl.values()).filter((result) => result.error && !result.canceled).length;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function cancellableSleep(ms: number, cancellation?: CancellationToken) {
  const deadline = Date.now() + ms;

  while (!cancellation?.cancelled && Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
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
      .setName("Ignored domains")
      .setDesc("Domains to skip during note, vault, and right-click archiving. Use one per line or comma-separated values, for example amazon.com.")
      .addTextArea((text) =>
        text
          .setPlaceholder("amazon.com\nexample.org")
          .setValue(this.plugin.settings.ignoredDomains.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignoredDomains = parseIgnoredDomainsSetting(value);
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

    new Setting(containerEl)
      .setName("Debug Mode")
      .setDesc("Log all errors and internal issues to the developer console.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

class WaybackProgressModal extends Modal {
  private items: ArchiveProgressItem[];
  private title: string;
  private onCancel?: () => void;
  private headingEl: HTMLElement;
  private cancelButtonEl: HTMLButtonElement;
  private summaryEl: HTMLElement;
  private currentEl: HTMLElement;
  private listEl: HTMLElement;
  private finished = false;
  private canceled = false;
  private cancelRequested = false;

  constructor(app: App, urls: string[], title = "Wayback Linker", onCancel?: () => void) {
    super(app);
    this.title = title;
    this.onCancel = onCancel;
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

    const headerEl = contentEl.createDiv("wayback-progress-header");
    this.headingEl = headerEl.createEl("h2", { text: "Wayback Linker" });
    this.cancelButtonEl = headerEl.createEl("button", {
      cls: "wayback-progress-cancel",
      text: "Cancel"
    });
    this.cancelButtonEl.addEventListener("click", () => {
      this.onCancel?.();
      this.requestCancel();
    });
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
    if (result.canceled) {
      this.items[index].state = "canceled";
      this.items[index].message = "Canceled";
    } else if (result.archivedUrl) {
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
    if (this.items[index].state === "canceled") {
      return;
    }

    this.items[index].state = "working";
    this.items[index].message = message;
    this.render();
  }

  requestCancel() {
    this.cancelRequested = true;

    for (const item of this.items) {
      if (item.state === "pending") {
        item.state = "canceled";
        item.message = "Canceled before starting";
      } else if (item.state === "working") {
        item.message = "Canceling after current request finishes";
      }
    }

    this.render();
  }

  finish(canceled = false) {
    this.finished = true;
    this.canceled = canceled;

    if (canceled) {
      for (const item of this.items) {
        if (item.state === "pending" || item.state === "working") {
          item.state = "canceled";
          item.message = "Canceled";
        }
      }
    }

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
    const canceled = this.items.filter((item) => item.state === "canceled").length;
    const current = this.items.find((item) => item.state === "working");

    this.headingEl.setText(`${this.title} ${this.canceled ? "canceled" : this.finished ? "complete" : "running"}`);
    this.summaryEl.setText(
      `${completed}/${this.items.length} done | ${successes} fresh | ${fallbacks} fallback | ${failures} failed` +
        (canceled ? ` | ${canceled} canceled` : "")
    );
    this.currentEl.setText(current ? `Current: ${current.url}` : "Current: none");
    this.cancelButtonEl.disabled = this.finished || this.cancelRequested;
    this.cancelButtonEl.setText(this.cancelRequested ? "Canceling..." : "Cancel");
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
    case "canceled":
      return "Canceled";
  }
}

function confirmVaultArchive(
  app: App,
  counts: { linkCount: number; noteCount: number; uniqueUrlCount: number }
) {
  return new Promise<boolean>((resolve) => {
    new VaultArchiveConfirmModal(app, counts, resolve).open();
  });
}

class VaultArchiveConfirmModal extends Modal {
  private counts: { linkCount: number; noteCount: number; uniqueUrlCount: number };
  private resolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(
    app: App,
    counts: { linkCount: number; noteCount: number; uniqueUrlCount: number },
    resolve: (confirmed: boolean) => void
  ) {
    super(app);
    this.counts = counts;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("wayback-confirm-shell");
    contentEl.addClass("wayback-confirm-modal");

    contentEl.createEl("h2", { text: "Archive all vault links?" });
    contentEl.createEl("p", {
      cls: "wayback-confirm-intro",
      text: "Wayback Linker found external links across your vault."
    });

    const stats = contentEl.createDiv("wayback-confirm-stats");
    this.createStat(stats, String(this.counts.linkCount), "Links found");
    this.createStat(stats, String(this.counts.noteCount), "Notes affected");
    this.createStat(stats, String(this.counts.uniqueUrlCount), "Unique URLs to archive");

    contentEl.createEl("p", {
      cls: "wayback-confirm-note",
      text: "Successful fresh captures or enabled fallbacks will replace matching URLs across Markdown notes. Existing Wayback links are skipped."
    });

    const actions = contentEl.createDiv("wayback-confirm-actions");
    const cancelButton = actions.createEl("button", {
      cls: "wayback-confirm-button",
      text: "Cancel"
    });
    const confirmButton = actions.createEl("button", {
      cls: "wayback-confirm-button mod-cta",
      text: "Archive vault"
    });

    cancelButton.addEventListener("click", () => this.finish(false));
    confirmButton.addEventListener("click", () => this.finish(true));
  }

  onClose() {
    this.modalEl.removeClass("wayback-confirm-shell");

    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }
  }

  private createStat(container: HTMLElement, value: string, label: string) {
    const stat = container.createDiv("wayback-confirm-stat");
    stat.createDiv({ cls: "wayback-confirm-stat-value", text: value });
    stat.createDiv({ cls: "wayback-confirm-stat-label", text: label });
  }

  private finish(confirmed: boolean) {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}
