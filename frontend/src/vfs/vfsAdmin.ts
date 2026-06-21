/**
 * vfsAdmin — admin surface (`/api/admin/*`) helpers for managing a project's
 * VFS configuration (the "topic") and its roots (mounted folders).
 *
 * A project's stable `projectId` (UUID) is used as the VFS **config key**. The
 * project name becomes the config's display name. Roots are the real folders
 * mounted into that config.
 *
 * These routes return real OS paths and create operations are gated by the
 * application's `can_create_projects` / `can_create_roots` flags — a
 * `PERMISSION_DENIED` error means the app may only consume, not create.
 *
 * All calls read the saved connection (server URL + application id) from
 * vfsClient, so the connection dialog must have been completed first.
 */
import { loadVfsConfig } from './vfsClient';

/** A root as returned by the admin surface (includes real_path + disabled roots). */
export interface AdminRoot {
  id: string;
  virtual_name: string;
  real_path?: string;
  enabled: boolean;
  allow_subfolders: boolean;
  allowed_file_types: string[];
  description: string;
  created_at?: string;
  updated_at?: string;
}

/** Body for creating / updating a root. */
export interface CreateRootBody {
  virtual_name: string;
  real_path: string;
  enabled?: boolean;
  allow_subfolders?: boolean;
  allowed_file_types?: string[];
  description?: string;
}

export interface PathValidation {
  valid: boolean;
  exists: boolean;
  is_directory?: boolean;
  resolved_path?: string | null;
}

/** Error carrying the server's `{ error, code }` envelope. */
export class VfsApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'VfsApiError';
    this.code = code;
    this.status = status;
  }
}

type QueryValue = string | undefined;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Attach ?app=<applicationId>. Default true. */
  appScoped?: boolean;
  signal?: AbortSignal;
}

/** Are we connected (server URL + application id present)? */
export function isVfsConfigured(): boolean {
  const c = loadVfsConfig();
  return Boolean(c.serverUrl.trim() && c.applicationId.trim());
}

async function adminFetch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, appScoped = true, signal } = opts;
  const conn = loadVfsConfig();
  const base = conn.serverUrl.trim().replace(/\/+$/, '');
  if (!base) throw new VfsApiError('No VFS server address configured.', 'NOT_CONFIGURED', 0);

  const params = new URLSearchParams();
  if (appScoped) {
    if (!conn.applicationId.trim()) {
      throw new VfsApiError('No VFS application id configured.', 'APPLICATION_REQUIRED', 400);
    }
    params.append('app', conn.applicationId.trim());
  }
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') params.append(k, v);
  }
  const qs = params.toString();

  let url: string;
  try {
    url = new URL(`${path}${qs ? `?${qs}` : ''}`, base).toString();
  } catch {
    throw new VfsApiError(`Invalid server address "${base}".`, 'NOT_CONFIGURED', 0);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // browser sets the multipart boundary; do not set Content-Type
  } else if (body instanceof Blob) {
    payload = body; // raw bytes (file writes); fetch sets Content-Type from the Blob
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal });
  } catch {
    throw new VfsApiError(`Could not reach the server at ${base}.`, 'NETWORK_ERROR', 0);
  }

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; code?: string };
    throw new VfsApiError(obj.error ?? res.statusText, obj.code ?? 'UNKNOWN', res.status);
  }
  return data as T;
}

/**
 * List the roots configured for this project (config key = projectId).
 * Returns an empty array when no config/topic exists yet for the project.
 */
export async function listProjectRoots(projectId: string, signal?: AbortSignal): Promise<AdminRoot[]> {
  try {
    const r = await adminFetch<{ roots: AdminRoot[] }>('/api/admin/roots', {
      query: { config: projectId },
      signal,
    });
    return r.roots ?? [];
  } catch (e) {
    // No topic set up for this project yet → treat as an empty list.
    if (e instanceof VfsApiError && e.code === 'CONFIG_NOT_FOUND') return [];
    throw e;
  }
}

/** Create the VFS config ("topic") for this project, keyed by its id. */
export function createProjectConfig(
  projectId: string,
  name: string,
  description = '',
  signal?: AbortSignal,
): Promise<unknown> {
  return adminFetch('/api/admin/vfs-configs', {
    method: 'POST',
    body: { key: projectId, name, description },
    signal,
  });
}

/** Create a root inside this project's config. */
export function createProjectRoot(
  projectId: string,
  body: CreateRootBody,
  signal?: AbortSignal,
): Promise<AdminRoot> {
  return adminFetch<AdminRoot>('/api/admin/roots', {
    method: 'POST',
    body,
    query: { config: projectId },
    signal,
  });
}

/**
 * Add a root to a project, creating the project's VFS config ("topic") first if
 * it doesn't exist yet — using the project name + id as requested.
 */
export async function addRootEnsuringConfig(
  projectId: string,
  projectName: string,
  description: string,
  body: CreateRootBody,
  signal?: AbortSignal,
): Promise<AdminRoot> {
  try {
    return await createProjectRoot(projectId, body, signal);
  } catch (e) {
    if (e instanceof VfsApiError && e.code === 'CONFIG_NOT_FOUND') {
      await createProjectConfig(projectId, projectName, description, signal);
      return createProjectRoot(projectId, body, signal);
    }
    throw e;
  }
}

/** Validate a real (server-side) path. Debounce calls — this hits the disk. */
export function validatePath(path: string, signal?: AbortSignal): Promise<PathValidation> {
  return adminFetch<PathValidation>('/api/admin/validate-path', {
    query: { path },
    appScoped: false,
    signal,
  });
}

/** Encode a forward-slashed VFS path, preserving the separators. */
function encodeVfsPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Write a text file into a VFS root via the public write endpoint:
 *   POST /api/vfs/write/<root_id>/<file_path>?config=<config>&overwrite=<bool>
 * Body is the raw file bytes. Requires effective write permission (else
 * WRITE_DENIED); a name collision without overwrite gives FILE_EXISTS (409).
 */
export function writeProjectFile(
  config: string,
  rootId: string,
  filePath: string,
  content: string,
  opts: { overwrite?: boolean; mimeType?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const { overwrite = false, mimeType = 'application/json', signal } = opts;
  const blob = new Blob([content], { type: mimeType });
  return adminFetch(`/api/vfs/write/${encodeURIComponent(rootId)}/${encodeVfsPath(filePath)}`, {
    method: 'POST',
    body: blob,
    query: { config, overwrite: String(overwrite) },
    signal,
  });
}
