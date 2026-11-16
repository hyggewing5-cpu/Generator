/**************************************************************
 * GenLog 250 kVA — ระบบบันทึกการใช้งานเครื่องกำเนิดไฟฟ้า
 * Backend : Google Apps Script | Database : Google Sheets
 * เริ่มต้น: เลือกฟังก์ชัน setup แล้วกด Run 1 ครั้ง
 **************************************************************/

const TZ = 'Asia/Bangkok';
const TOKEN_TTL = 6 * 60 * 60;   // อายุการล็อกอิน 6 ชม.
const DAY = 864e5;

const SH = { SETTINGS: 'Settings', CURVE: 'FuelCurve', SESSIONS: 'Sessions',
             EVENTS: 'Events', FUEL: 'FuelLog', USERS: 'Users' };

const HEADERS = {
  Settings:  ['Key', 'Value', 'Description'],
  FuelCurve: ['LoadPct', 'RateMin', 'RateMax', 'RateUsed', 'SFC_g_kWh'],
  Sessions:  ['SessionID', 'Type', 'Status', 'OutageStart', 'GenStart', 'LoadStart', 'MainsRestored', 'GenStop',
              'OutageMin', 'RunHours', 'LoadHours', 'AvgLoadPct', 'FuelUsedL', 'HourMeterStart', 'HourMeterEnd',
              'Segments', 'Operator', 'Note'],
  Events:    ['EventID', 'Timestamp', 'SessionID', 'EventType', 'EventLabel', 'LoadPct', 'Detail', 'User'],
  FuelLog:   ['FuelID', 'Timestamp', 'Type', 'Liters', 'PricePerL', 'TotalCost', 'CalcLevel', 'MeasuredLevel',
              'DiffL', 'DiffPct', 'LevelAfter', 'Inspector', 'Note'],
  Users:     ['Name', 'PIN', 'Role', 'Active']
};

const DEFAULT_SETTINGS = [
  ['GeneratorID', 'GEN-01', 'รหัสเครื่อง'],
  ['GeneratorName', 'เครื่องกำเนิดไฟฟ้า 250 kVA', 'ชื่อเครื่อง'],
  ['Location', '', 'สถานที่ติดตั้ง'],
  ['RatedKVA', 250, 'ขนาดเครื่อง (kVA)'],
  ['RatedKW', 200, 'กำลังไฟฟ้า (kW) ที่ PF 0.8'],
  ['FuelType', 'ดีเซล', 'ชนิดเชื้อเพลิง'],
  ['TankCapacity', 600, 'ความจุถัง (ลิตร)'],
  ['IdleRate', 15, 'อัตราสิ้นเปลืองขณะวอร์ม/เดินเปล่า (ลิตร/ชม.)'],
  ['DefaultLoadPct', 50, 'โหลดเริ่มต้นเมื่อจ่ายไฟ (%)'],
  ['WarnPct', 50, 'เตือนเหลือง เมื่อน้ำมันต่ำกว่า (% ถัง)'],
  ['CriticalPct', 25, 'เตือนแดง เมื่อน้ำมันต่ำกว่า (% ถัง)'],
  ['CriticalHours', 4, 'เตือนแดง เมื่อเดินต่อได้น้อยกว่า (ชม.)'],
  ['DiffAlertPct', 5, 'เตือนเมื่อผลต่างวัดจริง-คำนวณ เกิน (% ถัง)'],
  ['WarmupPerWeek', 2, 'เป้าหมายวอร์มเครื่องต่อสัปดาห์ (ครั้ง)'],
  ['WarmupMinutes', 15, 'เวลาวอร์มที่แนะนำ (นาที)'],
  ['CurrentState', 'IDLE', 'สถานะระบบ (ห้ามแก้ไขเอง)'],
  ['CurrentSessionID', '', 'รอบการทำงานปัจจุบัน (ห้ามแก้ไขเอง)']
];

// อัตราสิ้นเปลืองตามเอกสาร — RateUsed ใช้ค่าสูงสุดเพื่อประมาณการแบบปลอดภัย
const DEFAULT_CURVE = [
  [25, 14.0, 15.0, 15.0, 244],
  [50, 25.5, 27.0, 27.0, 233],
  [75, 37.0, 39.0, 39.0, 217],
  [100, 49.0, 52.0, 52.0, 204]
];

const EDITABLE_KEYS = ['GeneratorName', 'Location', 'TankCapacity', 'IdleRate', 'DefaultLoadPct', 'WarnPct',
  'CriticalPct', 'CriticalHours', 'DiffAlertPct', 'WarmupPerWeek', 'WarmupMinutes'];

const STATE_LABEL = {
  IDLE: 'พร้อมใช้งาน (ไฟหลักปกติ)',
  OUTAGE: 'ไฟดับ — เครื่องยังไม่ทำงาน',
  RUNNING: 'เครื่องทำงาน — ยังไม่จ่ายไฟ',
  SUPPLYING: 'กำลังจ่ายไฟเข้าระบบ',
  COOLDOWN: 'ไฟหลักกลับมา — รอดับเครื่อง',
  WARMUP: 'กำลังวอร์มเครื่อง'
};
const ALL_STATES = Object.keys(STATE_LABEL);
const TYPE_LABEL = { OUTAGE: 'ไฟดับ', WARMUP: 'วอร์มเครื่อง' };
const FUEL_LABEL = { REFILL: 'เติมน้ำมัน', MEASURE: 'ตรวจวัดระดับ' };

const ACTIONS = {
  OUTAGE_START:   { label: 'ไฟฟ้าดับ',          from: ['IDLE'] },
  GEN_START:      { label: 'สตาร์ทเครื่อง',      from: ['OUTAGE'] },
  TRANSFER_LOAD:  { label: 'จ่ายไฟเข้าระบบ',     from: ['RUNNING'] },
  LOAD_CHANGE:    { label: 'ปรับโหลด',          from: ['SUPPLYING', 'WARMUP'] },
  MAINS_RESTORED: { label: 'ไฟหลักกลับมา',       from: ['OUTAGE', 'RUNNING', 'SUPPLYING'] },
  GEN_STOP:       { label: 'หยุดเครื่อง',         from: ['RUNNING', 'SUPPLYING', 'COOLDOWN', 'WARMUP'] },
  WARMUP_START:   { label: 'สตาร์ทวอร์มเครื่อง',   from: ['IDLE'] },
  FAULT:          { label: 'แจ้งเหตุขัดข้อง',      from: ALL_STATES }
};

