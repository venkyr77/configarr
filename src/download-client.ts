// Paste your current code here, and I’ll edit it inline to switch back to strict/exact matching
import { getUnifiedClient } from "./clients/unified-client";
import { logger } from "./logger";
import { InputConfigDownloadClient } from "./types/config.types.ts";
import type { MergedDownloadClientResource } from "./__generated__/mergedTypes";

type Field = { name: string; value?: unknown };

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
      logger.debug(`DownloadClient STRICT mismatch key='${String(k)}' server=${JSON.stringify(sv)} entry=${JSON.stringify(ev)}`);
      return false;
    }
  }

  // Strict tags compare (order-insensitive, type-sensitive as per original strict logic)
  const serverTags = Array.isArray(server.tags) ? server.tags : [];
  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  const tagsMatch = serverTags.length === entryTags.length && [...serverTags].sort().join(",") === [...entryTags].sort().join(",");
  if (!tagsMatch) {
    logger.debug(`DownloadClient STRICT mismatch tags server=${JSON.stringify(serverTags)} entry=${JSON.stringify(entryTags)}`);
    return false;
  }

  // Strict fields compare (exact set + values). If mismatch, log precise diffs.
  const fieldsEqual = areFieldsEqual(server.fields as any, entry.fields as any);
  if (!fieldsEqual) {
    const sm = new Map((server.fields ?? []).map((f: any) => [f.name, f.value]));
    const em = new Map((entry.fields ?? []).map((f: any) => [f.name, f.value]));

    if (sm.size !== em.size) {
      logger.debug(
        `DownloadClient STRICT mismatch fields count server=${sm.size} entry=${em.size} (serverNames=${JSON.stringify(
          Array.from(sm.keys()),
        )}, entryNames=${JSON.stringify(Array.from(em.keys()))})`,
      );
      return false;
    }

    for (const [name, sv] of sm.entries()) {
      if (!em.has(name)) {
        logger.debug(`DownloadClient STRICT missing field in entry: '${name}'`);
        return false;
      }
      const ev = em.get(name);
      if (JSON.stringify(sv) !== JSON.stringify(ev)) {
        logger.debug(`DownloadClient STRICT mismatch field '${name}' server=${JSON.stringify(sv)} entry=${JSON.stringify(ev)}`);
        return false;
      }
    }

    for (const [name] of em.entries()) {
      if (!sm.has(name)) {
        logger.debug(`DownloadClient STRICT extra field in entry: '${name}'`);
        return false;
      }
    }
  }

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
    logger.debug("Download clients are in sync.");
    return null;
  }

  return { missingOnServer, notAvailableAnymore, changed };
};
