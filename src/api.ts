import { requestUrl } from "obsidian";

/** Thin client for the AudioPen (Xano) endpoints this plugin uses:
 *  - the OTP login endpoints (email → one-time code → token)
 *  - `mcp/me` to check the plan at connect time
 *  - `mcp/library` for the user's folder list
 *  - the read-only `sync/changes` feed
 * Nothing here can write to AudioPen data.
 */

const XANO_HOST = "https://xcmm-5zfz-tplj.n7c.xano.io";
const AUTH_BASE = `${XANO_HOST}/api:x4ocgg3f`;
const MCP_BASE = `${XANO_HOST}/api:mcp`;
const SYNC_BASE = `${XANO_HOST}/api:sync`;

export class AuthExpiredError extends Error {
  constructor() {
    super("Your AudioPen login has expired. Reconnect in the AudioPen plugin settings.");
  }
}

export class PrimeRequiredError extends Error {
  constructor() {
    super("Syncing to Obsidian is an AudioPen Prime feature. Upgrade at audiopen.ai to use it.");
  }
}

export type Me = { email: string; p_account_type: string };

export type SyncTag = { id: number; tag_name: string };

export type SyncNote = {
  id: number;
  created_at: number;
  modified_at: number | null;
  title: string | null;
  body: string | null;
  original_transcript: string | null;
  folder_id: number | null;
  pinned: boolean | null;
  note_tag_association: { tag: SyncTag | null }[] | null;
  folders_note_mapping: { id: number; name: string; Universal: boolean | null } | null;
};

export type Library = {
  folders: { id: number; name: string; Universal: boolean | null }[];
};

export type ChangesPage = {
  notes: SyncNote[];
  deleted_note_ids: number[];
  until: number;
  next_after_id: number;
  has_more: boolean;
};

export type ChangesQuery = {
  since: number | null;
  until: number | null;
  afterId: number;
  perPage: number;
};

export class AudioPenApi {
  async requestCode(email: string): Promise<void> {
    await this.call("POST", `${AUTH_BASE}/auth/magic-otp-post`, null, { email });
  }

  async verifyCode(email: string, otp: string): Promise<string> {
    const data = await this.call<Record<string, unknown>>(
      "POST",
      `${AUTH_BASE}/auth/magic-login_otp`,
      null,
      { email, otp },
    );
    const user = (data.user as Record<string, unknown> | undefined) ?? {};
    const token =
      firstString(data, ["authToken", "auth_token", "token", "access_token", "jwt"]) ??
      firstString(user, ["authToken", "auth_token", "token"]);
    if (!token) throw new Error("Login succeeded but AudioPen returned no token.");
    return token;
  }

  me(token: string): Promise<Me> {
    return this.call<Me>("GET", `${MCP_BASE}/me`, token);
  }

  library(token: string): Promise<Library> {
    return this.call<Library>("GET", `${MCP_BASE}/library`, token);
  }

  changes(token: string, query: ChangesQuery): Promise<ChangesPage> {
    const url = new URL(`${SYNC_BASE}/changes`);
    if (query.since !== null) url.searchParams.set("since", String(query.since));
    if (query.until !== null) url.searchParams.set("until", String(query.until));
    url.searchParams.set("after_id", String(query.afterId));
    url.searchParams.set("per_page", String(query.perPage));
    return this.call<ChangesPage>("GET", url.toString(), token);
  }

  private async call<T>(
    method: "GET" | "POST",
    url: string,
    token: string | null,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await requestUrl({
        url,
        method,
        headers,
        contentType: body ? "application/json" : undefined,
        body: body ? JSON.stringify(body) : undefined,
        throw: false,
      });
    } catch {
      throw new Error("Could not reach AudioPen. Check your internet connection.");
    }

    const data = parseJson(res.text);
    const message = typeof data?.message === "string" ? data.message : null;

    if (token && (res.status === 401 || res.status === 403)) {
      if (message?.includes("Prime subscription required")) throw new PrimeRequiredError();
      throw new AuthExpiredError();
    }
    if (res.status >= 400) {
      if (message?.includes("Prime subscription required")) throw new PrimeRequiredError();
      throw new Error(message ?? `AudioPen returned an error (HTTP ${res.status}).`);
    }
    return data as T;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