/* ======================= ENTRY ======================= */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('GenLog 250 kVA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('GenLog')
    .addItem('ติดตั้ง / ตรวจสอบโครงสร้างชีต', 'setup').addToUi();
}

function setup() {
  // กันเรียกจากหน้าเว็บโดยผู้ใช้อื่น: ถ้าระบุตัวตนได้ ต้องเป็นเจ้าของสคริปต์เท่านั้น
  const who = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (who && owner && who !== owner) throw new Error('เฉพาะเจ้าของสคริปต์เท่านั้นที่ติดตั้งได้');
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]])
        .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  });
  const set = ss.getSheetByName(SH.SETTINGS);
  if (set.getLastRow() < 2) set.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);

  const cur = ss.getSheetByName(SH.CURVE);
  if (cur.getLastRow() < 2) cur.getRange(2, 1, DEFAULT_CURVE.length, 5).setValues(DEFAULT_CURVE);

  const us = ss.getSheetByName(SH.USERS);
  us.getRange('B:B').setNumberFormat('@');
  if (us.getLastRow() < 2) us.getRange(2, 1, 3, 4).setValues([
    ['ผู้ดูแลระบบ', '482913', 'admin', true],
    ['พลขับเครื่อง', '715204', 'operator', true],
    ['ผู้บังคับบัญชา', '639871', 'viewer', true]
  ]);

  const fl = ss.getSheetByName(SH.FUEL);
  SpreadsheetApp.flush();
  const initCap = num_(getSettings_().TankCapacity, 600);
  if (fl.getLastRow() < 2) appendRow_(SH.FUEL, {
    FuelID: genId_('MSR'), Timestamp: new Date(), Type: 'MEASURE', CalcLevel: initCap, MeasuredLevel: initCap,
    DiffL: 0, DiffPct: 0, LevelAfter: initCap, Inspector: 'ตั้งค่าเริ่มต้น',
    Note: 'ยอดน้ำมันเริ่มต้น — แก้ MeasuredLevel/LevelAfter ให้ตรงระดับจริง'
  });

  ss.getSheetByName(SH.SESSIONS).getRange('D:H').setNumberFormat('dd/MM/yyyy HH:mm');
  ss.getSheetByName(SH.EVENTS).getRange('B:B').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  fl.getRange('B:B').setNumberFormat('dd/MM/yyyy HH:mm');

  ['Sheet1', 'แผ่น1', 'ชีต1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
}

/* ======================= AUTH ======================= */
function login(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fail') || 0);
  if (fails >= 10) throw new Error('ใส่ PIN ผิดหลายครั้ง กรุณารอ 10 นาที');
  pin = String(pin || '').trim();
  const matches = readAll_(SH.USERS).filter(r => String(r.PIN).trim() === pin && isTrue_(r.Active));
  if (matches.length > 1) throw new Error('PIN ซ้ำกับผู้ใช้อื่น กรุณาแจ้งผู้ดูแลให้เปลี่ยน PIN');
  const u = matches[0];
  if (!pin || !u) {
    cache.put('login_fail', String(fails + 1), 600);
    throw new Error('PIN ไม่ถูกต้อง');
  }
  const token = Utilities.getUuid();
  const user = { name: String(u.Name), role: String(u.Role).toLowerCase() };
  cache.put('tok_' + token, JSON.stringify(user), TOKEN_TTL);
  return { token: token, user: user };
}

function logout(token) {
  CacheService.getScriptCache().remove('tok_' + token);
  return true;
}

function auth_(token, roles) {
  const c = token && CacheService.getScriptCache().get('tok_' + token);
  if (!c) throw new Error('SESSION_EXPIRED');
  const u = JSON.parse(c);
  if (roles && roles.indexOf(u.role) < 0) throw new Error('คุณไม่มีสิทธิ์ใช้งานฟังก์ชันนี้');
  return u;
}

/* ======================= PUBLIC API ======================= */
function getDashboard(token) {
  return buildDashboard_(auth_(token));
}

