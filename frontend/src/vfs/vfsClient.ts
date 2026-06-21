/**
 * vfsClient — Virtual File System (VFS) connection layer.
 *
 * Step 1 of the VFS integration: it knows *where* the server is and *who* this
 * client is, persists that across reloads, and can probe the server to confirm
 * the two are valid before any real file work is attempted.
 *
 * Every VFS request is scoped by an application id (`?app=<id>`) and selects a
 * project by config key (`?config=<key>`, default `config`). Real OS paths
 * never cross the wire — clients only ever traffic in
 * `{ application_id, config_key, root_id, file_path }`. See the vfs-integration
 * skill for the full contract.
 *
 * NOTE: the connection probe targets the public surface `GET /api/vfs/roots`,
 * the lightest documented read that exercises both server reachability and
 * application-id validity. Project/root creation (the admin surface) is out of
 * scope for this step.
 */

/** This app's identity on the VFS server (see project_context.md appId). */
export const DEFAULT_APPLICATION_ID = 'parametric3dstudio-v-0-1';

/** Persisted connection settings. */
export interface VfsConnectionConfig {
  /** Base URL of the VFS server, e.g. "http://localhost:5000" (no trailing slash). */
  serverUrl: string;
  /** Application id this client registers as. */
  applicationId: string;
}

const STORAGE_KEY = 'parametric3dstudio.vfs.connection';

const EMPTY_CONFIG: VfsConnectionConfig = {
  serverUrl: '',
  applicationId: DEFAULT_APPLICATION_ID,
};

/** Strip a single trailing slash so we can append paths cleanly. */
function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Load the saved connection config (falls back to defaults if none / unparseable). */
export function loadVfsConfig(): VfsConnectionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_CONFIG };
    const parsed = JSON.parse(raw) as Partial<VfsConnectionConfig>;
    return {
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
      applicationId:
        typeof parsed.applicationId === 'string' && parsed.applicationId.trim()
          ? parsed.applicationId
          : DEFAULT_APPLICATION_ID,
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/** Persist the connection config so it survives reloads. */
export function saveVfsConfig(config: VfsConnectionConfig): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        serverUrl: normalizeServerUrl(config.serverUrl),
        applicationId: config.applicationId.trim() || DEFAULT_APPLICATION_ID,
      }),
    );
  } catch {
    /* storage unavailable — connection still works for the session */
  }
}

/** Outcome of a connection probe. */
export interface ConnectionResult {
  ok: boolean;
  /** Human-readable message suitable for showing in the dialog. */
  message: string;
  /** VFS error code from the `{ error, code }` envelope, when the server replied. */
  code?: string;
  /** The application's human-readable name, when the registry lookup succeeded. */
  applicationName?: string;
}

/** App-id error codes that mean "server is up, but it doesn't know this app". */
const APP_ID_ERROR_CODES = new Set(['APPLICATION_REQUIRED', 'APPLICATION_NOT_FOUND']);

/**
 * Fetch the application's human-readable name from the admin registry route.
 *
 *   GET /api/admin/applications/<id> → { application: { id, name, … } }
 *
 * This route needs no app-id scoping and no create permission (it's a plain
 * read). Returns null on any failure so callers can fall back to the id.
 */
export async function fetchApplicationName(
  base: string,
  appId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let url: string;
  try {
    url = new URL(`/api/admin/applications/${encodeURIComponent(appId)}`, base).toString();
  } catch {
    return null;
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { application?: { name?: string } };
    const name = body.application?.name;
    return typeof name === 'string' && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/**
 * Probe the VFS server with the given connection settings.
 *
 * Outcomes:
 *   • can't reach the server          → ok:false ("Could not reach …")
 *   • server up, app id not accepted  → ok:false ("application id … not recognised")
 *   • server up, app id accepted      → ok:true  (200, or any non-app-id VFS reply
 *                                                  such as a missing config —
 *                                                  the server + app are valid)
 */
export async function checkConnection(
  config: VfsConnectionConfig,
  signal?: AbortSignal,
): Promise<ConnectionResult> {
  const base = normalizeServerUrl(config.serverUrl);
  const appId = config.applicationId.trim();

  if (!base) return { ok: false, message: 'Enter a server address first.' };
  if (!appId) return { ok: false, message: 'Enter an application id first.' };

  let url: string;
  try {
    url = new URL(`/api/vfs/roots?app=${encodeURIComponent(appId)}`, base).toString();
  } catch {
    return { ok: false, message: `"${config.serverUrl}" is not a valid server address.` };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Application-Id': appId },
      signal,
    });
  } catch {
    return { ok: false, message: `Could not reach the server at ${base}.` };
  }

  if (res.ok) {
    const name = await fetchApplicationName(base, appId, signal);
    return {
      ok: true,
      code: 'OK',
      applicationName: name ?? undefined,
      message: `Connected to ${base} as "${name ?? appId}".`,
    };
  }

  // Server responded with an error envelope { error, code }. Decide whether it's
  // an app-id problem (real failure for this probe) or some downstream issue
  // (config/root not set up yet) that still proves the connection is good.
  let code: string | undefined;
  let errMsg: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    code = body.code;
    errMsg = body.error;
  } catch {
    /* non-JSON error body */
  }

  if (code && APP_ID_ERROR_CODES.has(code)) {
    return {
      ok: false,
      code,
      message: `Server reached, but application id "${appId}" was not recognised.`,
    };
  }

  if (code) {
    // Reached the server and the app id was accepted; the error is about
    // something not yet configured (e.g. a missing project/config or root).
    const name = await fetchApplicationName(base, appId, signal);
    return {
      ok: true,
      code,
      applicationName: name ?? undefined,
      message: `Connected to ${base} as "${name ?? appId}" (server reported: ${errMsg ?? code}).`,
    };
  }

  return {
    ok: false,
    message: `Server returned HTTP ${res.status} ${res.statusText || ''}`.trim() + '.',
  };
}
