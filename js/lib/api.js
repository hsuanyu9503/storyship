// Supabase 連線與 RPC 包裝。
// 前端只使用 anon（publishable）key；資料庫高權限金鑰絕不放在前端。
import { createClient } from '../vendor/supabase-js-2.45.4.js';
import { CONFIG } from '../../config.js';

export const configured = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY
  && !CONFIG.SUPABASE_URL.includes('YOUR-PROJECT'));

// role: 'teacher' 會保存登入狀態；'student'／'projector' 不登入，只用 anon key
export function makeClient(role) {
  if (!configured) return null;
  const persist = role === 'teacher';
  return createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: persist, autoRefreshToken: persist, detectSessionInUrl: false,
            storageKey: persist ? 'sf-teacher-auth' : 'sf-' + role },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}

export class RpcError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
  get isNetwork() { return this.code === 'NETWORK'; }
}

// 呼叫 RPC；伺服器 raise 的代碼會放在 error.code
export async function rpc(client, fn, args = {}) {
  let res;
  try {
    res = await client.rpc(fn, args);
  } catch (e) {
    throw new RpcError('NETWORK', e);
  }
  if (res.error) {
    const { message = '', code = '' } = res.error;
    if (!code && /fetch|network|load failed/i.test(message)) throw new RpcError('NETWORK', res.error);
    const appCode = /^[A-Z_]+$/.test(message) ? message : (code === '42501' ? 'FORBIDDEN' : (message || 'UNKNOWN'));
    throw new RpcError(appCode, res.error);
  }
  return res.data;
}

export const ERROR_TEXT = {
  NETWORK: '網路連線中斷，正在重新連線…',
  FORBIDDEN: '沒有權限執行此操作。',
  NOT_JOINED: '尚未加入此活動。',
  SESSION_NOT_FOUND: '找不到這個活動代碼，或活動已結束。',
  SESSION_ENDED: '活動已結束。',
  JOIN_CLOSED: '老師已暫停加入，請舉手告訴老師。',
  GROUP_FULL: '這一組人數已滿，請選擇其他組別或洽老師。',
  NO_GROUP: '組別不存在。',
  INVALID_TOKEN: '裝置識別錯誤，請重新整理頁面。',
  STALE: '資料已被更新，已重新載入最新內容。',
  NOT_AVAILABLE: '目前環節尚未開放此內容。',
  REMOVED: '老師已將你移出小組。',
  PAUSED: '老師暫停了編輯，請先看前方。',
  SUBMITTED: '已經提交，不能再修改。',
  PERSONAL_LOCKED: '老師已結束個人分類，你的成果已保存。',
  SAME_GROUP: '兩側不能是同一組。',
  SESSION_FULL: '活動人數已達上限，請洽老師。',
  BAD_DATA: '資料格式錯誤，請重新整理頁面。',
  TOO_LONG: '文字太長了，請縮短一點。',
  TOO_MANY: '分類數量已達上限。',
  NO_CONTENT: '尚未匯入教學素材（請執行 supabase/seed）。',
};

export function errorText(e) {
  return ERROR_TEXT[e?.code] || ('發生錯誤：' + (e?.code || e?.message || e));
}
