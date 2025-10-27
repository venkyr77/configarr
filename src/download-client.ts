import { getUnifiedClient } from "./clients/unified-client";
import { logger } from "./logger";
import type { MergedDownloadClientResource } from "./__generated__/mergedTypes";

type Field = { name: string; value?: unknown };

export type DownloadClientInput = {
  name: string;
  implementation: string; // e.g. "Sabnzbd"
  implementationName?: string;
  configContract?: string;
  protocol: "torrent" | "usenet";
  enable: boolean;
  priority?: number;
  removeCompletedDownloads?: boolean;
  removeFailedDownloads?: boolean;
  infoLink?: string;
  tags?: number[] | string[];
  fields?: Field[];
};

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

const isSameClient = (server: MergedDownloadClientResource, entry: DownloadClientInput): boolean => {
  const keys: (keyof DownloadClientInput)[] = [
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
    if ((server as any)[k] !== (entry as any)[k]) return false;
  }
  if (!sameTags(server.tags as any, entry.tags as any)) return false;
  return areFieldsEqual(server.fields as any, entry.fields as any);
};

export type DownloadClientsDiff = {
  missingOnServer: DownloadClientInput[];
  notAvailableAnymore: MergedDownloadClientResource[];
  changed: { id: string; payload: MergedDownloadClientResource }[];
} | null;

export const calculateDownloadClientsDiff = async (configEntries: DownloadClientInput[]): Promise<DownloadClientsDiff> => {
  const api = getUnifiedClient();
  const serverList: MergedDownloadClientResource[] = await api.getDownloadClients();

  const configMap = new Map(configEntries.map((e) => [keyOf(e), e]));
  const serverMap = new Map(serverList.map((s) => [keyOf(s), s]));

  const missingOnServer: DownloadClientInput[] = [];
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
