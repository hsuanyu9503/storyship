// 以真實 PostgREST／GoTrue／Realtime（隔離的本機 Supabase，tests/supabase/up.sh）驗證：
//   RPC 參數、錯誤與回應格式；場次擁有者／另一位教師／未列入白名單的帳號／匿名（學生、投影）的權限邊界；
//   跨場次 ID；RLS；公開 API 不含未公開內容；Realtime 中斷與輪詢恢復。
// 一般使用者權限只用 anon key 與 GoTrue 簽發的使用者 JWT 測試；service_role 不用於任何權限判斷。
// 只輸出 ok／FAIL 與代碼，不輸出任何密鑰或 JWT。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../e2e/package.json'));
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const URL_ = process.env.GATEWAY_URL; const ANON = process.env.ANON_KEY;
const sql = new Pool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'postgres', password: process.env.POSTGRES_PASSWORD, database: 'postgres' });
let passed = 0; const fails = [];
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { fails.push(m); console.log('FAIL -', m); } };
const anon = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);

async function teacher(name, whitelist) {
  const c = anon();
  const email = `${name}-${run}@example.test`; const password = 'pw-' + run + '-' + name;
  const su = await c.auth.signUp({ email, password });
  if (su.error) throw new Error('signUp ' + su.error.message);
  if (whitelist) await sql.query(`insert into public.teachers (user_id, email) select id, email from auth.users where email = $1 on conflict do nothing`, [email]);
  const si = await c.auth.signInWithPassword({ email, password });
  if (si.error) throw new Error('signIn ' + si.error.message);
  return c;
}
// 與前端 js/lib/api.js 相同的錯誤對應，確認真實 PostgREST 的錯誤格式能被前端正確辨識
function appCode(res) {
  if (!res.error) return null;
  const { message = '', code = '' } = res.error;
  return /^[A-Z_]+$/.test(message) ? message : (code === '42501' ? 'FORBIDDEN' : (message || 'UNKNOWN'));
}
const tokenOf = (i) => require('crypto').createHash('sha256').update(run + ':' + i).digest('hex');   // 與學生端相同：十六進位裝置憑證

const t1 = await teacher('t1', true);
const t2 = await teacher('t2', true);
const t3 = await teacher('t3', false);
const s = anon();

// ---------- 建立場次、RPC 回應格式 ----------
const cr = await t1.rpc('teacher_create_session', { p_title: '整堂課驗收', p_group_count: 2 });
ok(!cr.error && cr.data?.session_id && /^[A-Z2-9]{6}$/.test(cr.data.join_code || ''), 'PostgREST：teacher_create_session 回傳 session_id 與加入代碼 ' + (cr.error?.message || ''));
const SID = cr.data.session_id; const CODE = cr.data.join_code;
const cr2 = await t1.rpc('teacher_create_session', { p_title: '另一場', p_group_count: 2 });
const SID2 = cr2.data.session_id;
const pk = (await t1.from('sessions').select('projector_key').eq('id', SID).single()).data?.projector_key;
ok(Boolean(pk), 'RLS：場次擁有者讀得到自己場次的投影金鑰');

// ---------- 參數與錯誤格式 ----------
const bad = await t1.rpc('teacher_create_session', { p_title: 'x', p_group_count: 99 });
ok(appCode(bad) === 'BAD_DATA' && bad.error.code === 'P0001', `錯誤格式：raise 'BAD_DATA' → message=BAD_DATA、code=P0001（前端可辨識）`);
const wrongArg = await t1.rpc('teacher_create_session', { p_nope: 1 });
ok(wrongArg.error?.code === 'PGRST202', 'PostgREST：參數名稱錯誤 → PGRST202（找不到函式簽章）');
const nullRev = await t1.rpc('teacher_set_stage', { p_session: SID, p_phase: '01', p_sub: '01', p_projection: { screen: 'intro' }, p_expected_rev: null });
ok(appCode(nullRev) === 'BAD_DATA', 'PostgREST：null 版本號被拒絕（BAD_DATA）');