function doAction(token, action, p) {
  const user = auth_(token, ['admin', 'operator']);
  const def = ACTIONS[action];
  if (!def) throw new Error('ไม่รู้จักคำสั่งนี้');
  p = p || {};
  return withLock_(() => {
    const st = getSettings_();
    const state = st.CurrentState || 'IDLE';
    if (def.from.indexOf(state) < 0)
      throw new Error('ไม่สามารถ "' + def.label + '" ได้ ขณะสถานะ: ' + STATE_LABEL[state]);

    const now = Date.now();
    const t = p.time ? parseTime_(p.time) : now;
    if (t > now + 60000) throw new Error('เวลาที่ระบุต้องไม่อยู่ในอนาคต');

    const pts = curvePoints_(st);
    const load = clampLoad_(p.load, st.DefaultLoadPct);
    const hm = (p.hourMeter === '' || p.hourMeter == null) ? '' : Number(p.hourMeter);
    if (hm !== '' && (isNaN(hm) || hm < 0)) throw new Error('ค่าชั่วโมงเครื่องไม่ถูกต้อง');
    const note = clean_(p.note);

    let sess = st.CurrentSessionID ? getSession_(st.CurrentSessionID) : null;
    if (state !== 'IDLE' && !sess && action !== 'FAULT')
      throw new Error('ไม่พบรอบการทำงานปัจจุบัน ให้ผู้ดูแลกด "รีเซ็ตสถานะ" ในหน้าตั้งค่า');
    if (sess && action !== 'FAULT' && t < lastTime_(sess))
      throw new Error('เวลาต้องไม่ก่อนรายการล่าสุดของรอบนี้ (' + fmtTH_(lastTime_(sess)) + ')');

    let next = state, evLoad = '';
    switch (action) {
      case 'OUTAGE_START':
        sess = newSession_('OUTAGE', user.name, note);
        sess.OutageStart = new Date(t);
        next = 'OUTAGE'; break;
      case 'WARMUP_START':
        sess = newSession_('WARMUP', user.name, note);
        sess.GenStart = new Date(t); sess.HourMeterStart = hm;
        sess.segs.push({ t: t, load: 0 });
        next = 'WARMUP'; break;
      case 'GEN_START':
        sess.GenStart = new Date(t); sess.HourMeterStart = hm;
        sess.segs.push({ t: t, load: 0 });
        next = 'RUNNING'; break;
      case 'TRANSFER_LOAD':
        sess.LoadStart = new Date(t);
        sess.segs.push({ t: t, load: load }); evLoad = load;
        next = 'SUPPLYING'; break;
      case 'LOAD_CHANGE':
        sess.segs.push({ t: t, load: load }); evLoad = load;
        break;
      case 'MAINS_RESTORED':
        sess.MainsRestored = new Date(t);
        sess.OutageMin = round_((t - toMs_(sess.OutageStart)) / 60000, 1);
        if (state === 'OUTAGE') { closeSession_(sess, t, pts, hm); next = 'IDLE'; }
        else { sess.segs.push({ t: t, load: 0 }); next = 'COOLDOWN'; }
        break;
      case 'GEN_STOP':
        closeSession_(sess, t, pts, hm); next = 'IDLE'; break;
      case 'FAULT':
        if (!note) throw new Error('กรุณาระบุรายละเอียดเหตุขัดข้อง');
        break;
    }
    if (sess && action !== 'FAULT') saveSession_(sess);

    const detail = [note, hm !== '' ? 'ชม.เครื่อง ' + hm : ''].filter(String).join(' | ');
    logEvent_(t, sess ? sess.SessionID : '', action, def.label, evLoad, detail, user.name);
    setSettings_({ CurrentState: next, CurrentSessionID: next === 'IDLE' ? '' : (sess ? sess.SessionID : st.CurrentSessionID) });
    return { message: 'บันทึก "' + def.label + '" เรียบร้อย', dashboard: buildDashboard_(user) };
  });
}

function recordRefill(token, p) {
  const user = auth_(token, ['admin', 'operator']);
  p = p || {};
  const liters = Number(p.liters);
  if (!(liters > 0) || liters > 10000) throw new Error('กรุณาระบุปริมาณที่เติมให้ถูกต้อง');
  const price = (p.price === '' || p.price == null) ? '' : Number(p.price);
  if (price !== '' && (isNaN(price) || price < 0)) throw new Error('ราคาต่อลิตรไม่ถูกต้อง');

  return withLock_(() => {
    const st = getSettings_(), pts = curvePoints_(st), cap = num_(st.TankCapacity, 600);
    const now = Date.now();
    const t = p.time ? parseTime_(p.time) : now;
    if (t > now + 60000) throw new Error('เวลาที่ระบุต้องไม่อยู่ในอนาคต');

    const before = fuelLevel_(st, readAll_(SH.SESSIONS).map(parseSession_), readAll_(SH.FUEL), pts, t).level;
    const after = before + liters;
    const note = clean_(p.note);
    appendRow_(SH.FUEL, {
      FuelID: genId_('REF'), Timestamp: new Date(t), Type: 'REFILL', Liters: liters, PricePerL: price,
      TotalCost: price === '' ? '' : round_(price * liters, 2), CalcLevel: round_(before, 1),
      LevelAfter: round_(after, 1), Inspector: user.name, Note: note
    });
    logEvent_(t, '', 'REFILL', 'เติมน้ำมัน', '', liters + ' ลิตร' + (note ? ' | ' + note : ''), user.name);

    const warnings = [];
    if (after > cap * 1.02)
      warnings.push('ยอดหลังเติมตามการคำนวณ (' + round_(after, 0) + ' ล.) เกินความจุถัง ควรตรวจวัดระดับจริง');
    if (p.measuredAfter !== '' && p.measuredAfter != null) {
      const m = measureInternal_(t + 1000, Number(p.measuredAfter), 'วัดหลังเติม', user, st, pts, cap);
      if (m.warning) warnings.push(m.warning);
    }
    return { message: 'บันทึกการเติม ' + liters + ' ลิตร เรียบร้อย', warnings: warnings, dashboard: buildDashboard_(user) };
  });
}

function recordMeasure(token, p) {
  const user = auth_(token, ['admin', 'operator']);
  p = p || {};
  if (p.measured === '' || p.measured == null) throw new Error('กรุณาระบุระดับที่วัดได้');
  return withLock_(() => {
    const st = getSettings_(), pts = curvePoints_(st), cap = num_(st.TankCapacity, 600);
    const now = Date.now();
    const t = p.time ? parseTime_(p.time) : now;
    if (t > now + 60000) throw new Error('เวลาที่ระบุต้องไม่อยู่ในอนาคต');
    const m = measureInternal_(t, Number(p.measured), clean_(p.note), user, st, pts, cap);
    return {
      message: 'บันทึกระดับ ' + p.measured + ' ลิตร (ต่างจากคำนวณ ' + round_(m.diff, 1) + ' ล.)',
      warnings: m.warning ? [m.warning] : [], dashboard: buildDashboard_(user)
    };
  });
}

