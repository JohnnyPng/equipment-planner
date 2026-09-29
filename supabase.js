const settings = window.SUPABASE_CONFIG || {};
export const SUPABASE_URL = String(settings.url || '').replace(/\/+$/, '');
export const SUPABASE_KEY = String(settings.anonKey || settings.publishableKey || '');
export const isConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) && !!SUPABASE_KEY;

export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

export async function apiRequest(path, {method = 'GET', body, token, headers = {}, raw = false} = {}) {
  if (!isConfigured) throw new ApiError('尚未設定 Supabase Project URL 與 publishable key');
  const requestHeaders = {'apikey': SUPABASE_KEY, ...headers};
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
    requestHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch(`${SUPABASE_URL}${path}`, {method, headers: requestHeaders, body}); }
  catch (error) { throw new ApiError('無法連線到 Supabase，資料已留在此裝置', 0, 'network'); }
  if (!response.ok) {
    let detail = {};
    try { detail = await response.json(); } catch { /* Some storage errors are text. */ }
    throw new ApiError(detail.msg || detail.message || detail.error_description || detail.error || `Supabase 錯誤 (${response.status})`, response.status, detail.code || '');
  }
  if (raw) return response;
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export const assetPathUrl = (path) => path.split('/').map(encodeURIComponent).join('/');
