import { getUnifiedClient } from "./clients/unified-client";
import { logger } from "./logger";
import { InputConfigDownloadClient } from "./types/config.types.ts";
import type { MergedDownloadClientResource } from "./__generated__/mergedTypes";

type Field = { name: string; value?: unknown };

// Fields we should not compare because servers mask them (e.g., "********")
const SENSITIVE_FIELD_NAMES = new Set<string>(["apiKey", "password", "api_key"]);
const stripSecrets = (arr?: { name: string; value?: unknown }[] | null) => (arr ?? []).filter((f) => !SENSITIVE_FIELD_NAMES.has(f.name));

const keyOf = (c: { name?: string; implementation?: string }) => `${c.name ?? ""}::${c.implementation ?? ""}`;

const toFieldMap = (fields: Field[] | undefined | null): Map<string, unknown> => new Map((fields ?? []).map((f) => [f.name, f.value]));

const areFieldsEqual = (a?: Field[] | null, b?: Field[] | null): boolean => {
  const am = toFieldMap(a);
  const bm = toFieldMap(b);
  if (am.size !== bm.size) return false;
  for (const [k, v] of am.entries()) {
    if (!bm.has(k)) return false;
    if (JSON.stringify(bm.get(k)) !== JSON.stringify(v)) return false;
  }
  return true;
};

const sameTags = (serverTags: unknown, entryTags: unknown) => {
  const s = Array.isArray(serverTags) ? serverTags : [];
  const e = Array.isArray(entryTags) ? entryTags : [];
  return s.length === e.length && [...s].sort().join(",") === [...e].sort().join(",");
};

const isSameClient = (server: MergedDownloadClientResource, entry: InputConfigDownloadClient): boolean => {
  // Strict compare of core props: undefined vs value counts as a mismatch
  const keys: (keyof InputConfigDownloadClient)[] = [
    "configContract",
    "enable",
    "implementation",
    "implementationName",
    "infoLink",
    "name",
    "priority",
    "protocol",
    "removeCompletedDownloads",
    "removeFailedDownloads",
  ];

  for (const k of keys) {
    const sv = (server as any)[k] ?? null;
    const ev = (entry as any)[k] ?? null;
    if (sv !== ev) {
      logger.info(`DownloadClient mismatch key='${String(k)}' server=${JSON.stringify(sv)} entry=${JSON.stringify(ev)}`);
      return false;
    }
  }

  // Tags compare (order-insensitive)
  const serverTags = Array.isArray(server.tags) ? server.tags : [];
  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  const tagsMatch = serverTags.length === entryTags.length && [...serverTags].sort().join(",") === [...entryTags].sort().join(",");
  if (!tagsMatch) {
    logger.info(`DownloadClient mismatch tags server=${JSON.stringify(serverTags)} entry=${JSON.stringify(entryTags)}`);
    return false;
  }

  // Fields compare (exact set + values) but ignoring secrets (server masks them)
  {
    const serverNoSecrets = stripSecrets(server.fields as any);
    const entryNoSecrets = stripSecrets(entry.fields as any);

    const sm = new Map((serverNoSecrets ?? []).map((f: any) => [f.name, f.value]));
    const em = new Map((entryNoSecrets ?? []).map((f: any) => [f.name, f.value]));

    if (sm.size !== em.size) {
      logger.info(
        `DownloadClient mismatch fields count server=${sm.size} entry=${em.size} (serverNames=${JSON.stringify(
          Array.from(sm.keys()),
        )}, entryNames=${JSON.stringify(Array.from(em.keys()))})`,
      );
      return false;
    }

    for (const [name, sv] of sm.entries()) {
      if (!em.has(name)) {
        logger.info(`DownloadClient missing field in entry: '${name}'`);
        return false;
      }
      const ev = em.get(name);
      if (JSON.stringify(sv) !== JSON.stringify(ev)) {
        logger.info(`DownloadClient mismatch field '${name}' server=${JSON.stringify(sv)} entry=${JSON.stringify(ev)}`);
        return false;
      }
    }

    for (const [name] of em.entries()) {
      if (!sm.has(name)) {
        logger.info(`DownloadClient extra field in entry: '${name}'`);
        return false;
      }
    }
  }

  logger.info(`DownloadClient '${entry.name}' matches server config — no update needed.`);

  return true;
};

export type DownloadClientsDiff = {
  missingOnServer: InputConfigDownloadClient[];
  notAvailableAnymore: MergedDownloadClientResource[];
  changed: { id: string; payload: MergedDownloadClientResource }[];
} | null;

export const calculateDownloadClientsDiff = async (configEntries: InputConfigDownloadClient[]): Promise<DownloadClientsDiff> => {
  const api = getUnifiedClient();
  const serverList: MergedDownloadClientResource[] = await api.getDownloadClients();

  const configMap = new Map(configEntries.map((e) => [keyOf(e), e]));
  const serverMap = new Map(serverList.map((s) => [keyOf(s), s]));

  const missingOnServer: InputConfigDownloadClient[] = [];
  for (const [k, entry] of configMap.entries()) {
    if (!serverMap.has(k)) missingOnServer.push(entry);
  }

  const notAvailableAnymore: MergedDownloadClientResource[] = [];
  for (const [k, srv] of serverMap.entries()) {
    if (!configMap.has(k)) notAvailableAnymore.push(srv);
  }

  const changed: { id: string; payload: MergedDownloadClientResource }[] = [];
  for (const [k, srv] of serverMap.entries()) {
    const entry = configMap.get(k);
    if (!entry) continue;
    if (!isSameClient(srv, entry)) {
      changed.push({ id: String(srv.id), payload: { ...srv, ...entry } as any });
    }
  }

  if (missingOnServer.length === 0 && notAvailableAnymore.length === 0 && changed.length === 0) {
    logger.info("Download clients are in sync.");
    return null;
  }

  return { missingOnServer, notAvailableAnymore, changed };
};