function getReport(token, fromStr, toStr, type) {
  const user = auth_(token);
  const from = dayStart_(fromStr), to = dayStart_(toStr) + DAY - 1;
  if (to < from) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  if (to - from > 400 * DAY) throw new Error('เลือกช่วงได้ไม่เกิน 400 วัน');
  type = type || 'ALL';

  const st = getSettings_(), pts = curvePoints_(st), now = Date.now();
  const allSess = readAll_(SH.SESSIONS).map(parseSession_).filter(s => s.startMs >= from && s.startMs <= to);
  const logs = readAll_(SH.FUEL).filter(l => inRange_(toMs_(l.Timestamp), from, to))
    .sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const events = readAll_(SH.EVENTS).filter(e => inRange_(toMs_(e.Timestamp), from, to));

  const sess = (type === 'OUTAGE' || type === 'WARMUP') ? allSess.filter(s => s.Type === type)
    : (type === 'ALL' ? allSess : []);
  const rows = sess.sort((a, b) => a.startMs - b.startMs).map(s => sessionOut_(s, pts, now));
  const fuelRows = (type === 'ALL' || type === 'FUEL') ? logs.map(fuelOut_) : [];
  const faults = events.filter(e => e.EventType === 'FAULT').map(evOut_);

  // กราฟรายวัน / รายเดือน
  const byMonth = (to - from) > 62 * DAY;
  const kf = byMonth ? 'yyyy-MM' : 'yyyy-MM-dd', lf = byMonth ? 'MM/yyyy' : 'dd/MM';
  const bucket = {}, order = [];
  for (let d = from; d <= to; d += DAY) {
    const k = Utilities.formatDate(new Date(d), TZ, kf);
    if (!bucket[k]) {
      bucket[k] = { label: Utilities.formatDate(new Date(d), TZ, lf), fuelUsed: 0, refillL: 0, runHours: 0, outages: 0 };
      order.push(k);
    }
  }
  rows.forEach(r => {
    const b = bucket[Utilities.formatDate(new Date(r.start), TZ, kf)];
    if (b) { b.fuelUsed += r.fuel; b.runHours += r.runHours; if (r.type === 'OUTAGE') b.outages++; }
  });
  logs.forEach(l => {
    if (l.Type !== 'REFILL') return;
    const b = bucket[Utilities.formatDate(new Date(toMs_(l.Timestamp)), TZ, kf)];
    if (b) b.refillL += num_(l.Liters, 0);
  });
  const daily = order.map(k => ({
    label: bucket[k].label, fuelUsed: round_(bucket[k].fuelUsed, 1), refillL: round_(bucket[k].refillL, 1),
    runHours: round_(bucket[k].runHours, 2), outages: bucket[k].outages
  }));

  const annex = logs.map(l => ({
    t: toMs_(l.Timestamp), fuelType: String(st.FuelType || 'ดีเซล'),
    serviced: l.Type === 'REFILL' ? num_(l.Liters, null) : null,
    inTank: l.Type === 'MEASURE' ? num_(l.MeasuredLevel, null) : num_(l.LevelAfter, null),
    measured: l.Type === 'MEASURE', inspector: String(l.Inspector || ''), note: String(l.Note || '')
  }));

  return {
    from: fromStr, to: toStr, type: type, generatedAt: now, generatedBy: user.name,
    gen: { name: String(st.GeneratorName), location: String(st.Location || ''), kva: st.RatedKVA, cap: num_(st.TankCapacity, 600) },
    summary: summarize_(allSess, logs, events, from, to, pts),
    daily: daily, sessions: rows, fuel: fuelRows, faults: faults, annex: annex
  };
}

function exportReport(token, fromStr, toStr, type) {
  auth_(token, ['admin']);
  const r = getReport(token, fromStr, toStr, type);
  const ss = SpreadsheetApp.create('รายงานเครื่องกำเนิดไฟฟ้า ' + fromStr + ' ถึง ' + toStr);
  const s = r.summary;
  const sum = ss.getSheets()[0].setName('สรุป');
  const sumRows = [
    ['รายการ', 'ค่า'], ['เครื่อง', r.gen.name], ['ช่วงวันที่', fromStr + ' ถึง ' + toStr],
    ['จำนวนครั้งไฟดับ', s.outages], ['เวลาไฟดับรวม (นาที)', s.outageMin],
    ['จำนวนครั้งวอร์มเครื่อง', s.warmups], ['ชั่วโมงเดินเครื่องรวม', s.runHours],
    ['ชั่วโมงจ่ายไฟรวม', s.loadHours], ['น้ำมันที่ใช้ (ลิตร, ประมาณการ)', s.fuelUsed],
    ['จำนวนครั้งเติมน้ำมัน', s.refills], ['ปริมาณเติมรวม (ลิตร)', s.refillL],
    ['ค่าน้ำมันรวม (บาท)', s.refillCost], ['เหตุขัดข้อง (ครั้ง)', s.faults],
    ['ออกรายงานโดย', r.generatedBy], ['วันที่ออกรายงาน', fmtTH_(r.generatedAt)]
  ];
  sum.getRange(1, 1, sumRows.length, 2).setValues(sumRows);
  styleHead_(sum, 2); sum.autoResizeColumns(1, 2);

  writeTable_(ss, 'การทำงาน',
    ['รหัส', 'ประเภท', 'ไฟดับ', 'สตาร์ท', 'จ่ายไฟ', 'ไฟกลับ', 'หยุดเครื่อง', 'ไฟดับ (นาที)', 'เดินเครื่อง (ชม.)',
     'จ่ายไฟ (ชม.)', 'โหลดเฉลี่ย %', 'น้ำมัน (ล.)', 'ชม.เครื่องเริ่ม', 'ชม.เครื่องจบ', 'ผู้บันทึก', 'หมายเหตุ'],
    r.sessions.map(x => [x.id, x.typeLabel, fmtTH_(x.outageStart), fmtTH_(x.genStart), fmtTH_(x.loadStart),
      fmtTH_(x.mainsRestored), fmtTH_(x.genStop), x.outageMin, x.runHours, x.loadHours, x.avgLoad, x.fuel,
      x.hmStart, x.hmEnd, x.operator, x.note]));

  writeTable_(ss, 'เชื้อเพลิง',
    ['วันเวลา', 'ประเภท', 'ลิตร', 'ราคา/ลิตร', 'รวม (บาท)', 'ยอดคำนวณ', 'วัดจริง', 'ผลต่าง (ล.)', 'ผลต่าง %', 'คงถังหลังรายการ', 'ผู้บันทึก', 'หมายเหตุ'],
    r.fuel.map(x => [fmtTH_(x.t), x.typeLabel, x.liters, x.price, x.cost, x.calc, x.measured, x.diff, x.diffPct, x.after, x.by, x.note]));

  writeTable_(ss, 'ผนวก ง',
    ['วัน เดือน ปี', 'ประเภทเชื้อเพลิง', 'จำนวนบริการเชื้อเพลิง (ลิตร)', 'เชื้อเพลิงคงถัง (ลิตร)', 'ผู้ตรวจสอบ', 'หมายเหตุ'],
    r.annex.map(x => [fmtTH_(x.t), x.fuelType, x.serviced == null ? '-' : x.serviced, x.inTank, x.inspector, x.note]));

  writeTable_(ss, 'เหตุขัดข้อง', ['วันเวลา', 'รายละเอียด', 'ผู้บันทึก'],
    r.faults.map(x => [fmtTH_(x.t), x.detail, x.user]));

  return ss.getUrl();
}

