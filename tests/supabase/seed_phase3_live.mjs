// 在「已部署的 Phase 3」（89299af）上，以真實 API 建立上課中的資料：
//   兩組學生、個人分類與快照、第 1 組正式提交、第 2 組由教師結束保存，最後停在 06 並已揭開第 0、2 類
//   （06 的投影由 Phase 3 教師端產生，格式與當時的 js/lib/projection.js 相同）。
// 輸出 JSON：{ sid, pk, t1Email, t1Password }（密碼為本次隨機測試帳號，不是任何正式帳號）
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../e2e/package.json'));
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const sql = new Pool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'postgres', password: process.env.POSTGRES_PASSWORD, database: 'postgres' });
const mk = () => createClient(process.env.GATEWAY_URL, process.env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const must = (r, what) => { if (r.error) throw new Error(what + ': ' + r.error.message); return r.data; };
const run = Date.now().toString(36);
const email = `p3-${run}@example.test`; const password = 'pw-' + run;
const t = mk();
must(await t.auth.signUp({ email, password }), 'signUp');
await sql.query(`insert into public.teachers (user_id, email) select id, email from auth.users where email = $1`, [email]);
must(await t.auth.signInWithPassword({ email, password }), 'signIn');
const s = mk();
const cr = must(await t.rpc('teacher_create_session', { p_title: 'Phase 3 上課中', p_group_count: 2 }), 'create');
const sid = cr.session_id;
const pk = must(await t.from('sessions').select('projector_key').eq('id', sid).single(), 'pk').projector_key;
const rev = async () => must(await t.from('session_state').select('rev').eq('session_id', sid).single(), 'rev').rev;
const stage = async (phase, sub, proj, lock = true) => {
  const r = must(await t.rpc('teacher_set_stage', { p_session: sid, p_phase: phase, p_sub: sub, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: lock }), 'stage ' + phase);
  if (!r.ok) throw new Error('stage ' + phase + ' ' + JSON.stringify(r));
};
const tok = (i) => require('crypto').createHash('sha256').update('p3:' + run + ':' + i).digest('hex');
for (const [i, g] of [[0, 1], [1, 1], [2, 2]]) must(await s.rpc('student_join', { p_code: cr.join_code, p_token: tok(i), p_group_number: g }), 'join');
const cards = must(await t.from('story_cards').select('id').order('sort_order'), 'cards').map((x) => x.id);
await stage('03', '03', { screen: 'instruction' }, false);
must(await s.rpc('student_save_personal', { p_session: sid, p_token: tok(0), p_data: { categories: [{ id: 'c1', no: 1, name: '我的分類', reason: '我的理由' }], placements: { [cards[0]]: 'c1' } }, p_expected_rev: 0 }), 'personal');
await stage('04', '04', { screen: 'instruction' }, false);
const c1 = '7b000000-0000-4000-8000-000000000001'; const c2 = '7b000000-0000-4000-8000-000000000002';
must(await s.rpc('group_add_category', { p_session: sid, p_token: tok(0), p_category: c1 }), 'add');
must(await s.rpc('group_update_category', { p_session: sid, p_token: tok(1), p_category: c1, p_field: 'name', p_value: 'Phase3 分類', p_expected_rev: 1 }), 'name');
must(await s.rpc('group_update_category', { p_session: sid, p_token: tok(1), p_category: c1, p_field: 'reason', p_value: 'Phase3 理由', p_expected_rev: 1 }), 'reason');
for (const c of cards) must(await s.rpc('group_move_card', { p_session: sid, p_token: tok(0), p_card: c, p_category: c1, p_expected_rev: 0 }), 'move');
const b = must(await s.rpc('student_group_board', { p_session: sid, p_token: tok(0) }), 'board');
must(await s.rpc('group_submit', { p_session: sid, p_token: tok(0), p_expected_board_rev: b.board_rev }), 'submit');
must(await s.rpc('group_add_category', { p_session: sid, p_token: tok(2), p_category: c2 }), 'add2');
must(await s.rpc('group_move_card', { p_session: sid, p_token: tok(2), p_card: cards[1], p_category: c2, p_expected_rev: 0 }), 'move2');
await stage('05', '05', { screen: 'placeholder', title: '分類成果大公開' }, true);
// Phase 3 教師端產生的 06 總覽：已揭開第 0、2 類（帶完整要素），其他為 null
const genres = must(await t.from('genres').select('name,elements,visual_url').order('sort_order').order('slug'), 'genres');
await stage('06', '06-03', { screen: 'genre', view: 'overview', ctl: { view: 'overview', index: 2, revealed: [0, 2] },
  genres: genres.map((g, i) => ([0, 2].includes(i) ? { name: g.name, visual_url: null, elements: g.elements.map((e) => ({ label: e.label, icon: e.icon || '' })) } : null)) }, true);
await sql.end();
console.log(JSON.stringify({ sid, pk, email, password }));
process.exit();
