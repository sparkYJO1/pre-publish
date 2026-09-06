import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CHANNELS, isChannel } from "./types.js";
import type {
  Config,
  ControlSpec,
  SuppressionSpec,
  TermSpec,
} from "./types.js";

export class ConfigError extends Error {}

/**
 * The terms file lists the exact strings you are trying to keep out of public
 * view. Committing it into the repository being published would publish them.
 * Keep it outside the repo, or pass --allow-terms-in-repo and accept that.
 */
export function assertTermsFileOutsideRepo(
  configPath: string,
  repoRoot: string,
): void {
  const rel = relative(resolve(repoRoot), resolve(configPath));
  const inside =
    rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside) {
    throw new ConfigError(
      `terms file ${configPath} is inside the repository being scanned.\n` +
        `It contains the strings you are trying not to publish. Move it outside the repo, ` +
        `or pass --allow-terms-in-repo if the terms are genuinely not sensitive.`,
    );
  }
}

function asArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array`);
  return value;
}

function parseTerm(raw: unknown, index: number): TermSpec {
  if (typeof raw === "string") {
    if (raw.length === 0)
      throw new ConfigError(`terms[${index}] is an empty string`);
    return { id: raw, value: raw };
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`terms[${index}] must be a string or an object`);
  }
  const term = raw as Record<string, unknown>;
  const value = term["value"];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`terms[${index}].value must be a non-empty string`);
  }
  const id = typeof term["id"] === "string" && term["id"] ? term["id"] : value;
  const wholeWord = term["wholeWord"];
  if (
    wholeWord !== undefined &&
    !["auto", "always", "never"].includes(String(wholeWord))
  ) {
    throw new ConfigError(
      `terms[${index}].wholeWord must be auto, always or never`,
    );
  }
  const channels = asArray(term["channels"], `terms[${index}].channels`);
  for (const channel of channels) {
    if (!isChannel(channel)) {
      throw new ConfigError(
        `terms[${index}].channels contains "${String(channel)}"; valid channels are ${CHANNELS.join(", ")}`,
      );
    }
  }
  return {
    id,
    value,
    ...(wholeWord ? { wholeWord: wholeWord as TermSpec["wholeWord"] } : {}),
    ...(term["caseSensitive"] !== undefined
      ? { caseSensitive: Boolean(term["caseSensitive"]) }
      : {}),
    ...(channels.length > 0
      ? { channels: channels as TermSpec["channels"] }
      : {}),
    ...(typeof term["note"] === "string" ? { note: term["note"] } : {}),
  };
}

function parseSuppression(raw: unknown, index: number): SuppressionSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`suppress[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const termId = entry["termId"];
  const reason = entry["reason"];
  if (typeof termId !== "string" || !termId) {
    throw new ConfigError(`suppress[${index}].termId is required`);
  }
  // A suppression without a reason is an unexplained hole in the audit.
  if (typeof reason !== "string" || !reason) {
    throw new ConfigError(
      `suppress[${index}].reason is required; say why this is not a leak`,
    );
  }
  if (entry["value"] !== undefined || entry["term"] !== undefined) {
    throw new ConfigError(
      `suppress[${index}] must reference a term by id, never by value; a suppression file that repeats the sensitive string is itself a leak`,
    );
  }
  const channel = entry["channel"];
  if (channel !== undefined && !isChannel(channel)) {
    throw new ConfigError(`suppress[${index}].channel is not a valid channel`);
  }
  return {
    termId,
    reason,
    ...(channel ? { channel } : {}),
    ...(typeof entry["path"] === "string" ? { path: entry["path"] } : {}),
    ...(typeof entry["pathPrefix"] === "string"
      ? { pathPrefix: entry["pathPrefix"] }
      : {}),
  };
}

function parseControl(raw: unknown, index: number): ControlSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`controls[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const value = entry["value"];
  const channel = entry["channel"];
  if (typeof value !== "string" || !value) {
    throw new ConfigError(
      `controls[${index}].value must be a non-empty string`,
    );
  }
  if (!isChannel(channel)) {
    throw new ConfigError(
      `controls[${index}].channel must be one of ${CHANNELS.join(", ")}`,
    );
  }
  return {
    value,
    channel,
    ...(typeof entry["note"] === "string" ? { note: entry["note"] } : {}),
  };
}

export function parseConfig(json: unknown): Config {
  if (typeof json !== "object" || json === null) {
    throw new ConfigError("config must be a JSON object");
  }
  const raw = json as Record<string, unknown>;
  const terms = asArray(raw["terms"], "terms").map(parseTerm);
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term.id))
      throw new ConfigError(`duplicate term id "${term.id}"`);
    seen.add(term.id);
  }
  return {
    terms,
    suppress: asArray(raw["suppress"], "suppress").map(parseSuppression),
    controls: asArray(raw["controls"], "controls").map(parseControl),
    secrets: raw["secrets"] === undefined ? true : Boolean(raw["secrets"]),
    ...(typeof raw["maxBlobBytes"] === "number"
      ? { maxBlobBytes: raw["maxBlobBytes"] }
      : {}),
  };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read terms file ${path}: ${(error as Error).message}`,
    );
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

export const EMPTY_CONFIG: Config = {
  terms: [],
  suppress: [],
  controls: [],
  secrets: true,
};