function getAdminSettings(token) {
  auth_(token, ['admin']);
  const rows = readAll_(SH.SETTINGS);
  return {
    settings: EDITABLE_KEYS.map(k => {
      const r = rows.find(x => x.Key === k) || {};
      return { key: k, value: r.Value == null ? '' : r.Value, desc: String(r.Description || k) };
    }),
    curve: readAll_(SH.CURVE).map(c => ({ row: c._row, load: c.LoadPct, min: c.RateMin, max: c.RateMax, used: c.RateUsed, sfc: c.SFC_g_kWh }))
  };
}

function saveAdminSettings(token, settings, curve) {
  const user = auth_(token, ['admin']);
  return withLock_(() => {
    const upd = {};
    EDITABLE_KEYS.forEach(k => {
      if (!settings || settings[k] === undefined) return;
      if (k === 'GeneratorName' || k === 'Location') { upd[k] = clean_(settings[k]).slice(0, 100); return; }
      const n = Number(settings[k]);
      if (settings[k] === '' || isNaN(n) || n < 0) throw new Error('ค่า "' + k + '" ไม่ถูกต้อง');
      upd[k] = n;
    });
    if (upd.TankCapacity !== undefined && upd.TankCapacity <= 0) throw new Error('ความจุถังต้องมากกว่า 0');
    setSettings_(upd);

    const sh = sheet_(SH.CURVE), last = sh.getLastRow();
    (curve || []).forEach(c => {
      const row = Number(c.row), v = Number(c.used);
      if (row < 2 || row > last) return;
      if (isNaN(v) || v <= 0) throw new Error('ค่าอัตราสิ้นเปลืองไม่ถูกต้อง');
      sh.getRange(row, 4).setValue(v);
    });
    logEvent_(Date.now(), '', 'SETTINGS', 'แก้ไขการตั้งค่า', '', JSON.stringify(upd).slice(0, 400), user.name);
    return { message: 'บันทึกการตั้งค่าเรียบร้อย' };
  });
}

function forceReset(token, note) {
  const user = auth_(token, ['admin']);
  return withLock_(() => {
    const st = getSettings_(), pts = curvePoints_(st), now = Date.now();
    const sess = st.CurrentSessionID ? getSession_(st.CurrentSessionID) : null;
    if (sess && sess.Status === 'OPEN') {
      closeSession_(sess, Math.max(now, lastTime_(sess)), pts, '');
      sess.Status = 'FORCED';
      sess.Note = [sess.Note, 'ปิดโดยผู้ดูแล: ' + clean_(note)].filter(String).join(' | ');
      saveSession_(sess);
    }
    setSettings_({ CurrentState: 'IDLE', CurrentSessionID: '' });
    logEvent_(now, sess ? sess.SessionID : '', 'RESET', 'รีเซ็ตสถานะเป็นพร้อมใช้งาน', '', clean_(note), user.name);
    return { message: 'รีเซ็ตสถานะเรียบร้อย', dashboard: buildDashboard_(user) };
  });
}

