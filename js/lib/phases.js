// 教學環節定義（資料驅動）。三端共用；伺服器端另有相同的環節代碼檢查。
export const PHASES = [
  { id: '00', name: '課前連線準備', minutes: 0, note: '不計入 40 分鐘' },
  { id: '01', name: '走進故事世界', minutes: 5,
    subs: [
      { id: '01-01', label: '故事世界的入口' },
      { id: '01-02', label: '走進神祕世界' },
      { id: '01-03', label: '故事世界揭曉' },
      { id: '01-04', label: '故事世界的交會' },
    ] },
  { id: '02', name: '分類任務啟動', minutes: 3 },
  { id: '03', name: '我的故事分類', minutes: 5 },
  { id: '04', name: '故事找朋友：小組共作', minutes: 12 },
  { id: '05', name: '分類成果大公開', minutes: 5 },
  { id: '06', name: '揭開小說類型', minutes: 5,
    subs: [
      { id: '06-01', label: '分類背後的祕密' },
      { id: '06-02', label: '五種小說世界' },
      { id: '06-03', label: '小說類型總覽' },
    ] },
  { id: '07', name: '小小故事分類師', minutes: 5 },
  { id: '99', name: '課程結束', minutes: 0 },
];

export const PHASE_IDS = PHASES.map((p) => p.id);

export function phaseById(id) {
  return PHASES.find((p) => p.id === id) || null;
}

export function nextPhase(id) {
  const i = PHASE_IDS.indexOf(id);
  return i >= 0 && i < PHASE_IDS.length - 1 ? PHASE_IDS[i + 1] : null;
}

export function prevPhase(id) {
  const i = PHASE_IDS.indexOf(id);
  return i > 0 ? PHASE_IDS[i - 1] : null;
}

export function totalMinutes() {
  return PHASES.reduce((s, p) => s + p.minutes, 0);
}

// 學生端在各環節的畫面（Phase 1：03、04 為開發中佔位）
export const STUDENT_VIEW = {
  '00': 'wait',
  '01': 'watch',
  '02': 'ready',
  '03': 'personal',
  '04': 'group',
  '05': 'watch',
  '06': 'watch',
  '07': 'watch',
  '99': 'end',
};

export const STUDENT_TEXT = {
  wait: '已加入活動，請等待老師開始。',
  watch01: '請觀看前方投影，跟著老師探索故事世界。',
  watch: '請觀看前方投影，參與老師的討論。',
  end: '每一種分類，都從觀察開始。',
};

// 固定教學文字（可依課本校對後修改）
export const TEXT = {
  activity: '故事找朋友',
  task: '仔細觀察故事的共同特色，建立自己的分類方式。',
  personal: '閱讀每一個故事，把有共同特色的故事放在一起，並幫每一類取名字。',
  group: '分享自己的分類想法、討論共同特色、建立小組分類。',
  recapItems: ['人物', '情節', '背景'],
  scaffold: '我們把這些故事分在一起，是因為＿＿＿＿，這些特色和＿＿＿＿小說比較接近。',
  endLine1: '每一種分類，都從觀察開始。',
  endLine2: '觀察故事的特色，找出共同點，說明我們分類的理由。',
};