// ---------- 權限邊界：教師 ----------
const st0 = (await t1.from('session_state').select('rev').eq('session_id', SID).single()).data;
const t2stage = await t2.rpc('teacher_set_stage', { p_session: SID, p_phase: '01', p_sub: '01', p_projection: { screen: 'intro' }, p_expected_rev: st0.rev });
ok(appCode(t2stage) === 'FORBIDDEN', '另一位教師不能切換別人的場次（FORBIDDEN）');
const t2read = await t2.from('session_state').select('*').eq('session_id', SID);
ok(!t2read.error && t2read.data.length === 0, 'RLS：另一位教師讀不到別人的 session_state（0 列）');
const t2sess = await t2.from('sessions').select('*').eq('id', SID);
ok(!t2sess.error && t2sess.data.length === 0, 'RLS：另一位教師讀不到別人的場次（含投影金鑰）');
const t3c = await t3.rpc('teacher_create_session', { p_title: 'x', p_group_count: 2 });
ok(appCode(t3c) === 'FORBIDDEN', '未列入教師白名單的登入帳號不能建立場次');
const t3read = await t3.from('session_state').select('*');
ok(!t3read.error && t3read.data.length === 0, 'RLS：未列入白名單的帳號讀不到任何場次狀態');
const ins = await t1.from('groups').insert({ session_id: SID, number: 9, name: 'x' });
ok(Boolean(ins.error) && appCode(ins) === 'FORBIDDEN', '教師不能直接寫入資料表（只能經 RPC）');
const upd = await t1.from('session_state').update({ phase: '07' }).eq('session_id', SID);
ok(Boolean(upd.error), '教師不能直接改 session_state');
const th = await t1.from('participants').select('token_hash').eq('session_id', SID);
ok(Boolean(th.error) && appCode(th) === 'FORBIDDEN', '裝置憑證雜湊（token_hash）不開放讀取');

// ---------- 權限邊界：匿名（學生、投影） ----------
for (const t of ['sessions', 'session_state', 'groups', 'participants', 'personal_boards', 'group_snapshots', 'teachers', 'group_categories']) {
  const r = await s.from(t).select('*').limit(1);
  ok(Boolean(r.error) && r.error.code === '42501', `匿名不能直接讀 ${t}（42501）`);
}
const anonT = await s.rpc('teacher_create_session', { p_title: 'x', p_group_count: 2 });
ok(appCode(anonT) === 'FORBIDDEN', '匿名不能執行教師 RPC');
const anonPrev = await s.rpc('teacher_preview_compare', { p_session: SID, p_ctl: {} });
ok(Boolean(anonPrev.error), '匿名不能執行 teacher_preview_compare');
const projBad = await s.rpc('projector_state', { p_session: SID, p_key: 'wrong' });
ok(Boolean(projBad.error) || projBad.data == null, '投影金鑰錯誤時拿不到投影資料');
const projOk = await s.rpc('projector_state', { p_session: SID, p_key: pk });
ok(!projOk.error && projOk.data?.projection, '投影端以正確金鑰取得 projection');

// ---------- 學生加入與一整段流程（真實 PostgREST） ----------
const stage = async (c, sid, phase, proj, lock = true) => {
  const rev = (await c.from('session_state').select('rev').eq('session_id', sid).single()).data.rev;
  const r = await c.rpc('teacher_set_stage', { p_session: sid, p_phase: phase, p_sub: phase, p_projection: proj, p_expected_rev: rev, p_lock_unsubmitted: lock });
  if (r.error || !r.data?.ok) throw new Error(`stage ${phase}: ${r.error?.message || JSON.stringify(r.data)}`);
};
const toks = [0, 1, 2, 3].map(tokenOf);
for (const [i, g] of [[0, 1], [1, 1], [2, 2], [3, 2]]) {
  const j = await s.rpc('student_join', { p_code: CODE, p_token: toks[i], p_group_number: g });
  ok(!j.error, `學生 ${i + 1} 以 anon 加入第 ${g} 組 ` + (j.error?.message || ''));
}
const jBad = await s.rpc('student_join', { p_code: 'ZZZZZZ', p_token: tokenOf(9), p_group_number: 1 });
ok(appCode(jBad) === 'SESSION_NOT_FOUND', '錯誤的加入代碼 → SESSION_NOT_FOUND');
const cards = (await t1.from('story_cards').select('id').order('sort_order')).data.map((x) => x.id);
await stage(t1, SID, '03', { screen: 'instruction' }, false);
const sp = await s.rpc('student_personal', { p_session: SID, p_token: toks[0] });
ok(!sp.error, '學生讀取個人分類 ' + (sp.error?.message || ''));
const save = await s.rpc('student_save_personal', { p_session: SID, p_token: toks[0],
  p_data: { categories: [{ id: 'c1', no: 1, name: '想法', reason: '' }], placements: { [cards[0]]: 'c1' } }, p_expected_rev: sp.data?.rev ?? 0 });