/* ======================= DASHBOARD ======================= */
function buildDashboard_(user) {
  const st = getSettings_(), now = Date.now(), pts = curvePoints_(st);
  const sessions = readAll_(SH.SESSIONS).map(parseSession_);
  const logs = readAll_(SH.FUEL);
  const events = readAll_(SH.EVENTS).sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const cap = num_(st.TankCapacity, 600);
  const state = st.CurrentState || 'IDLE';
  const fuel = fuelLevel_(st, sessions, logs, pts, now);

  let current = null;
  const cs = state !== 'IDLE' ? sessions.find(s => s.SessionID === st.CurrentSessionID) : null;
  if (cs) {
    const last = cs.segs[cs.segs.length - 1];
    const c = calcSegments_(cs.segs, now, pts);
    current = {
      id: cs.SessionID, type: cs.Type, typeLabel: TYPE_LABEL[cs.Type],
      outageStart: toMs_(cs.OutageStart), genStart: toMs_(cs.GenStart), loadStart: toMs_(cs.LoadStart),
      mainsRestored: toMs_(cs.MainsRestored), runHours: round_(c.hours, 2), fuelUsed: round_(c.fuel, 1),
      load: last ? last.load : null, rate: last ? round_(rateAt_(last.load, pts), 2) : 0,
      events: events.filter(e => e.SessionID === cs.SessionID).map(evOut_)
    };
  }

  const planLoad = (state === 'SUPPLYING' && current && current.load > 0) ? current.load : num_(st.DefaultLoadPct, 50);
  const planRate = rateAt_(planLoad, pts);
  const pct = cap ? fuel.level / cap * 100 : 0;
  const hoursLeft = planRate ? fuel.level / planRate : 0;

  const alerts = [];
  let fuelStatus = 'ok';
  if (pct < num_(st.CriticalPct, 25) || hoursLeft < num_(st.CriticalHours, 4)) {
    fuelStatus = 'critical';
    alerts.push({ lv: 'critical', msg: 'น้ำมันเหลือ ' + round_(fuel.level, 0) + ' ลิตร (เดินต่อได้ ~' + round_(hoursLeft, 1) + ' ชม.) ควรเติมทันที' });
  } else if (pct < num_(st.WarnPct, 50)) {
    fuelStatus = 'warn';
    alerts.push({ lv: 'warn', msg: 'น้ำมันต่ำกว่า ' + st.WarnPct + '% ของถัง ควรวางแผนเติม' });
  }

  const warmups = sessions.filter(s => s.Type === 'WARMUP');
  const lastWarm = warmups.reduce((m, s) => Math.max(m, s.startMs || 0), 0);
  const weekWarm = warmups.filter(s => s.startMs >= now - 7 * DAY).length;
  if (!lastWarm) alerts.push({ lv: 'warn', msg: 'ยังไม่มีบันทึกการวอร์มเครื่อง' });
  else if (now - lastWarm > 7 * DAY)
    alerts.push({ lv: 'warn', msg: 'ไม่ได้วอร์มเครื่องมาแล้ว ' + Math.floor((now - lastWarm) / DAY) + ' วัน (เป้าหมาย ' + st.WarmupPerWeek + ' ครั้ง/สัปดาห์)' });

  const measures = logs.filter(l => l.Type === 'MEASURE').sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const lastM = measures[measures.length - 1];
  if (lastM && Math.abs(num_(lastM.DiffPct, 0)) > num_(st.DiffAlertPct, 5))
    alerts.push({ lv: 'warn', msg: 'การตรวจวัดล่าสุดต่างจากยอดคำนวณ ' + lastM.DiffL + ' ลิตร (' + lastM.DiffPct + '%) ควรตรวจสอบการรั่วซึม/การบันทึก' });
  if (fuel.baseTime && now - fuel.baseTime > 30 * DAY)
    alerts.push({ lv: 'info', msg: 'ไม่ได้ตรวจวัดระดับน้ำมันจริงเกิน 30 วัน ควรตรวจวัดเพื่อปรับยอด' });
  if (state === 'COOLDOWN') alerts.push({ lv: 'info', msg: 'ไฟหลักกลับมาแล้ว อย่าลืมกด "หยุดเครื่อง" เมื่อดับเครื่อง' });

  const refills = logs.filter(l => l.Type === 'REFILL').sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const lr = refills[refills.length - 1];
  const fuelHist = logs.slice().sort((a, b) => toMs_(b.Timestamp) - toMs_(a.Timestamp)).slice(0, 20).map(fuelOut_);

  return {
    user: user, serverTime: now,
    gen: { id: st.GeneratorID, name: String(st.GeneratorName), location: String(st.Location || ''), kva: st.RatedKVA,
           kw: num_(st.RatedKW, 200), fuelType: String(st.FuelType || 'ดีเซล'), cap: cap },
    state: state, stateLabel: STATE_LABEL[state],
    actions: Object.keys(ACTIONS).filter(a => ACTIONS[a].from.indexOf(state) >= 0),
    current: current,
    fuel: {
      level: round_(fuel.level, 1), pct: round_(pct, 1), status: fuelStatus, planLoad: planLoad,
      planRate: round_(planRate, 2), hoursLeft: round_(hoursLeft, 1),
      hoursLeftFull: round_(fuel.level / rateAt_(100, pts), 1),
      baseTime: fuel.baseTime, baseLevel: fuel.baseLevel,
      lastRefill: lr ? { t: toMs_(lr.Timestamp), liters: num_(lr.Liters, 0) } : null
    },
    month: summarize_(sessions, logs, events, monthStart_(now), now, pts),
    warm: { week: weekWarm, target: num_(st.WarmupPerWeek, 2), last: lastWarm || null, minutes: num_(st.WarmupMinutes, 15) },
    alerts: alerts, curve: pts, defaultLoad: num_(st.DefaultLoadPct, 50),
    recent: events.slice(-12).reverse().map(evOut_),
    fuelHistory: fuelHist
  };
}

/* ======================= FUEL CALC ======================= */
function curvePoints_(st) {
  const pts = [{ l: 0, r: num_(st.IdleRate, 15) }];
  readAll_(SH.CURVE).forEach(c => pts.push({ l: num_(c.LoadPct, 0), r: num_(c.RateUsed, 0) }));
  return pts.sort((a, b) => a.l - b.l);
}

function rateAt_(load, pts) {
  load = Math.max(0, Math.min(100, Number(load) || 0));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (load >= a.l && load <= b.l) return b.l === a.l ? a.r : a.r + (load - a.l) * (b.r - a.r) / (b.l - a.l);
  }
  return pts[pts.length - 1].r;
}

function calcSegments_(segs, endMs, pts, fromMs) {
  fromMs = fromMs || 0;
  let fuel = 0, hours = 0, loadHours = 0, w = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = Math.max(segs[i].t, fromMs);
    const b = Math.min(i < segs.length - 1 ? segs[i + 1].t : endMs, endMs);
    const h = Math.max(0, (b - a) / 3.6e6);
    fuel += h * rateAt_(segs[i].load, pts);
    hours += h;
    if (segs[i].load > 0) { loadHours += h; w += h * segs[i].load; }
  }
  return { fuel: fuel, hours: hours, loadHours: loadHours, avgLoad: loadHours ? w / loadHours : 0 };
}

// ยอดคงถัง = ค่าวัดจริงล่าสุด + เติมหลังจากนั้น − ใช้หลังจากนั้น
function fuelLevel_(st, sessions, logs, pts, atMs) {
  let base = { t: -1, level: 0 };
  logs.forEach(l => {
    if (l.Type !== 'MEASURE') return;
    const t = toMs_(l.Timestamp);
    if (t <= atMs && t >= base.t) base = { t: t, level: num_(l.MeasuredLevel, 0) };
  });
  let refilled = 0, used = 0;
  logs.forEach(l => {
    if (l.Type !== 'REFILL') return;
    const t = toMs_(l.Timestamp);
    if (t > base.t && t <= atMs) refilled += num_(l.Liters, 0);
  });
  sessions.forEach(s => {
    if (!s.segs.length || s.segs[0].t > atMs) return;
    const stop = toMs_(s.GenStop);
    if (s.Status !== 'OPEN' && stop && stop <= atMs && s.segs[0].t >= base.t && s.FuelUsedL !== '')
      used += num_(s.FuelUsedL, 0);
    else used += calcSegments_(s.segs, Math.min(stop || atMs, atMs), pts, base.t).fuel;
  });
  const level = base.level + refilled - used;
  return { level: Math.max(0, level), baseTime: base.t > 0 ? base.t : null, baseLevel: base.level, refilled: refilled, used: used };
}

