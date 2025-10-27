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
  const keys: (keyof InputConfigDownloadClient)[] = [
    "enable",
    "protocol",
    "priority",
    "removeCompletedDownloads",
    "removeFailedDownloads",
    "name",
    "implementationName",
    "implementation",
    "configContract",
    "infoLink",
  ];
  for (const k of keys) {
    // treat undefined in config as "don't care"
    if (entry[k] !== undefined && (server as any)[k] !== (entry as any)[k]) return false;
  }
  if (entry.tags !== undefined && !sameTags(server.tags as any, entry.tags as any)) return false;
  if (entry.fields !== undefined && !areFieldsEqual(server.fields as any, entry.fields as any)) return false;
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

  logger.debug(`download_clients_config_map:${JSON.stringify(configMap)}`);
  logger.debug(`download_clients_config_map:${JSON.stringify(serverMap)}`);

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
