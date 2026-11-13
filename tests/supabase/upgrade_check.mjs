// 升級後（真實 PostgREST）：舊版 06 揭露保留且不擴大；升級前的快照可在 05 公開、未揭露理由不外流。
// 參數：seed_phase3_live.mjs 的輸出 JSON
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../e2e/package.json'));
const { createClient } = require('@supabase/supabase-js');
const live = JSON.parse(process.argv[2]);
const mk = () => createClient(process.env.GATEWAY_URL, process.env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let bad = 0; const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) bad++; };
const t = mk(); const s = mk();
const si = await t.auth.signInWithPassword({ email: live.email, password: live.password });
if (si.error) throw new Error('signIn ' + si.error.message);
const sid = live.sid;
const rev = async () => (await t.from('session_state').select('rev').eq('session_id', sid).single()).data.rev;
const stage = async (phase, sub, proj) => {
  const r = await t.rpc('teacher_set_stage', { p_session: sid, p_phase: phase, p_sub: sub, p_projection: proj, p_expected_rev: await rev(), p_lock_unsubmitted: true });
  if (r.error || !r.data.ok) throw new Error('stage ' + phase + ' ' + (r.error?.message || JSON.stringify(r.data)));
};
const proj = async () => JSON.stringify((await s.rpc('projector_state', { p_session: sid, p_key: live.pk })).data);
const p0 = await proj();
ok(p0.includes('想像世界') && p0.includes('歷史時代') && !p0.includes('神祕案件'), '升級後投影仍是升級前停在 06 的畫面');
await stage('07', '07', { screen: 'placeholder', title: '小小故事分類師' });
const disc = (await t.from('session_state').select('disclosure').eq('session_id', sid).single()).data.disclosure;
ok(JSON.stringify(disc) === JSON.stringify({ revealed: { 0: [0, 1, 2], 2: [0, 1, 2] } }), '離開舊版 06 畫面時，已揭開的兩類記為完整揭露 ' + JSON.stringify(disc));
// 沒有 localStorage 的第二台裝置返回 06：先送預設（回顧），再按「顯示總覽」
await stage('06', '06-01', { screen: 'genre', view: 'recap', items: ['人物'], ctl: { view: 'recap', index: 0, revealed: [] } });
await stage('06', '06-03', { screen: 'genre', view: 'overview', ctl: { view: 'overview', index: 0, revealed: [] } });
const ov = await proj();
ok(['奇幻小說', '想像世界', '神奇力量', '超自然現象', '歷史小說', '歷史時代', '真實背景', '虛構故事'].every((w) => ov.includes(w)), '返回 06：升級前揭開的類型與要素都還在');
ok(!['偵探小說', '神祕案件', '冒險小說', '未知探索'].some((w) => ov.includes(w)), '返回 06：沒有多揭露任何類型或要素');
// 升級前的快照：在 05 公開，理由未揭露時不外流
await stage('05', '05', { screen: 'placeholder', title: '分類成果大公開' });
const snaps = (await t.from('group_snapshots').select('id,kind,group_id').eq('session_id', sid)).data;
const sub = snaps.find((x) => x.kind === 'submitted');
const pub = await t.rpc('teacher_publish_compare', { p_session: sid, p_ctl: { left: sub.id }, p_expected_rev: await rev() });
ok(!pub.error && pub.data.ok, '升級前保存的快照可直接在 05 公開 ' + (pub.error?.message || ''));
const p5 = await proj();
ok(p5.includes('Phase3 分類') && !p5.includes('Phase3 理由'), '投影 API：顯示升級前的分類名稱、不含未揭露的理由');
process.exit(bad ? 1 : 0);