function measureInternal_(t, measured, note, user, st, pts, cap) {
  if (isNaN(measured) || measured < 0 || measured > cap * 1.1)
    throw new Error('ระดับน้ำมันที่วัดได้ไม่ถูกต้อง (0–' + cap + ' ลิตร)');
  const calc = fuelLevel_(st, readAll_(SH.SESSIONS).map(parseSession_), readAll_(SH.FUEL), pts, t).level;
  const diff = measured - calc, diffPct = cap ? diff / cap * 100 : 0;
  appendRow_(SH.FUEL, {
    FuelID: genId_('MSR'), Timestamp: new Date(t), Type: 'MEASURE', CalcLevel: round_(calc, 1),
    MeasuredLevel: measured, DiffL: round_(diff, 1), DiffPct: round_(diffPct, 2), LevelAfter: measured,
    Inspector: user.name, Note: note
  });
  logEvent_(t, '', 'MEASURE', 'ตรวจวัดระดับน้ำมัน', '',
    'วัดได้ ' + measured + ' ล. (คำนวณ ' + round_(calc, 1) + ' ล. ต่าง ' + round_(diff, 1) + ' ล.)', user.name);
  const warning = Math.abs(diffPct) > num_(st.DiffAlertPct, 5)
    ? 'ผลต่าง ' + round_(diff, 1) + ' ลิตร (' + round_(diffPct, 1) + '% ของถัง) เกินเกณฑ์ ควรตรวจสอบการรั่วซึมหรือการบันทึก' : '';
  return { calc: calc, diff: diff, diffPct: diffPct, warning: warning };
}

/* ======================= SESSIONS ======================= */
function newSession_(type, operator, note) {
  const o = {};
  HEADERS.Sessions.forEach(h => o[h] = '');
  o.SessionID = genId_(type === 'OUTAGE' ? 'OUT' : 'WRM');
  o.Type = type; o.Status = 'OPEN'; o.Operator = operator; o.Note = note; o.segs = [];
  return o;
}

function parseSession_(r) {
  try { r.segs = r.Segments ? JSON.parse(r.Segments) : []; } catch (e) { r.segs = []; }
  r.startMs = toMs_(r.OutageStart) || toMs_(r.GenStart) || 0;
  return r;
}

function getSession_(id) {
  const r = readAll_(SH.SESSIONS).find(x => x.SessionID === id);
  return r ? parseSession_(r) : null;
}

function saveSession_(s) {
  s.Segments = JSON.stringify(s.segs);
  if (s._row) updateRow_(SH.SESSIONS, s._row, s);
  else appendRow_(SH.SESSIONS, s);
}

function closeSession_(s, t, pts, hm) {
  const os = toMs_(s.OutageStart);
  if (os && (s.OutageMin === '' || s.OutageMin == null)) {
    // หยุดเครื่องโดยไม่ได้กด "ไฟหลักกลับมา" → นับไฟดับถึงเวลาหยุดเครื่อง
    s.OutageMin = round_(Math.max(0, (toMs_(s.MainsRestored) || t) - os) / 60000, 1);
    if (!s.MainsRestored) s.Note = [s.Note, 'ไม่ได้บันทึกไฟหลักกลับ — นับไฟดับถึงเวลาหยุดเครื่อง'].filter(String).join(' | ');
  }
  if (s.segs.length) {
    const c = calcSegments_(s.segs, t, pts);
    s.GenStop = new Date(t);
    s.RunHours = round_(c.hours, 3);
    s.LoadHours = round_(c.loadHours, 3);
    s.AvgLoadPct = round_(c.avgLoad, 1);
    s.FuelUsedL = round_(c.fuel, 2);
    s.HourMeterEnd = hm;
  } else {
    s.RunHours = 0; s.LoadHours = 0; s.FuelUsedL = 0;
  }
  s.Status = 'CLOSED';
}

function lastTime_(s) {
  const ts = ['OutageStart', 'GenStart', 'LoadStart', 'MainsRestored'].map(k => toMs_(s[k]) || 0);
  s.segs.forEach(x => ts.push(x.t));
  return Math.max.apply(null, ts);
}

function sessionMetrics_(s, pts, now) {
  if (s.Status !== 'OPEN') return {
    runHours: num_(s.RunHours, 0), loadHours: num_(s.LoadHours, 0), fuel: num_(s.FuelUsedL, 0),
    avgLoad: num_(s.AvgLoadPct, 0), outageMin: num_(s.OutageMin, 0)
  };
  const c = calcSegments_(s.segs, now, pts);
  const os = toMs_(s.OutageStart);
  return {
    runHours: c.hours, loadHours: c.loadHours, fuel: c.fuel, avgLoad: c.avgLoad,
    outageMin: s.OutageMin !== '' ? num_(s.OutageMin, 0) : (os ? (now - os) / 60000 : 0)
  };
}

function summarize_(sessions, logs, events, from, to, pts) {
  const now = Date.now();
  const r = { outages: 0, outageMin: 0, warmups: 0, runHours: 0, loadHours: 0, fuelUsed: 0,
              refills: 0, refillL: 0, refillCost: 0, measures: 0, faults: 0 };
  sessions.forEach(s => {
    if (!inRange_(s.startMs, from, to)) return;
    const m = sessionMetrics_(s, pts, now);
    if (s.Type === 'OUTAGE') { r.outages++; r.outageMin += m.outageMin; } else r.warmups++;
    r.runHours += m.runHours; r.loadHours += m.loadHours; r.fuelUsed += m.fuel;
  });
  logs.forEach(l => {
    if (!inRange_(toMs_(l.Timestamp), from, to)) return;
    if (l.Type === 'REFILL') { r.refills++; r.refillL += num_(l.Liters, 0); r.refillCost += num_(l.TotalCost, 0); }
    else r.measures++;
  });
  events.forEach(e => { if (e.EventType === 'FAULT' && inRange_(toMs_(e.Timestamp), from, to)) r.faults++; });
  ['outageMin', 'runHours', 'loadHours', 'fuelUsed', 'refillL', 'refillCost'].forEach(k => r[k] = round_(r[k], 2));
  return r;
}