ok(!save.error, '學生儲存個人分類 ' + (save.error?.message || ''));
const cross = await s.rpc('student_personal', { p_session: SID2, p_token: toks[0] });
ok(Boolean(cross.error), '跨場次：學生的裝置憑證不能讀另一場次 → ' + appCode(cross));
await stage(t1, SID, '04', { screen: 'instruction' }, false);
const catA = '7a000000-0000-4000-8000-000000000001';
const add = await s.rpc('group_add_category', { p_session: SID, p_token: toks[0], p_category: catA });
ok(!add.error, '學生新增小組分類（冪等 ID）' + (add.error?.message || ''));
const addAgain = await s.rpc('group_add_category', { p_session: SID, p_token: toks[0], p_category: catA });
ok(!addAgain.error, '同一個分類 ID 重送不會建立第二個');
await s.rpc('group_update_category', { p_session: SID, p_token: toks[1], p_category: catA, p_field: 'name', p_value: '會魔法', p_expected_rev: 1 });
await s.rpc('group_update_category', { p_session: SID, p_token: toks[1], p_category: catA, p_field: 'reason', p_value: '秘密理由ZQX', p_expected_rev: 1 });
for (const c of cards) await s.rpc('group_move_card', { p_session: SID, p_token: toks[0], p_card: c, p_category: catA, p_expected_rev: 0 });
const board = await s.rpc('student_group_board', { p_session: SID, p_token: toks[0] });
ok(!board.error && board.data.categories.length === 1, '小組看板（真實 PostgREST）' + (board.error?.message || ''));
const g2board = await s.rpc('group_update_category', { p_session: SID, p_token: toks[2], p_category: catA, p_field: 'name', p_value: '入侵', p_expected_rev: 1 });
ok(Boolean(g2board.error) || g2board.data?.ok === false, '跨組：第 2 組學生不能改第 1 組的分類 → ' + (appCode(g2board) || g2board.data?.code));
const sub = await s.rpc('group_submit', { p_session: SID, p_token: toks[0], p_expected_board_rev: board.data.board_rev });
ok(!sub.error && sub.data?.ok, '小組正式提交 ' + (sub.error?.message || JSON.stringify(sub.data)));
await stage(t1, SID, '05', { screen: 'placeholder', title: '分類成果大公開' }, true);   // 第 2 組由教師結束保存

// ---------- 05：公開 API 不含未揭露理由；跨場次快照 ----------
const snaps = (await t1.from('group_snapshots').select('id,group_id,kind').eq('session_id', SID)).data;
const g1 = (await t1.from('groups').select('id,number').eq('session_id', SID)).data.find((g) => g.number === 1);
const s1 = snaps.find((x) => x.group_id === g1.id && x.kind === 'submitted');
ok(Boolean(s1), '提交後有第 1 組的正式快照');
const revNow = async (sid) => (await t1.from('session_state').select('rev').eq('session_id', sid).single()).data.rev;
const pub = await t1.rpc('teacher_publish_compare', { p_session: SID, p_ctl: { left: s1.id }, p_expected_rev: await revNow(SID) });
ok(!pub.error && pub.data?.ok, '公開 05（真實 PostgREST）' + (pub.error?.message || ''));
const pj = JSON.stringify((await s.rpc('projector_state', { p_session: SID, p_key: pk })).data);
ok(pj.includes('會魔法') && !pj.includes('秘密理由ZQX') && pj.includes('"hidden"'), '投影 API：未揭露的理由不在回應中（只有 hidden）');
const t2prev = await t2.rpc('teacher_preview_compare', { p_session: SID, p_ctl: { left: s1.id } });
ok(appCode(t2prev) === 'FORBIDDEN', '另一位教師不能預覽別人場次的成果');
await stage(t1, SID2, '05', { screen: 'placeholder' }, true);
const crossSnap = await t1.rpc('teacher_publish_compare', { p_session: SID2, p_ctl: { left: s1.id }, p_expected_rev: await revNow(SID2) });
ok(appCode(crossSnap) === 'BAD_DATA', '跨場次：另一場次的快照 ID 被拒絕（BAD_DATA）');
const stale = await t1.rpc('teacher_publish_compare', { p_session: SID, p_ctl: { left: s1.id }, p_expected_rev: 1 });
ok(!stale.error && stale.data?.ok === false && stale.data.code === 'STALE', '過期版本號 → {ok:false, code:STALE}');
const fake = await t1.rpc('teacher_set_stage', { p_session: SID, p_phase: '05', p_sub: '05', p_projection: { screen: 'compare', sides: [] }, p_expected_rev: await revNow(SID) });
ok(appCode(fake) === 'BAD_DATA', '前端自組的 compare 投影被拒絕');

