/**
 * vfsApi — public surface (`/api/vfs/*`) helpers: read-only browsing and file
 * reading. Never sees real OS paths. Used by the VFS open/browse dialog.
 *
 * Every call is scoped by the connected application id (?app=) and selects a
 * project by config key (?config=). For this app the config key is the
 * project's id (UUID).
 */
import { loadVfsConfig } from './vfsClient';
import { VfsApiError } from './vfsAdmin';

export interface PublicRoot {
  id: string;
  virtual_name: string;
  allow_subfolders: boolean;
  allowed_file_types: string[];
  description: string;
  can_read?: boolean;   // effective read permission (project AND root)
  can_write?: boolean;  // effective write permission (project AND root)
}

export interface VfsEntryFolder { name: string; type: 'folder'; modified_at: string }
export interface VfsEntryFile {
  name: string; type: 'file'; ext: string; size_bytes: number; modified_at: string;
}
export type VfsEntry = VfsEntryFolder | VfsEntryFile;

export interface VfsBrowseResult {
  root_id: string;
  virtual_name: string;
  sub_path: string;
  allow_subfolders: boolean;
  allowed_file_types: string[];
  entries: VfsEntry[];
}

/** Encode a forward-slashed VFS path, preserving the separators. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function baseAndApp(): { base: string; appId: string } {
  const c = loadVfsConfig();
  return { base: c.serverUrl.trim().replace(/\/+$/, ''), appId: c.applicationId.trim() };
}

async function vfsGet<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const { base, appId } = baseAndApp();
  if (!base) throw new VfsApiError('No VFS server address configured.', 'NOT_CONFIGURED', 0);
  if (!appId) throw new VfsApiError('No VFS application id configured.', 'APPLICATION_REQUIRED', 400);

  const params = new URLSearchParams({ app: appId, ...query });
  let url: string;
  try { url = new URL(`${path}?${params.toString()}`, base).toString(); }
  catch { throw new VfsApiError(`Invalid server address "${base}".`, 'NOT_CONFIGURED', 0); }

  let res: Response;
  try { res = await fetch(url, { headers: { Accept: 'application/json' }, signal }); }
  catch { throw new VfsApiError(`Could not reach the server at ${base}.`, 'NETWORK_ERROR', 0); }

  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; code?: string };
    throw new VfsApiError(obj.error ?? res.statusText, obj.code ?? 'UNKNOWN', res.status);
  }
  return data as T;
}

/** List the enabled roots for the given project (config key). */
export async function listRoots(configKey: string, signal?: AbortSignal): Promise<PublicRoot[]> {
  try {
    const r = await vfsGet<{ roots: PublicRoot[] }>('/api/vfs/roots', { config: configKey }, signal);
    return r.roots ?? [];
  } catch (e) {
    if (e instanceof VfsApiError && e.code === 'CONFIG_NOT_FOUND') return [];
    throw e;
  }
}

/** List a directory inside a root. subPath is forward-slashed, no leading slash. */
export function browse(rootId: string, subPath: string, configKey: string, signal?: AbortSignal): Promise<VfsBrowseResult> {
  const path = subPath
    ? `/api/vfs/browse/${encodeURIComponent(rootId)}/${encodePath(subPath)}`
    : `/api/vfs/browse/${encodeURIComponent(rootId)}`;
  return vfsGet<VfsBrowseResult>(path, { config: configKey }, signal);
}

/** Build the raw file URL + fetch a Response (shared by text/blob readers). */
async function fetchFile(rootId: string, filePath: string, configKey: string, signal?: AbortSignal): Promise<Response> {
  const { base, appId } = baseAndApp();
  if (!base) throw new VfsApiError('No VFS server address configured.', 'NOT_CONFIGURED', 0);
  const params = new URLSearchParams({ app: appId, config: configKey });
  const url = new URL(
    `/api/vfs/file/${encodeURIComponent(rootId)}/${encodePath(filePath)}?${params.toString()}`,
    base,
  ).toString();

  let res: Response;
  try { res = await fetch(url, { signal }); }
  catch { throw new VfsApiError(`Could not reach the server at ${base}.`, 'NETWORK_ERROR', 0); }

  if (!res.ok) {
    let code = 'UNKNOWN', msg = res.statusText;
    try { const b = await res.json() as { error?: string; code?: string }; code = b.code ?? code; msg = b.error ?? msg; } catch { /* non-JSON */ }
    throw new VfsApiError(msg, code, res.status);
  }
  return res;
}

/** Fetch a file's raw text content (used to load a saved project). */
export async function fetchFileText(rootId: string, filePath: string, configKey: string, signal?: AbortSignal): Promise<string> {
  return (await fetchFile(rootId, filePath, configKey, signal)).text();
}

/** Fetch a file's raw bytes (used to import models / insert images). */
export async function fetchFileBlob(rootId: string, filePath: string, configKey: string, signal?: AbortSignal): Promise<Blob> {
  return (await fetchFile(rootId, filePath, configKey, signal)).blob();
}
