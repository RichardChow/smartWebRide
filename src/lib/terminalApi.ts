import type { AuthUser, SlaveSession } from '../types';

function defaultApiBase(): string {
  return `${window.location.protocol}//${window.location.hostname}:8008/api`;
}

const API_BASE = (import.meta.env.VITE_SWR_API_BASE as string | undefined) || defaultApiBase();

function wsBase(): string {
  const configured = import.meta.env.VITE_SWR_WS_BASE as string | undefined;
  if (configured) return configured;
  const apiUrl = new URL(API_BASE, window.location.href);
  apiUrl.protocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return apiUrl.toString().replace(/\/$/, '');
}

export interface TerminalSessionResponse {
  id: string;
  slaveId: string;
  shell: string;
  readOnly: boolean;
}

export interface CreateTerminalSessionOptions {
  cwd?: string;
  mode?: 'reuse' | 'new';
}

export interface SftpFileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modified: number;
  path: string;
}

export interface SftpListResponse {
  files: SftpFileEntry[];
  cwd: string;
}

export interface RemoteFileReadResponse {
  content: string;
  size: number;
  encoding: string;
}

export interface UploadResponse {
  path: string;
  size: number;
  filename: string;
}

export interface FolderUploadProgress {
  total: number;
  done: number;
  current: string;
  errors: Array<{ relativePath: string; message: string }>;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text();
      let message = detail || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(detail) as { detail?: unknown };
        if (parsed.detail) message = String(parsed.detail);
      } catch {
        // Keep the raw response text.
      }
      throw new ApiError(response.status, message);
    }
    return response.json() as Promise<T>;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('smartWebRide Center request timed out.');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function login(email: string, password: string): Promise<AuthUser> {
  return fetchJson<AuthUser>(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export async function getCurrentUser(): Promise<AuthUser> {
  return fetchJson<AuthUser>(`${API_BASE}/auth/me`);
}

export async function logout(): Promise<void> {
  await fetchJson<{ ok: boolean }>(`${API_BASE}/auth/logout`, { method: 'POST' });
}

export async function listSlaves(): Promise<SlaveSession[]> {
  return fetchJson<SlaveSession[]>(`${API_BASE}/slaves`);
}

export async function lockSlave(slaveId: string, manualHoldReason: string): Promise<SlaveSession> {
  return fetchJson<SlaveSession>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/lock`, {
    method: 'POST',
    body: JSON.stringify({ manualHoldReason })
  });
}

export async function releaseSlave(slaveId: string): Promise<SlaveSession> {
  return fetchJson<SlaveSession>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/lock`, {
    method: 'DELETE'
  });
}

export async function forceTakeover(slaveId: string, reason: string): Promise<SlaveSession> {
  return fetchJson<SlaveSession>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/lock/takeover`, {
    method: 'POST',
    body: JSON.stringify({ reason })
  });
}

export async function createTerminalSession(slaveId: string, options: CreateTerminalSessionOptions = {}): Promise<TerminalSessionResponse> {
  const params = new URLSearchParams();
  if (options.mode) params.set('mode', options.mode);
  if (options.cwd) params.set('cwd', options.cwd);
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return fetchJson<TerminalSessionResponse>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/terminal/sessions${suffix}`, {
    method: 'POST'
  });
}

export function buildTerminalWsUrl(sessionId: string): string {
  return `${wsBase()}/terminal/${encodeURIComponent(sessionId)}`;
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`${API_BASE}/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function listSftpDirectory(slaveId: string, path: string): Promise<SftpListResponse> {
  return fetchJson<SftpListResponse>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/files?path=${encodeURIComponent(path)}`);
}

export async function readRemoteFile(slaveId: string, path: string): Promise<RemoteFileReadResponse> {
  return fetchJson<RemoteFileReadResponse>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/files/read?path=${encodeURIComponent(path)}`);
}

export async function writeRemoteFile(slaveId: string, path: string, content: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/files/write`, {
    method: 'PUT',
    body: JSON.stringify({ path, content, encoding: 'utf-8' })
  });
}

export async function writeRemoteFileBase64(slaveId: string, path: string, content: string): Promise<UploadResponse> {
  const result = await fetchJson<{ ok: boolean; size: number }>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/files/write`, {
    method: 'PUT',
    body: JSON.stringify({ path, content, encoding: 'base64' })
  });
  return { path, size: result.size, filename: path.split(/[\\/]/).pop() || path };
}

export async function makeRemoteDirectory(slaveId: string, path: string, parents = false): Promise<void> {
  await fetchJson<{ ok: boolean }>(`${API_BASE}/slaves/${encodeURIComponent(slaveId)}/files/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ path, parents })
  });
}
