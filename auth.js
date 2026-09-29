import {apiRequest, ApiError, SUPABASE_URL} from './supabase.js';

const sessionKey = `equipment-planner-session:${SUPABASE_URL}`;
let session = null;
let refreshPromise = null;

function acceptSession(data) {
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) throw new ApiError('登入回應不完整');
  session = {accessToken:data.access_token,refreshToken:data.refresh_token,
    expiresAt:Date.now() + Number(data.expires_in || 3600) * 1000,
    user:{id:data.user.id,email:data.user.email || ''}};
  localStorage.setItem(sessionKey, JSON.stringify(session));
  return session.user;
}

export const currentUser = () => session?.user || null;

export async function signIn(email, password) {
  const data = await apiRequest('/auth/v1/token?grant_type=password', {method:'POST',body:{email,password}});
  return acceptSession(data);
}

export async function signUp(email, password) {
  const data = await apiRequest('/auth/v1/signup', {method:'POST',body:{email,password}});
  if (data.access_token) return {user:acceptSession(data), needsConfirmation:false};
  return {user:null, needsConfirmation:true};
}

export async function restoreSession() {
  try { session = JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { session = null; }
  if (!session?.user?.id || !session.refreshToken) {session=null;return null;}
  try {
    const token = await getAccessToken();
    const user = await apiRequest('/auth/v1/user',{token});
    session.user = {id:user.id,email:user.email || session.user.email};
    localStorage.setItem(sessionKey, JSON.stringify(session));
  } catch (error) {
    if (error.status === 401 || error.status === 403) {session=null;localStorage.removeItem(sessionKey);return null;}
    // Keep a previously authenticated session for offline access to its local cache.
  }
  return session.user;
}

export async function getAccessToken() {
  if (!session?.refreshToken) throw new ApiError('請先登入',401);
  if (session.accessToken && session.expiresAt > Date.now() + 60_000) return session.accessToken;
  if (!refreshPromise) refreshPromise = apiRequest('/auth/v1/token?grant_type=refresh_token',
    {method:'POST',body:{refresh_token:session.refreshToken}}).then((data) => {acceptSession(data);return session.accessToken;}).finally(()=>{refreshPromise=null;});
  return refreshPromise;
}

export async function signOut() {
  const token = session?.accessToken;
  session = null; localStorage.removeItem(sessionKey);
  if (token) try { await apiRequest('/auth/v1/logout', {method:'POST',token}); } catch { /* Local sign-out still succeeds offline. */ }
}
