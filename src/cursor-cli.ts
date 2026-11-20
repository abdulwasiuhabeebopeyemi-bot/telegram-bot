/*
 * Offline cursor backup, restore and recovery preview command. It never contacts Stellar or
 * Telegram; restore uses the normal instance lock to exclude a running poller.
 */

import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { acquireInstanceLock } from "./instanceLock.js";
import { parseAndMigrateCursorFile } from "./poller.js";

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

export interface RecoveryPreviewOptions {
  cursorFile: string;
  /** Optional target name; when omitted every target in the cursor file is previewed. */
  target?: string;
  /** Proposed ledger to rewind to. Must not be newer than the current position. */
  proposedLedger: number;
  /** Inclusive lowest ledger still retained by the RPC/history window, if known. */
  retainedWindowStart?: number;
  /** Inclusive highest ledger currently retained, if known. */
  retainedWindowEnd?: number;
}

export interface RecoveryPreviewEntry {
  target: string;
  currentLedger: number | null;
  proposedLedger: number;
  missedLedgerRange: { from: number; to: number } | null;
  retainedWindow: { start: number; end: number } | null;
  withinRetainedWindow: boolean | null;
  warnings: string[];
}

export interface RecoveryPreview {
  schemaVersion: number;
  entries: RecoveryPreviewEntry[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function validateCursor(raw: string): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch {
    throw new Error("cursor file is malformed or uses an unsupported schema");
  }
}

async function writeAtomic(filePath: string, contents: string, replace: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    if (replace) {
      await rename(temporaryPath, filePath);
    } else {
      try {
        await link(temporaryPath, filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`destination already exists at ${filePath}; pass --force to overwrite`);
        }
        throw err;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<void> {
  const raw = await readFile(options.cursorFile, "utf8");
  const parsed = validateCursor(raw);
  if (!options.force && (await exists(options.backupFile))) {
    throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
  }
  await writeAtomic(options.backupFile, raw, options.force === true);
  console.log(
    `[cursor] backed up schema=v` + `${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
      `from ${options.cursorFile} to ${options.backupFile}`,
  );
}

/** Restore a compatible cursor while holding the poller's exclusive lock. */
export async function restoreCursor(options: RestoreCursorOptions): Promise<void> {
  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const raw = await readFile(options.backupFile, "utf8");
    const parsed = validateCursor(raw);
    if (!options.force && (await exists(options.cursorFile))) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }
    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true);
    console.log(
      `[cursor] restored schema=v${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
        `from ${options.backupFile} to ${options.cursorFile}`,
    );
  } finally {
    await lock.release();
  }
}

/**
 * Read-only recovery preview. Shows the current and proposed cursor positions for each
 * target along with the estimated missed ledger range and retained-window evidence.
 * It never writes the cursor file, never guesses opaque tokens and never contacts the chain.
 */
export async function previewRecovery(options: RecoveryPreviewOptions): Promise<RecoveryPreview> {
  if (!Number.isSafeInteger(options.proposedLedger) || options.proposedLedger < 0) {
    throw new Error("proposed ledger must be a non-negative integer");
  }
  const hasStart = options.retainedWindowStart !== undefined;
  const hasEnd = options.retainedWindowEnd !== undefined;
  if (hasStart !== hasEnd) {
    throw new Error("retained window requires both start and end");
  }
  if (hasStart && hasEnd && options.retainedWindowStart! > options.retainedWindowEnd!) {
    throw new Error("retained window start must not exceed end");
  }

  const raw = await readFile(options.cursorFile, "utf8");
  const parsed = validateCursor(raw);
  const targetNames = options.target !== undefined ? [options.target] : Object.keys(parsed.file.targets);
  if (options.target !== undefined && !(options.target in parsed.file.targets)) {
    throw new Error(`target not found in cursor file: ${options.target}`);
  }

  const retained = hasStart && hasEnd
    ? { start: options.retainedWindowStart!, end: options.retainedWindowEnd! }
    : null;

  const entries: RecoveryPreviewEntry[] = targetNames.map((target) => {
    const state = parsed.file.targets[target] as { ledger?: number } | undefined;
    const currentLedger = typeof state?.ledger === "number" ? state.ledger : null;
    const warnings: string[] = [];

    if (currentLedger !== null && options.proposedLedger > currentLedger) {
      warnings.push("proposed ledger is ahead of the current position; no rewind would occur");
    }

    let missedLedgerRange: { from: number; to: number } | null = null;
    if (currentLedger !== null && options.proposedLedger < currentLedger) {
      missedLedgerRange = { from: options.proposedLedger + 1, to: currentLedger };
    }

    let withinRetainedWindow: boolean | null = null;
    if (retained) {
      withinRetainedWindow = options.proposedLedger >= retained.start && options.proposedLedger <= retained.end;
      if (!withinRetainedWindow) {
        warnings.push("proposed ledger is outside the retained window; events may be unrecoverable");
      }
      if (missedLedgerRange && missedLedgerRange.from < retained.start) {
        warnings.push("part of the missed range predates the retained window");
      }
    } else {
      warnings.push("no retained-window evidence supplied; availability is unverified");
    }

    return {
      target,
      currentLedger,
      proposedLedger: options.proposedLedger,
      missedLedgerRange,
      retainedWindow: retained,
      withinRetainedWindow,
      warnings,
    };
  });

  return { schemaVersion: parsed.file.version, entries };
}

function formatRecoveryPreview(preview: RecoveryPreview): string {
  const lines = [`[cursor] recovery preview schema=v${preview.schemaVersion} targets=${preview.entries.length}`];
  for (const entry of preview.entries) {
    const current = entry.currentLedger === null ? "unknown" : String(entry.currentLedger);
    const range = entry.missedLedgerRange
      ? `${entry.missedLedgerRange.from}..${entry.missedLedgerRange.to}`
      : "none";
    const window = entry.retainedWindow
      ? `${entry.retainedWindow.start}..${entry.retainedWindow.end}`
      : "unknown";
    const retained = entry.withinRetainedWindow === null ? "unknown" : String(entry.withinRetainedWindow);
    lines.push(
      `  target=${entry.target} old=${current} proposed=${entry.proposedLedger} ` +
        `missed=${range} retainedWindow=${window} proposedRetained=${retained}`,
    );
    for (const warning of entry.warnings) {
      lines.push(`    warning: ${warning}`);
    }
  }
  lines.push("[cursor] preview is read-only; no cursor or chain state was modified");
  return lines.join("\n");
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  target?: string;
  to?: string;
  retainedStart?: string;
  retainedEnd?: string;
  force: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false };
  const seen = new Set<string>();
  const valued = new Set(["--file", "--out", "--from", "--target", "--to", "--retained-start", "--retained-end"]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      if (seen.has(arg)) throw new Error("duplicate --force option");
      seen.add(arg);
      options.force = true;
      continue;
    }
    if (!valued.has(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    (options as unknown as Record<string, string>)[key] = value;
    index += 1;
  }

  return options;
}

function parseLedger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is out of range`);
  return parsed;
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

function assertDifferentPaths(left: string, right: string): void {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(left) === normalize(right)) {
    throw new Error("backup and live cursor paths must be different");
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "preview") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|preview> [--file PATH] [--out PATH|--from PATH] " +
        "[--target NAME --to LEDGER --retained-start LEDGER --retained-end LEDGER] [--force]",
    );
  }

  const options = parseOptions(args);
  const cursorFile = resolvePath(options.file ?? process.env.CURSOR_FILE ?? "./data/cursor.json");
  if (action === "preview") {
    if (options.to === undefined) throw new Error("preview requires --to LEDGER");
    const retainedStart = options.retainedStart === undefined ? undefined : parseLedger(options.retainedStart, "--retained-start");
    const retainedEnd = options.retainedEnd === undefined ? undefined : parseLedger(options.retainedEnd, "--retained-end");
    const preview = await previewRecovery({
      cursorFile,
      target: options.target,
      proposedLedger: parseLedger(options.to, "--to"),
      retainedWindowStart: retainedStart,
      retainedWindowEnd: retainedEnd,
    });
    console.log(formatRecoveryPreview(preview));
    return;
  }

  if (action === "backup") {
    const backupFile = resolvePath(
      options.out ?? `${cursorFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
    );
    assertDifferentPaths(cursorFile, backupFile);
    await backupCursor({ cursorFile, backupFile, force: options.force });
    return;
  }

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "cursor command failed";
    console.error(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