/* ======================= OUTPUT MAPPERS ======================= */
function evOut_(e) {
  return { t: toMs_(e.Timestamp), type: String(e.EventType), label: String(e.EventLabel),
           load: e.LoadPct === '' ? null : Number(e.LoadPct), detail: String(e.Detail || ''),
           user: String(e.User || ''), session: String(e.SessionID || '') };
}

function fuelOut_(l) {
  return { id: String(l.FuelID), t: toMs_(l.Timestamp), type: String(l.Type), typeLabel: FUEL_LABEL[l.Type] || l.Type,
           liters: num_(l.Liters, null), price: num_(l.PricePerL, null), cost: num_(l.TotalCost, null),
           calc: num_(l.CalcLevel, null), measured: num_(l.MeasuredLevel, null), diff: num_(l.DiffL, null),
           diffPct: num_(l.DiffPct, null), after: num_(l.LevelAfter, null),
           by: String(l.Inspector || ''), note: String(l.Note || '') };
}

function sessionOut_(s, pts, now) {
  const m = sessionMetrics_(s, pts, now);
  return {
    id: String(s.SessionID), type: s.Type, typeLabel: TYPE_LABEL[s.Type] || s.Type, status: String(s.Status),
    start: s.startMs, outageStart: toMs_(s.OutageStart), genStart: toMs_(s.GenStart), loadStart: toMs_(s.LoadStart),
    mainsRestored: toMs_(s.MainsRestored), genStop: toMs_(s.GenStop),
    outageMin: round_(m.outageMin, 1), runHours: round_(m.runHours, 2), loadHours: round_(m.loadHours, 2),
    avgLoad: round_(m.avgLoad, 0), fuel: round_(m.fuel, 1),
    hmStart: s.HourMeterStart === '' ? '' : Number(s.HourMeterStart),
    hmEnd: s.HourMeterEnd === '' ? '' : Number(s.HourMeterEnd),
    operator: String(s.Operator || ''), note: String(s.Note || '')
  };
}

/* ======================= SHEET HELPERS ======================= */
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบชีต "' + name + '" กรุณารันฟังก์ชัน setup');
  return sh;
}

function readAll_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const h = v.shift() || [];
  const out = [];
  v.forEach((r, i) => {
    if (r.join('') === '') return;
    const o = { _row: i + 2 };
    h.forEach((k, j) => o[k] = r[j]);
    out.push(o);
  });
  return out;
}

function appendRow_(name, obj) {
  sheet_(name).appendRow(HEADERS[name].map(k => obj[k] === undefined ? '' : obj[k]));
}

function updateRow_(name, row, obj) {
  const h = HEADERS[name];
  sheet_(name).getRange(row, 1, 1, h.length).setValues([h.map(k => obj[k] === undefined ? '' : obj[k])]);
}

function getSettings_() {
  const o = {};
  readAll_(SH.SETTINGS).forEach(r => o[r.Key] = r.Value);
  return o;
}

function setSettings_(map) {
  const sh = sheet_(SH.SETTINGS);
  const v = sh.getDataRange().getValues();
  Object.keys(map).forEach(k => {
    const i = v.findIndex(r => r[0] === k);
    if (i < 0) { sh.appendRow([k, map[k], '']); v.push([k, map[k], '']); }
    else sh.getRange(i + 1, 2).setValue(map[k]);
  });
}

function logEvent_(t, sid, type, label, load, detail, user) {
  appendRow_(SH.EVENTS, { EventID: genId_('EV'), Timestamp: new Date(t), SessionID: sid, EventType: type,
                          EventLabel: label, LoadPct: load, Detail: detail, User: user });
}

function writeTable_(ss, name, head, rows) {
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  styleHead_(sh, head.length);
  sh.autoResizeColumns(1, head.length);
}

function styleHead_(sh, n) {
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ระบบกำลังบันทึกข้อมูลอื่น กรุณาลองใหม่');
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

/* ======================= UTILS ======================= */
function toMs_(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function num_(v, d) { const n = Number(v); return (v === '' || v == null || isNaN(n)) ? d : n; }
function round_(n, d) { const p = Math.pow(10, d || 0); return Math.round((Number(n) || 0) * p) / p; }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function inRange_(t, a, b) { return t != null && t >= a && t <= b; }
function clampLoad_(v, def) {
  const n = (v === '' || v == null) ? Number(def) : Number(v);
  if (isNaN(n)) return 50;
  return Math.max(0, Math.min(110, Math.round(n)));
}
function clean_(s) {
  s = String(s == null ? '' : s).trim().slice(0, 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // กันสูตรแทรกใน Sheet
}
function parseTime_(v) {
  let s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s += ':00+07:00';
  const t = new Date(s).getTime();
  if (isNaN(t)) throw new Error('รูปแบบเวลาไม่ถูกต้อง');
  return t;
}
function dayStart_(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(str))) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  return new Date(str + 'T00:00:00+07:00').getTime();
}
function monthStart_(ms) {
  return new Date(Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM') + '-01T00:00:00+07:00').getTime();
}
function fmtTH_(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return Utilities.formatDate(d, TZ, 'dd/MM/') + (Number(Utilities.formatDate(d, TZ, 'yyyy')) + 543) +
         Utilities.formatDate(d, TZ, ' HH:mm');
}
function genId_(p) {
  return p + '-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss') + '-' +
         Math.random().toString(36).slice(2, 5).toUpperCase();
}