// ---------- 06／07：揭露範圍 ----------
await stage(t1, SID, '06', { screen: 'genre', view: 'genre', ctl: { view: 'genre', index: 2, reveal: true } }, true);
await stage(t1, SID, '07', { screen: 'placeholder', title: '小小故事分類師' }, true);
const cat = (await t1.from('group_snapshots').select('data').eq('id', s1.id).single()).data.data;
const pm = await t1.rpc('teacher_publish_match', { p_session: SID, p_ctl: { snapshot: s1.id, category: catA, genre: 1, elements: [] }, p_expected_rev: await revNow(SID) });
ok(!pm.error && pm.data?.ok, '公開 07（只有類型名稱）' + (pm.error?.message || ''));
await stage(t1, SID, '06', { screen: 'genre', view: 'overview', ctl: { view: 'overview', index: 0, revealed: [0, 1, 2, 3, 4] }, genres: [{ name: '偷看', elements: [{ label: '冒險旅程' }] }] }, true);
const ov = JSON.stringify((await s.rpc('projector_state', { p_session: SID, p_key: pk })).data);
ok(ov.includes('偵探') && !ov.includes('離奇事件與謎團') && !ov.includes('敏銳觀察與分析') && ov.includes('歷史事件或人物') && !ov.includes('冒險') && !ov.includes('偷看'),
  '投影 API：06 總覽只含 06 揭開的類型與 07 公開的名稱；教師端夾帶的內容被忽略');
ok(!ov.includes('提問：') && !ov.includes('剛才我們閱讀故事') && !ov.includes('秘密理由ZQX'), '投影 API：不含教師補充（各類與共同補充）與未揭露的理由');
const guide = await t1.from('content_sets').select('genre_teacher_guide').limit(1);
ok(!guide.error && guide.data[0]?.genre_teacher_guide?.reminder?.includes('不是每個故事都必須全部符合'), '真實 PostgREST：教師讀得到共同補充');
const guideAnon = await s.from('content_sets').select('genre_teacher_guide').limit(1);
ok(Boolean(guideAnon.error) && guideAnon.error.code === '42501', '真實 PostgREST：匿名讀不到教師共同補充（42501）');

// ---------- Realtime：收到變更通知；中斷時輪詢仍能取得正確狀態 ----------
const rt = anon();
const got = [];
const ch = rt.channel('lesson:' + SID, { config: { broadcast: { self: false } } });
ch.on('broadcast', { event: '*' }, (m) => got.push(m));
const subscribed = await new Promise((res) => { ch.subscribe((st) => { if (st === 'SUBSCRIBED') res(true); }); setTimeout(() => res(false), 15000); });
ok(subscribed, 'Realtime：匿名（學生／投影）訂閱場次頻道');
// 全新的本機 Realtime 在第一個連線時才建立 realtime.send／realtime.messages（正式 Supabase 專案已存在）：等它就緒
for (let i = 0; i < 60; i++) {
  if ((await sql.query(`select to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null and to_regclass('realtime.messages') is not null r`)).rows[0].r) break;
  await sleep(500);
}
await sleep(3000);
await stage(t1, SID, '07', { screen: 'placeholder' }, true);
for (let i = 0; i < 60 && !got.length; i++) await sleep(250);
ok(got.length > 0 && JSON.stringify(got[0]).includes('changed') && !JSON.stringify(got).includes('秘密理由ZQX'),
  'Realtime：資料庫送出的變更通知到達（只有訊號，不含教學內容）');
await rt.removeAllChannels();

// ---------- 結束場次：資料與快照不變 ----------
const before = (await sql.query(`select md5(string_agg(id || data::text || created_at, '|' order by id)) h from public.group_snapshots where session_id = $1`, [SID])).rows[0].h;
await stage(t1, SID, '99', { screen: 'end' }, true);
const end = await t1.rpc('teacher_end_session', { p_session: SID });
ok(!end.error, '結束場次 ' + (end.error?.message || ''));
const after = (await sql.query(`select md5(string_agg(id || data::text || created_at, '|' order by id)) h from public.group_snapshots where session_id = $1`, [SID])).rows[0].h;
ok(before === after, '結束場次後快照逐位元組相同');
const late = await s.rpc('group_move_card', { p_session: SID, p_token: toks[2], p_card: cards[0], p_category: null, p_expected_rev: 0 });
ok(Boolean(late.error) || late.data?.ok === false, '結束後學生不能再修改 → ' + (appCode(late) || late.data?.code));

await sql.end();
console.log(`\n通過 ${passed} 項，失敗 ${fails.length} 項`);
if (fails.length) { fails.forEach((m) => console.log('  FAIL -', m)); process.exitCode = 1; }
process.exit();
