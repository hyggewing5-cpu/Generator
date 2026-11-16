/**************************************************************
 * GenLog — ระบบบันทึกการใช้งานเครื่องกำเนิดไฟฟ้า (รองรับหลายเครื่อง)
 * Backend : Google Apps Script | Database : Google Sheets
 * เริ่มต้น/อัปเกรด: เลือกฟังก์ชัน setup แล้วกด Run 1 ครั้ง
 *   - ติดตั้งใหม่: สร้างชีตและเครื่องแรก (GEN-01)
 *   - อัปเกรดจากเวอร์ชันเครื่องเดียว: ย้ายข้อมูลเดิมเข้า GEN-01 อัตโนมัติ
 **************************************************************/

const TZ = 'Asia/Bangkok';
const TOKEN_TTL = 6 * 60 * 60;   // อายุการล็อกอิน 6 ชม.
const DAY = 864e5;

const SH = { GENS: 'Generators', CURVE: 'FuelCurve', SESSIONS: 'Sessions',
             EVENTS: 'Events', FUEL: 'FuelLog', USERS: 'Users', LEGACY: 'Settings' };

const HEADERS = {
  Generators: ['GenID', 'Name', 'Location', 'RatedKVA', 'RatedKW', 'FuelType', 'TankCapacity', 'IdleRate',
               'DefaultLoadPct', 'WarnPct', 'CriticalPct', 'CriticalHours', 'DiffAlertPct', 'WarmupPerWeek',
               'WarmupMinutes', 'CurrentState', 'CurrentSessionID', 'Active', 'CreatedAt'],
  FuelCurve: ['LoadPct', 'RateMin', 'RateMax', 'RateUsed', 'SFC_g_kWh', 'GenID'],
  Sessions:  ['SessionID', 'Type', 'Status', 'OutageStart', 'GenStart', 'LoadStart', 'MainsRestored', 'GenStop',
              'OutageMin', 'RunHours', 'LoadHours', 'AvgLoadPct', 'FuelUsedL', 'HourMeterStart', 'HourMeterEnd',
              'Segments', 'Operator', 'Note', 'GenID'],
  Events:    ['EventID', 'Timestamp', 'SessionID', 'EventType', 'EventLabel', 'LoadPct', 'Detail', 'User', 'GenID'],
  FuelLog:   ['FuelID', 'Timestamp', 'Type', 'Liters', 'PricePerL', 'TotalCost', 'CalcLevel', 'MeasuredLevel',
              'DiffL', 'DiffPct', 'LevelAfter', 'Inspector', 'Note', 'GenID'],
  Users:     ['Name', 'PIN', 'Role', 'Active', 'Gens']   // Gens = รหัสเครื่องที่เห็น คั่นด้วย , (ว่างหรือ * = ทุกเครื่อง; admin เห็นทุกเครื่องเสมอ)
};

// ค่าเริ่มต้นของเครื่องใหม่ (ปรับได้ในหน้าตั้งค่า)
const GEN_DEFAULTS = {
  Location: '', RatedKVA: 250, RatedKW: 200, FuelType: 'ดีเซล', TankCapacity: 600, IdleRate: 15,
  DefaultLoadPct: 50, WarnPct: 50, CriticalPct: 25, CriticalHours: 4, DiffAlertPct: 5,
  WarmupPerWeek: 2, WarmupMinutes: 15
};

// ฟิลด์ที่ผู้ดูแลแก้ไขได้ [คีย์, ป้ายชื่อ, ชนิด]
const FIELDS = [
  ['Name', 'ชื่อเครื่อง', 'text'], ['Location', 'สถานที่ติดตั้ง', 'text'],
  ['RatedKVA', 'ขนาดเครื่อง (kVA)', 'num'], ['RatedKW', 'กำลังไฟฟ้า (kW) ที่ PF 0.8', 'num'],
  ['FuelType', 'ชนิดเชื้อเพลิง', 'text'], ['TankCapacity', 'ความจุถัง (ลิตร)', 'num'],
  ['IdleRate', 'อัตราสิ้นเปลืองขณะวอร์ม/เดินเปล่า (ลิตร/ชม.)', 'num'],
  ['DefaultLoadPct', 'โหลดเริ่มต้นเมื่อจ่ายไฟ (%)', 'num'],
  ['WarnPct', 'เตือนเหลือง เมื่อน้ำมันต่ำกว่า (% ถัง)', 'num'],
  ['CriticalPct', 'เตือนแดง เมื่อน้ำมันต่ำกว่า (% ถัง)', 'num'],
  ['CriticalHours', 'เตือนแดง เมื่อเดินต่อได้น้อยกว่า (ชม.)', 'num'],
  ['DiffAlertPct', 'เตือนเมื่อผลต่างวัดจริง-คำนวณ เกิน (% ถัง)', 'num'],
  ['WarmupPerWeek', 'เป้าหมายวอร์มเครื่องต่อสัปดาห์ (ครั้ง)', 'num'],
  ['WarmupMinutes', 'เวลาวอร์มที่แนะนำ (นาที)', 'num']
];

// อัตราสิ้นเปลืองตามเอกสาร 250 kVA — RateUsed ใช้ค่าสูงสุดเพื่อประมาณการแบบปลอดภัย
const DEFAULT_CURVE = [
  [25, 14.0, 15.0, 15.0, 244],
  [50, 25.5, 27.0, 27.0, 233],
  [75, 37.0, 39.0, 39.0, 217],
  [100, 49.0, 52.0, 52.0, 204]
];

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
// เปิดจาก Apps Script โดยตรง → แสดงหน้าเว็บ (ต้องมีไฟล์ HTML ชื่อ Index)
// เปิดแบบ ?api=1 หรือไม่มีไฟล์ Index → ตอบ JSON สถานะ (ใช้ตรวจว่า API ทำงาน)
function doGet(e) {
  const ping = () => json_({ ok: true, name: 'GenLog API', time: Date.now() });
  if (e && e.parameter && e.parameter.api) return ping();
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('GenLog')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  } catch (err) { return ping(); }
}

// ฟังก์ชันที่หน้าเว็บ (GitHub Pages) เรียกผ่าน fetch ได้ — ทุกตัวตรวจ token/สิทธิ์ภายในเอง (setup ไม่อยู่ในรายการ)
const API_FNS = {
  login: login, logout: logout, getDashboard: getDashboard, getOverview: getOverview,
  doAction: doAction, recordRefill: recordRefill, recordMeasure: recordMeasure,
  getReport: getReport, exportReport: exportReport,
  getAdminSettings: getAdminSettings, saveAdminSettings: saveAdminSettings, forceReset: forceReset,
  addGenerator: addGenerator, setGeneratorActive: setGeneratorActive
};

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!Object.prototype.hasOwnProperty.call(API_FNS, req.fn)) throw new Error('ไม่รู้จักคำสั่งนี้');
    const data = API_FNS[req.fn].apply(null, Array.isArray(req.args) ? req.args : []);
    return json_({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('GenLog')
    .addItem('ติดตั้ง / อัปเกรดโครงสร้างชีต', 'setup')
    .addItem('ตรวจความปลอดภัยของ PIN', 'auditUsers').addToUi();
}

function setup() {
  // กันเรียกจากหน้าเว็บโดยผู้ใช้อื่น: ถ้าระบุตัวตนได้ ต้องเป็นเจ้าของสคริปต์เท่านั้น
  const who = Session.getActiveUser().getEmail(), owner = Session.getEffectiveUser().getEmail();
  if (who && owner && who !== owner) throw new Error('เฉพาะเจ้าของสคริปต์เท่านั้นที่ติดตั้งได้');
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  const legacy = ss.getSheetByName(SH.LEGACY);          // ชีต Settings จากเวอร์ชันเครื่องเดียว (ถ้ามี)

  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]])
        .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    } else ensureColumns_(sh, HEADERS[name]);
  });
  SpreadsheetApp.flush();

  // --- ทะเบียนเครื่อง: ย้ายค่าจากชีต Settings เดิม (ถ้ามี) เป็นเครื่องแรก ---
  if (sheet_(SH.GENS).getLastRow() < 2) {
    const old = {};
    if (legacy && legacy.getLastRow() > 1)
      legacy.getDataRange().getValues().slice(1).forEach(r => { if (r[0] !== '') old[r[0]] = r[1]; });
    const row = {
      GenID: String(old.GeneratorID || 'GEN-01'),
      Name: old.GeneratorName || 'เครื่องกำเนิดไฟฟ้า 250 kVA',
      CurrentState: ALL_STATES.indexOf(old.CurrentState) >= 0 ? old.CurrentState : 'IDLE',
      CurrentSessionID: old.CurrentSessionID || '', Active: true, CreatedAt: new Date()
    };
    Object.keys(GEN_DEFAULTS).forEach(k => row[k] = (old[k] !== undefined && old[k] !== '') ? old[k] : GEN_DEFAULTS[k]);
    appendRow_(SH.GENS, row);
    if (legacy) { try { legacy.setName('Settings_legacy'); } catch (e) {} }   // เก็บไว้เป็นสำรอง ไม่ใช้งานแล้ว
  }
  const defId = String(readAll_(SH.GENS)[0].GenID);

  // --- เติมรหัสเครื่องให้ข้อมูลเดิมที่ยังไม่มี GenID ---
  [SH.CURVE, SH.SESSIONS, SH.EVENTS, SH.FUEL].forEach(n => backfillGenId_(sheet_(n), defId));

  const cur = sheet_(SH.CURVE);
  if (cur.getLastRow() < 2) DEFAULT_CURVE.forEach(c => appendRow_(SH.CURVE, {
    LoadPct: c[0], RateMin: c[1], RateMax: c[2], RateUsed: c[3], SFC_g_kWh: c[4], GenID: defId }));

  const us = sheet_(SH.USERS);
  us.getRange('B:B').setNumberFormat('@');
  if (us.getLastRow() < 2) us.getRange(2, 1, 3, 4).setValues([
    ['ผู้ดูแลระบบ', '482913', 'admin', true],
    ['พลขับเครื่อง', '715204', 'operator', true],
    ['ผู้บังคับบัญชา', '639871', 'viewer', true]
  ]);

  const fl = sheet_(SH.FUEL);
  if (fl.getLastRow() < 2) {
    const initCap = num_(readAll_(SH.GENS)[0].TankCapacity, 600);
    appendRow_(SH.FUEL, {
      FuelID: genId_('MSR'), Timestamp: new Date(), Type: 'MEASURE', CalcLevel: initCap, MeasuredLevel: initCap,
      DiffL: 0, DiffPct: 0, LevelAfter: initCap, Inspector: 'ตั้งค่าเริ่มต้น', GenID: defId,
      Note: 'ยอดน้ำมันเริ่มต้น — แก้ MeasuredLevel/LevelAfter ให้ตรงระดับจริง'
    });
  }

  sheet_(SH.SESSIONS).getRange('D:H').setNumberFormat('dd/MM/yyyy HH:mm');
  sheet_(SH.EVENTS).getRange('B:B').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  fl.getRange('B:B').setNumberFormat('dd/MM/yyyy HH:mm');
  sheet_(SH.GENS).getRange('S:S').setNumberFormat('dd/MM/yyyy HH:mm');

  ['Sheet1', 'แผ่น1', 'ชีต1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
}

// เพิ่มคอลัมน์ที่ขาดไว้ท้ายหัวตาราง (ใช้ตอนอัปเกรด)
function ensureColumns_(sh, want) {
  const h = headerOf_(sh);
  const missing = want.filter(k => h.indexOf(k) < 0);
  if (!missing.length) return;
  let end = h.length; while (end > 0 && h[end - 1] === '') end--;
  sh.getRange(1, end + 1, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
}

function backfillGenId_(sh, gid) {
  const lr = sh.getLastRow();
  if (lr < 2) return;
  const c = headerOf_(sh).indexOf('GenID');
  if (c < 0) return;
  const v = sh.getDataRange().getValues();
  let changed = false;
  const col = [];
  for (let i = 1; i < v.length; i++) {
    let x = v[i][c];
    if (v[i].join('') !== '' && x === '') { x = gid; changed = true; }   // ข้ามแถวว่าง
    col.push([x]);
  }
  if (changed) sh.getRange(2, c + 1, col.length, 1).setValues(col);
}

/* ======================= AUTH ======================= */
const LOGIN_DEV_MAX = 5;      // ใส่ PIN ผิดได้กี่ครั้งต่ออุปกรณ์ ภายใน 10 นาที
const LOGIN_ALL_MAX = 40;     // ผิดรวมทุกอุปกรณ์เกินนี้ → ล็อกเฉพาะอุปกรณ์ที่ยังไม่เคยเข้าระบบสำเร็จ
const TRUST_DAYS = 30;        // อุปกรณ์ที่เคยเข้าระบบสำเร็จ ถือว่าเชื่อถือได้กี่วัน
const DEFAULT_PINS = ['482913', '715204', '639871'];

function login(pin, deviceId) {
  const cache = CacheService.getScriptCache();
  const dev = /^[A-Za-z0-9-]{8,64}$/.test(String(deviceId || '')) ? String(deviceId) : '';
  const dk = 'fail_d_' + (dev ? dev.replace(/-/g, '').slice(0, 20) : 'anon');
  const devFails = Number(cache.get(dk) || 0), allFails = Number(cache.get('fail_all') || 0);
  if (devFails >= LOGIN_DEV_MAX) throw new Error('ใส่ PIN ผิดหลายครั้ง กรุณารอ 10 นาที');
  if (allFails >= LOGIN_ALL_MAX && !isTrusted_(dev))
    throw new Error('ระบบล็อกการเข้าสู่ระบบชั่วคราว (มีการใส่ PIN ผิดจำนวนมาก) กรุณารอ 10 นาที หรือใช้เครื่องที่เคยเข้าสู่ระบบแล้ว');
  pin = String(pin || '').trim();
  const matches = readAll_(SH.USERS).filter(r => String(r.PIN).trim() === pin && isTrue_(r.Active));
  if (matches.length > 1) throw new Error('PIN ซ้ำกับผู้ใช้อื่น กรุณาแจ้งผู้ดูแลให้เปลี่ยน PIN');
  const u = matches[0];
  if (!pin || !u) {
    cache.put(dk, String(devFails + 1), 600);
    cache.put('fail_all', String(allFails + 1), 600);
    Utilities.sleep(1500);                      // หน่วงเวลา ทำให้เดา PIN ช้าลง
    throw new Error('PIN ไม่ถูกต้อง');
  }
  cache.remove(dk);
  trustDevice_(dev);
  const gs = String(u.Gens == null ? '' : u.Gens).split(/[,\s;]+/).map(x => x.trim().toUpperCase()).filter(String);
  const user = { name: String(u.Name), role: String(u.Role).toLowerCase(),
                 gens: (!gs.length || gs.indexOf('*') >= 0) ? null : gs };   // null = ทุกเครื่อง
  const token = Utilities.getUuid();
  cache.put('tok_' + token, JSON.stringify(user), TOKEN_TTL);
  const warn = [];
  if (user.role === 'admin') {
    const bad = readAll_(SH.USERS).filter(r => isTrue_(r.Active) && DEFAULT_PINS.indexOf(String(r.PIN).trim()) >= 0);
    if (bad.length) warn.push('ยังมี ' + bad.length + ' บัญชีที่ใช้ PIN เริ่มต้น (' + bad.map(r => r.Name).join(', ') + ') กรุณาเปลี่ยนในชีต Users ทันที');
  }
  return { token: token, user: user, warn: warn };
}

// อุปกรณ์ที่เคยเข้าสู่ระบบสำเร็จ — เก็บใน Script Properties (ไม่เก็บ PIN)
function trustKey_(dev) { return dev ? dev.replace(/-/g, '').slice(0, 12) : ''; }
function trustMap_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('trusted_devices') || '{}'); }
  catch (e) { return {}; }
}
function isTrusted_(dev) {
  const t = dev && trustMap_()[trustKey_(dev)];
  return !!t && Date.now() / 1000 - t < TRUST_DAYS * 86400;
}
function trustDevice_(dev) {
  if (!dev) return;
  const m = trustMap_(), now = Math.floor(Date.now() / 1000), k = trustKey_(dev);
  if (m[k] && now - m[k] < 86400) return;       // เพิ่งบันทึกไปไม่ถึงวัน ไม่ต้องเขียนซ้ำ
  m[k] = now;
  Object.keys(m).forEach(x => { if (now - m[x] > TRUST_DAYS * 86400) delete m[x]; });
  Object.keys(m).sort((a, b) => m[b] - m[a]).slice(200).forEach(x => delete m[x]);
  PropertiesService.getScriptProperties().setProperty('trusted_devices', JSON.stringify(m));
}

// ตรวจความปลอดภัยของบัญชีผู้ใช้ (เมนู GenLog → ตรวจความปลอดภัยของ PIN)
function auditUsers() {
  const us = readAll_(SH.USERS).filter(r => isTrue_(r.Active)), seen = {}, out = [];
  us.forEach(r => {
    const p = String(r.PIN).trim(), n = String(r.Name);
    if (DEFAULT_PINS.indexOf(p) >= 0) out.push('• ' + n + ': ใช้ PIN เริ่มต้น');
    else if (!/^\d{6,8}$/.test(p)) out.push('• ' + n + ': PIN ควรเป็นตัวเลข 6–8 หลัก');
    else if (/^(\d)\1+$/.test(p) || '01234567890'.indexOf(p) >= 0 || '98765432109'.indexOf(p) >= 0) out.push('• ' + n + ': PIN เดาง่าย (เลขซ้ำ/เรียงกัน)');
    (seen[p] = seen[p] || []).push(n);
  });
  Object.keys(seen).forEach(p => { if (seen[p].length > 1) out.push('• PIN ซ้ำกัน: ' + seen[p].join(', ')); });
  const msg = out.length ? out.join('\n') : 'ไม่พบปัญหา';
  try { SpreadsheetApp.getUi().alert('ตรวจความปลอดภัยของ PIN', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
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

/* ======================= GENERATORS ======================= */
function genRows_() { return readAll_(SH.GENS); }
function canSee_(user, gid) {
  return !user || user.role === 'admin' || !user.gens || user.gens.indexOf(String(gid).toUpperCase()) >= 0;
}
function byGen_(rows, gid) { return rows.filter(r => String(r.GenID) === String(gid)); }

// mode: 'active' = ต้องมีและเปิดใช้งาน (ใช้กับการบันทึก) · 'any' = มีอยู่ก็พอ · ไม่ระบุ = ถ้าไม่พบให้ใช้เครื่องแรกที่เปิดใช้งาน
function resolveGen_(genId, mode, user) {
  const rows = genRows_().filter(g => canSee_(user, g.GenID));
  if (genId && genId !== 'ALL') {
    const g = rows.find(x => String(x.GenID) === String(genId));
    if (g && (mode === 'any' || isTrue_(g.Active))) return g;
    if (mode) throw new Error('ไม่พบเครื่องกำเนิดไฟฟ้านี้ ถูกปิดใช้งาน หรือบัญชีนี้ไม่มีสิทธิ์ใช้เครื่องนี้');
  } else if (mode) throw new Error('กรุณาเลือกเครื่องกำเนิดไฟฟ้า');
  const first = rows.find(x => isTrue_(x.Active));
  if (!first) throw new Error('ยังไม่มีเครื่องที่เปิดใช้งานและได้รับสิทธิ์สำหรับบัญชีนี้ กรุณาแจ้งผู้ดูแล');
  return first;
}

function genList_(rows, user) {
  return (rows || genRows_()).filter(g => canSee_(user, g.GenID)).map(g => {
    const state = ALL_STATES.indexOf(g.CurrentState) >= 0 ? g.CurrentState : 'IDLE';
    return { id: String(g.GenID), name: String(g.Name), location: String(g.Location || ''),
             kva: num_(g.RatedKVA, 0), kw: num_(g.RatedKW, 0), fuelType: String(g.FuelType || 'ดีเซล'),
             cap: num_(g.TankCapacity, 0), idleRate: num_(g.IdleRate, 0), active: isTrue_(g.Active),
             state: state, stateLabel: STATE_LABEL[state] };
  });
}

function setGen_(gid, map) {
  const sh = sheet_(SH.GENS), h = headerOf_(sh);
  const g = readAll_(SH.GENS).find(x => String(x.GenID) === String(gid));
  if (!g) throw new Error('ไม่พบเครื่อง ' + gid);
  Object.keys(map).forEach(k => {
    const c = h.indexOf(k);
    if (c >= 0) sh.getRange(g._row, c + 1).setValue(map[k]);
  });
}

function addGenerator(token, d) {
  const user = auth_(token, ['admin']);
  d = d || {};
  return withLock_(() => {
    const rows = genRows_();
    const name = clean_(d.name).slice(0, 100);
    if (!name) throw new Error('กรุณาระบุชื่อเครื่อง');
    const kva = Number(d.kva);
    if (!(kva > 0)) throw new Error('ขนาดเครื่อง (kVA) ไม่ถูกต้อง');
    const kw = (d.kw === '' || d.kw == null) ? round_(kva * 0.8, 1) : Number(d.kw);
    if (!(kw > 0)) throw new Error('กำลังไฟฟ้า (kW) ไม่ถูกต้อง');
    const cap = Number(d.tank);
    if (!(cap > 0)) throw new Error('ความจุถังต้องมากกว่า 0');
    const idle = (d.idleRate === '' || d.idleRate == null) ? round_(GEN_DEFAULTS.IdleRate * kva / 250, 1) : Number(d.idleRate);
    if (isNaN(idle) || idle < 0) throw new Error('อัตราสิ้นเปลืองเดินเปล่าไม่ถูกต้อง');
    const init = (d.initLevel === '' || d.initLevel == null) ? cap : Number(d.initLevel);
    if (isNaN(init) || init < 0 || init > cap * 1.1) throw new Error('ระดับน้ำมันเริ่มต้นไม่ถูกต้อง (0–' + cap + ' ลิตร)');

    const exists = id => rows.some(r => String(r.GenID).toUpperCase() === String(id).toUpperCase());
    let id = String(d.id || '').trim().toUpperCase();
    if (id) {
      if (!/^[A-Z0-9_-]{2,20}$/.test(id)) throw new Error('รหัสเครื่องใช้ได้เฉพาะ A-Z 0-9 - _ (2–20 ตัวอักษร)');
      if (exists(id)) throw new Error('รหัสเครื่อง "' + id + '" ซ้ำกับที่มีอยู่');
    } else {
      let n = rows.reduce((m, r) => { const x = /^GEN-(\d+)$/i.exec(String(r.GenID)); return x ? Math.max(m, +x[1]) : m; }, 0) + 1;
      do { id = 'GEN-' + String(n).padStart(2, '0'); n++; } while (exists(id));
    }

    // อัตราสิ้นเปลืองตามโหลด: คัดลอกจากเครื่องที่เลือก (หรือค่ามาตรฐาน) และปรับสัดส่วนตาม kVA ถ้าเลือก
    const src = d.curveFrom ? rows.find(r => String(r.GenID) === String(d.curveFrom)) : null;
    let base = DEFAULT_CURVE.map(c => ({ l: c[0], min: c[1], max: c[2], used: c[3], sfc: c[4] })), baseKva = 250;
    if (src) {
      const sc = byGen_(readAll_(SH.CURVE), src.GenID);
      if (sc.length) {
        base = sc.map(c => ({ l: c.LoadPct, min: c.RateMin, max: c.RateMax, used: c.RateUsed, sfc: c.SFC_g_kWh }));
        baseKva = num_(src.RatedKVA, 250) || 250;
      }
    }
    const k = (d.scale === false || d.scale === 'false') ? 1 : kva / baseKva;
    base.forEach(c => appendRow_(SH.CURVE, {
      LoadPct: c.l, RateMin: round_(num_(c.min, 0) * k, 1), RateMax: round_(num_(c.max, 0) * k, 1),
      RateUsed: round_(num_(c.used, 0) * k, 1), SFC_g_kWh: c.sfc, GenID: id }));

    const row = { GenID: id, Name: name, CurrentState: 'IDLE', CurrentSessionID: '', Active: true, CreatedAt: new Date() };
    Object.keys(GEN_DEFAULTS).forEach(key => row[key] = GEN_DEFAULTS[key]);
    row.Location = clean_(d.location).slice(0, 100);
    row.RatedKVA = kva; row.RatedKW = kw; row.TankCapacity = cap; row.IdleRate = idle;
    row.FuelType = clean_(d.fuelType).slice(0, 30) || GEN_DEFAULTS.FuelType;
    appendRow_(SH.GENS, row);

    appendRow_(SH.FUEL, { FuelID: genId_('MSR'), Timestamp: new Date(), Type: 'MEASURE', CalcLevel: init,
      MeasuredLevel: init, DiffL: 0, DiffPct: 0, LevelAfter: init, Inspector: user.name, GenID: id,
      Note: 'ยอดน้ำมันเริ่มต้นเมื่อเพิ่มเครื่อง' });
    logEvent_(id, Date.now(), '', 'GEN_ADD', 'เพิ่มเครื่องกำเนิดไฟฟ้า', '', name + ' ' + kva + ' kVA', user.name);
    return { message: 'เพิ่มเครื่อง ' + id + ' เรียบร้อย กรุณาตรวจสอบตารางอัตราสิ้นเปลืองในหน้าตั้งค่า', genId: id, gens: genList_() };
  });
}

function setGeneratorActive(token, genId, active) {
  const user = auth_(token, ['admin']);
  return withLock_(() => {
    const g = resolveGen_(genId, 'any');
    active = (active === true || active === 'true');
    if (!active) {
      if ((g.CurrentState || 'IDLE') !== 'IDLE') throw new Error('เครื่องกำลังทำงานอยู่ ต้องหยุดเครื่อง/รีเซ็ตสถานะก่อนปิดใช้งาน');
      if (genRows_().filter(x => isTrue_(x.Active) && String(x.GenID) !== String(g.GenID)).length < 1)
        throw new Error('ต้องมีเครื่องที่เปิดใช้งานอย่างน้อย 1 เครื่อง');
    }
    setGen_(g.GenID, { Active: active });
    logEvent_(g.GenID, Date.now(), '', 'GEN_ACTIVE', active ? 'เปิดใช้งานเครื่อง' : 'ปิดใช้งานเครื่อง', '', String(g.Name), user.name);
    return { message: (active ? 'เปิดใช้งาน ' : 'ปิดใช้งาน ') + g.GenID + ' แล้ว', gens: genList_() };
  });
}

/* ======================= PUBLIC API ======================= */
function getDashboard(token, genId) {
  return buildDashboard_(auth_(token), genId);
}

function doAction(token, genId, action, p) {
  const user = auth_(token, ['admin', 'operator']);
  const def = ACTIONS[action];
  if (!def) throw new Error('ไม่รู้จักคำสั่งนี้');
  p = p || {};
  return withLock_(() => {
    const st = resolveGen_(genId, 'active', user), gid = String(st.GenID);
    const state = ALL_STATES.indexOf(st.CurrentState) >= 0 ? st.CurrentState : 'IDLE';
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
    if (sess && String(sess.GenID) !== gid) sess = null;
    if (state !== 'IDLE' && !sess && action !== 'FAULT')
      throw new Error('ไม่พบรอบการทำงานปัจจุบัน ให้ผู้ดูแลกด "รีเซ็ตสถานะ" ในหน้าตั้งค่า');
    if (sess && action !== 'FAULT' && t < lastTime_(sess))
      throw new Error('เวลาต้องไม่ก่อนรายการล่าสุดของรอบนี้ (' + fmtTH_(lastTime_(sess)) + ')');

    let next = state, evLoad = '';
    switch (action) {
      case 'OUTAGE_START':
        sess = newSession_('OUTAGE', user.name, note, gid);
        sess.OutageStart = new Date(t);
        next = 'OUTAGE'; break;
      case 'WARMUP_START':
        sess = newSession_('WARMUP', user.name, note, gid);
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
    logEvent_(gid, t, sess ? sess.SessionID : '', action, def.label, evLoad, detail, user.name);
    setGen_(gid, { CurrentState: next, CurrentSessionID: next === 'IDLE' ? '' : (sess ? sess.SessionID : st.CurrentSessionID) });
    return { message: 'บันทึก "' + def.label + '" เรียบร้อย (' + st.Name + ')', dashboard: buildDashboard_(user, gid) };
  });
}

function recordRefill(token, genId, p) {
  const user = auth_(token, ['admin', 'operator']);
  p = p || {};
  const liters = Number(p.liters);
  if (!(liters > 0) || liters > 10000) throw new Error('กรุณาระบุปริมาณที่เติมให้ถูกต้อง');
  const price = (p.price === '' || p.price == null) ? '' : Number(p.price);
  if (price !== '' && (isNaN(price) || price < 0)) throw new Error('ราคาต่อลิตรไม่ถูกต้อง');

  return withLock_(() => {
    const st = resolveGen_(genId, 'active', user), gid = String(st.GenID);
    const pts = curvePoints_(st), cap = num_(st.TankCapacity, 600);
    const now = Date.now();
    const t = p.time ? parseTime_(p.time) : now;
    if (t > now + 60000) throw new Error('เวลาที่ระบุต้องไม่อยู่ในอนาคต');

    const before = fuelLevel_(st, byGen_(readAll_(SH.SESSIONS), gid).map(parseSession_), byGen_(readAll_(SH.FUEL), gid), pts, t).level;
    const after = before + liters;
    const note = clean_(p.note);
    appendRow_(SH.FUEL, {
      FuelID: genId_('REF'), Timestamp: new Date(t), Type: 'REFILL', Liters: liters, PricePerL: price,
      TotalCost: price === '' ? '' : round_(price * liters, 2), CalcLevel: round_(before, 1),
      LevelAfter: round_(after, 1), Inspector: user.name, Note: note, GenID: gid
    });
    logEvent_(gid, t, '', 'REFILL', 'เติมน้ำมัน', '', liters + ' ลิตร' + (note ? ' | ' + note : ''), user.name);

    const warnings = [];
    if (after > cap * 1.02)
      warnings.push('ยอดหลังเติมตามการคำนวณ (' + round_(after, 0) + ' ล.) เกินความจุถัง ควรตรวจวัดระดับจริง');
    if (p.measuredAfter !== '' && p.measuredAfter != null) {
      const m = measureInternal_(gid, t + 1000, Number(p.measuredAfter), 'วัดหลังเติม', user, st, pts, cap);
      if (m.warning) warnings.push(m.warning);
    }
    return { message: 'บันทึกการเติม ' + liters + ' ลิตร เรียบร้อย (' + st.Name + ')', warnings: warnings, dashboard: buildDashboard_(user, gid) };
  });
}

function recordMeasure(token, genId, p) {
  const user = auth_(token, ['admin', 'operator']);
  p = p || {};
  if (p.measured === '' || p.measured == null) throw new Error('กรุณาระบุระดับที่วัดได้');
  return withLock_(() => {
    const st = resolveGen_(genId, 'active', user), gid = String(st.GenID);
    const pts = curvePoints_(st), cap = num_(st.TankCapacity, 600);
    const now = Date.now();
    const t = p.time ? parseTime_(p.time) : now;
    if (t > now + 60000) throw new Error('เวลาที่ระบุต้องไม่อยู่ในอนาคต');
    const m = measureInternal_(gid, t, Number(p.measured), clean_(p.note), user, st, pts, cap);
    return {
      message: 'บันทึกระดับ ' + p.measured + ' ลิตร (ต่างจากคำนวณ ' + round_(m.diff, 1) + ' ล.) — ' + st.Name,
      warnings: m.warning ? [m.warning] : [], dashboard: buildDashboard_(user, gid)
    };
  });
}

// genId = รหัสเครื่อง หรือ 'ALL' (รวมทุกเครื่อง)
function getReport(token, genId, fromStr, toStr, type) {
  const user = auth_(token);
  const from = dayStart_(fromStr), to = dayStart_(toStr) + DAY - 1;
  if (to < from) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  if (to - from > 400 * DAY) throw new Error('เลือกช่วงได้ไม่เกิน 400 วัน');
  type = type || 'ALL';

  const all = genId === 'ALL';
  const allGens = genRows_();
  const gens = all ? allGens.filter(g => canSee_(user, g.GenID)) : [resolveGen_(genId, 'any', user)];
  if (!gens.length) throw new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์เครื่องใด');
  const ids = {}; gens.forEach(g => ids[String(g.GenID)] = true);
  const curves = readAll_(SH.CURVE);
  const ptsMap = {}; gens.forEach(g => ptsMap[String(g.GenID)] = curvePoints_(g, curves));
  const inIds = r => ids[String(r.GenID)] === true;
  const now = Date.now();

  const allSess = readAll_(SH.SESSIONS).filter(inIds).map(parseSession_).filter(s => s.startMs >= from && s.startMs <= to);
  const logs = readAll_(SH.FUEL).filter(inIds).filter(l => inRange_(toMs_(l.Timestamp), from, to))
    .sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const events = readAll_(SH.EVENTS).filter(inIds).filter(e => inRange_(toMs_(e.Timestamp), from, to));

  const sess = (type === 'OUTAGE' || type === 'WARMUP') ? allSess.filter(s => s.Type === type)
    : (type === 'ALL' ? allSess : []);
  const rows = sess.sort((a, b) => a.startMs - b.startMs).map(s => sessionOut_(s, ptsOf_(ptsMap, s), now));
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

  const fuelTypeOf = {}; gens.forEach(g => fuelTypeOf[String(g.GenID)] = String(g.FuelType || 'ดีเซล'));
  const annex = logs.map(l => ({
    t: toMs_(l.Timestamp), gen: String(l.GenID), fuelType: fuelTypeOf[String(l.GenID)] || 'ดีเซล',
    serviced: l.Type === 'REFILL' ? num_(l.Liters, null) : null,
    inTank: l.Type === 'MEASURE' ? num_(l.MeasuredLevel, null) : num_(l.LevelAfter, null),
    measured: l.Type === 'MEASURE', inspector: String(l.Inspector || ''), note: String(l.Note || '')
  }));

  const g0 = gens[0];
  return {
    from: fromStr, to: toStr, type: type, genId: all ? 'ALL' : String(g0.GenID), generatedAt: now, generatedBy: user.name,
    gen: all ? { name: 'ทุกเครื่อง (' + gens.length + ' เครื่อง)', location: '', kva: null, cap: null, count: gens.length }
             : { name: String(g0.Name), location: String(g0.Location || ''), kva: g0.RatedKVA, cap: num_(g0.TankCapacity, 600), count: 1 },
    gens: genList_(allGens, user),
    summary: summarize_(allSess, logs, events, from, to, ptsMap),
    daily: daily, sessions: rows, fuel: fuelRows, faults: faults, annex: annex
  };
}

function exportReport(token, genId, fromStr, toStr, type) {
  auth_(token, ['admin']);
  const r = getReport(token, genId, fromStr, toStr, type);
  const nameOf = {}; r.gens.forEach(g => nameOf[g.id] = g.name);
  const gn = id => nameOf[id] || id;
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
    ['เครื่อง', 'รหัส', 'ประเภท', 'ไฟดับ', 'สตาร์ท', 'จ่ายไฟ', 'ไฟกลับ', 'หยุดเครื่อง', 'ไฟดับ (นาที)', 'เดินเครื่อง (ชม.)',
     'จ่ายไฟ (ชม.)', 'โหลดเฉลี่ย %', 'น้ำมัน (ล.)', 'ชม.เครื่องเริ่ม', 'ชม.เครื่องจบ', 'ผู้บันทึก', 'หมายเหตุ'],
    r.sessions.map(x => [gn(x.gen), x.id, x.typeLabel, fmtTH_(x.outageStart), fmtTH_(x.genStart), fmtTH_(x.loadStart),
      fmtTH_(x.mainsRestored), fmtTH_(x.genStop), x.outageMin, x.runHours, x.loadHours, x.avgLoad, x.fuel,
      x.hmStart, x.hmEnd, x.operator, x.note]));

  writeTable_(ss, 'เชื้อเพลิง',
    ['เครื่อง', 'วันเวลา', 'ประเภท', 'ลิตร', 'ราคา/ลิตร', 'รวม (บาท)', 'ยอดคำนวณ', 'วัดจริง', 'ผลต่าง (ล.)', 'ผลต่าง %', 'คงถังหลังรายการ', 'ผู้บันทึก', 'หมายเหตุ'],
    r.fuel.map(x => [gn(x.gen), fmtTH_(x.t), x.typeLabel, x.liters, x.price, x.cost, x.calc, x.measured, x.diff, x.diffPct, x.after, x.by, x.note]));

  writeTable_(ss, 'ผนวก ง',
    ['เครื่อง', 'วัน เดือน ปี', 'ประเภทเชื้อเพลิง', 'จำนวนบริการเชื้อเพลิง (ลิตร)', 'เชื้อเพลิงคงถัง (ลิตร)', 'ผู้ตรวจสอบ', 'หมายเหตุ'],
    r.annex.map(x => [gn(x.gen), fmtTH_(x.t), x.fuelType, x.serviced == null ? '-' : x.serviced, x.inTank, x.inspector, x.note]));

  writeTable_(ss, 'เหตุขัดข้อง', ['เครื่อง', 'วันเวลา', 'รายละเอียด', 'ผู้บันทึก'],
    r.faults.map(x => [gn(x.gen), fmtTH_(x.t), x.detail, x.user]));

  return ss.getUrl();
}

function getAdminSettings(token, genId) {
  auth_(token, ['admin']);
  const g = resolveGen_(genId, 'any');
  return {
    genId: String(g.GenID),
    settings: FIELDS.map(f => ({ key: f[0], desc: f[1], type: f[2], value: g[f[0]] == null ? '' : g[f[0]] })),
    curve: byGen_(readAll_(SH.CURVE), g.GenID).map(c => ({ row: c._row, load: c.LoadPct, min: c.RateMin, max: c.RateMax, used: c.RateUsed, sfc: c.SFC_g_kWh }))
  };
}

function saveAdminSettings(token, genId, settings, curve) {
  const user = auth_(token, ['admin']);
  return withLock_(() => {
    const g = resolveGen_(genId, 'any'), gid = String(g.GenID);
    const upd = {};
    FIELDS.forEach(f => {
      const k = f[0];
      if (!settings || settings[k] === undefined) return;
      if (f[2] === 'text') {
        upd[k] = clean_(settings[k]).slice(0, k === 'FuelType' ? 30 : 100);
        if (k === 'Name' && !upd[k]) throw new Error('ชื่อเครื่องต้องไม่ว่าง');
        return;
      }
      const n = Number(settings[k]);
      if (settings[k] === '' || isNaN(n) || n < 0) throw new Error('ค่า "' + f[1] + '" ไม่ถูกต้อง');
      upd[k] = n;
    });
    ['TankCapacity', 'RatedKVA', 'RatedKW'].forEach(k => {
      if (upd[k] !== undefined && upd[k] <= 0) throw new Error('ค่า "' + k + '" ต้องมากกว่า 0');
    });
    setGen_(gid, upd);

    const sh = sheet_(SH.CURVE), h = headerOf_(sh);
    const mine = {}; byGen_(readAll_(SH.CURVE), gid).forEach(c => mine[c._row] = true);
    const cols = { min: 'RateMin', max: 'RateMax', used: 'RateUsed', sfc: 'SFC_g_kWh' };
    (curve || []).forEach(c => {
      const row = Number(c.row);
      if (!mine[row]) return;                                  // แก้ได้เฉพาะแถวของเครื่องนี้
      Object.keys(cols).forEach(k => {
        if (c[k] === undefined || c[k] === '') return;
        const v = Number(c[k]);
        if (isNaN(v) || v <= 0) throw new Error('ค่าอัตราสิ้นเปลืองไม่ถูกต้อง');
        sh.getRange(row, h.indexOf(cols[k]) + 1).setValue(v);
      });
    });
    logEvent_(gid, Date.now(), '', 'SETTINGS', 'แก้ไขการตั้งค่า', '', JSON.stringify(upd).slice(0, 400), user.name);
    return { message: 'บันทึกการตั้งค่า ' + gid + ' เรียบร้อย' };
  });
}

function forceReset(token, genId, note) {
  const user = auth_(token, ['admin']);
  return withLock_(() => {
    const st = resolveGen_(genId, 'active'), gid = String(st.GenID), pts = curvePoints_(st), now = Date.now();
    const sess = st.CurrentSessionID ? getSession_(st.CurrentSessionID) : null;
    if (sess && sess.Status === 'OPEN') {
      closeSession_(sess, Math.max(now, lastTime_(sess)), pts, '');
      sess.Status = 'FORCED';
      sess.Note = [sess.Note, 'ปิดโดยผู้ดูแล: ' + clean_(note)].filter(String).join(' | ');
      saveSession_(sess);
    }
    setGen_(gid, { CurrentState: 'IDLE', CurrentSessionID: '' });
    logEvent_(gid, now, sess ? sess.SessionID : '', 'RESET', 'รีเซ็ตสถานะเป็นพร้อมใช้งาน', '', clean_(note), user.name);
    return { message: 'รีเซ็ตสถานะ ' + st.Name + ' เรียบร้อย', dashboard: buildDashboard_(user, gid) };
  });
}

/* ======================= DASHBOARD ======================= */
function planLoad_(st, sessions) {
  const state = st.CurrentState || 'IDLE';
  if (state === 'SUPPLYING') {
    const cs = sessions.find(s => s.SessionID === st.CurrentSessionID);
    const last = cs && cs.segs[cs.segs.length - 1];
    if (last && last.load > 0) return last.load;
  }
  return num_(st.DefaultLoadPct, 50);
}

function fuelAssess_(st, fuel, pts, planLoad) {
  const cap = num_(st.TankCapacity, 600);
  const pct = cap ? fuel.level / cap * 100 : 0;
  const planRate = rateAt_(planLoad, pts);
  const hoursLeft = planRate ? fuel.level / planRate : 0;
  let status = 'ok', alert = null;
  if (pct < num_(st.CriticalPct, 25) || hoursLeft < num_(st.CriticalHours, 4)) {
    status = 'critical';
    alert = { lv: 'critical', msg: 'น้ำมันเหลือ ' + round_(fuel.level, 0) + ' ลิตร (เดินต่อได้ ~' + round_(hoursLeft, 1) + ' ชม.) ควรเติมทันที' };
  } else if (pct < num_(st.WarnPct, 50)) {
    status = 'warn';
    alert = { lv: 'warn', msg: 'น้ำมันต่ำกว่า ' + st.WarnPct + '% ของถัง ควรวางแผนเติม' };
  }
  return { cap: cap, pct: pct, planRate: planRate, hoursLeft: hoursLeft, status: status, alert: alert };
}

function buildAlerts_(st, fuel, a, sessions, logs, now) {
  const alerts = [];
  if (a.alert) alerts.push(a.alert);
  const warmups = sessions.filter(s => s.Type === 'WARMUP');
  const lastWarm = warmups.reduce((m, s) => Math.max(m, s.startMs || 0), 0);
  const weekWarm = warmups.filter(s => s.startMs >= now - 7 * DAY).length;
  if (!lastWarm) alerts.push({ lv: 'warn', msg: 'ยังไม่มีบันทึกการวอร์มเครื่อง' });
  else if (now - lastWarm > 7 * DAY)
    alerts.push({ lv: 'warn', msg: 'ไม่ได้วอร์มเครื่องมาแล้ว ' + Math.floor((now - lastWarm) / DAY) + ' วัน (เป้าหมาย ' + st.WarmupPerWeek + ' ครั้ง/สัปดาห์)' });

  const measures = logs.filter(l => l.Type === 'MEASURE').sort((x, y) => toMs_(x.Timestamp) - toMs_(y.Timestamp));
  const lastM = measures[measures.length - 1];
  if (lastM && Math.abs(num_(lastM.DiffPct, 0)) > num_(st.DiffAlertPct, 5))
    alerts.push({ lv: 'warn', msg: 'การตรวจวัดล่าสุดต่างจากยอดคำนวณ ' + lastM.DiffL + ' ลิตร (' + lastM.DiffPct + '%) ควรตรวจสอบการรั่วซึม/การบันทึก' });
  if (fuel.baseTime && now - fuel.baseTime > 30 * DAY)
    alerts.push({ lv: 'info', msg: 'ไม่ได้ตรวจวัดระดับน้ำมันจริงเกิน 30 วัน ควรตรวจวัดเพื่อปรับยอด' });
  if ((st.CurrentState || 'IDLE') === 'COOLDOWN') alerts.push({ lv: 'info', msg: 'ไฟหลักกลับมาแล้ว อย่าลืมกด "หยุดเครื่อง" เมื่อดับเครื่อง' });
  return { alerts: alerts, lastWarm: lastWarm, weekWarm: weekWarm };
}

function buildDashboard_(user, genId) {
  const st = resolveGen_(genId, null, user), gid = String(st.GenID), now = Date.now(), pts = curvePoints_(st);
  const sessions = byGen_(readAll_(SH.SESSIONS), gid).map(parseSession_);
  const logs = byGen_(readAll_(SH.FUEL), gid);
  const events = byGen_(readAll_(SH.EVENTS), gid).sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const cap = num_(st.TankCapacity, 600);
  const state = ALL_STATES.indexOf(st.CurrentState) >= 0 ? st.CurrentState : 'IDLE';
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
  const fa = fuelAssess_(st, fuel, pts, planLoad);
  const al = buildAlerts_(st, fuel, fa, sessions, logs, now);

  const refills = logs.filter(l => l.Type === 'REFILL').sort((a, b) => toMs_(a.Timestamp) - toMs_(b.Timestamp));
  const lr = refills[refills.length - 1];
  const fuelHist = logs.slice().sort((a, b) => toMs_(b.Timestamp) - toMs_(a.Timestamp)).slice(0, 20).map(fuelOut_);
  const ptsMap = {}; ptsMap[gid] = pts;

  return {
    user: user, serverTime: now,
    gen: { id: gid, name: String(st.Name), location: String(st.Location || ''), kva: st.RatedKVA,
           kw: num_(st.RatedKW, 200), fuelType: String(st.FuelType || 'ดีเซล'), cap: cap },
    gens: genList_(null, user),
    state: state, stateLabel: STATE_LABEL[state],
    actions: Object.keys(ACTIONS).filter(a => ACTIONS[a].from.indexOf(state) >= 0),
    current: current,
    fuel: {
      level: round_(fuel.level, 1), pct: round_(fa.pct, 1), status: fa.status, planLoad: planLoad,
      planRate: round_(fa.planRate, 2), hoursLeft: round_(fa.hoursLeft, 1),
      hoursLeftFull: round_(fuel.level / rateAt_(100, pts), 1),
      baseTime: fuel.baseTime, baseLevel: fuel.baseLevel,
      lastRefill: lr ? { t: toMs_(lr.Timestamp), liters: num_(lr.Liters, 0) } : null
    },
    month: summarize_(sessions, logs, events, monthStart_(now), now, ptsMap),
    warm: { week: al.weekWarm, target: num_(st.WarmupPerWeek, 2), last: al.lastWarm || null, minutes: num_(st.WarmupMinutes, 15) },
    alerts: al.alerts, curve: pts, defaultLoad: num_(st.DefaultLoadPct, 50),
    recent: events.slice(-12).reverse().map(evOut_),
    fuelHistory: fuelHist
  };
}

// ภาพรวมทุกเครื่องที่เปิดใช้งาน
function getOverview(token) {
  const user = auth_(token), now = Date.now();
  const gens = genRows_().filter(g => isTrue_(g.Active) && canSee_(user, g.GenID));
  const sess = readAll_(SH.SESSIONS).map(parseSession_), logs = readAll_(SH.FUEL), curves = readAll_(SH.CURVE), events = readAll_(SH.EVENTS);
  const ptsMap = {}, alerts = [];
  let cap = 0, lvl = 0;
  const out = gens.map(g => {
    const gid = String(g.GenID), pts = curvePoints_(g, curves); ptsMap[gid] = pts;
    const ss = byGen_(sess, gid), ll = byGen_(logs, gid);
    const state = ALL_STATES.indexOf(g.CurrentState) >= 0 ? g.CurrentState : 'IDLE';
    const fuel = fuelLevel_(g, ss, ll, pts, now);
    const fa = fuelAssess_(g, fuel, pts, planLoad_(g, ss));
    const al = buildAlerts_(g, fuel, fa, ss, ll, now);
    al.alerts.filter(a => a.lv !== 'info').forEach(a => alerts.push({ gen: gid, genName: String(g.Name), lv: a.lv, msg: a.msg }));
    cap += fa.cap; lvl += fuel.level;
    const cs = state !== 'IDLE' ? ss.find(s => s.SessionID === g.CurrentSessionID) : null;
    return { id: gid, name: String(g.Name), location: String(g.Location || ''), kva: num_(g.RatedKVA, 0),
             state: state, stateLabel: STATE_LABEL[state], since: cs ? (toMs_(cs.GenStart) || toMs_(cs.OutageStart)) : null,
             fuel: { level: round_(fuel.level, 0), pct: round_(fa.pct, 0), cap: fa.cap, status: fa.status, hoursLeft: round_(fa.hoursLeft, 1) },
             lastWarm: al.lastWarm || null, alerts: al.alerts.filter(a => a.lv !== 'info').length };
  });
  const ids = {}; gens.forEach(g => ids[String(g.GenID)] = true);
  const inIds = r => ids[String(r.GenID)] === true;
  return { user: user, serverTime: now, gens: out, alerts: alerts, gensAll: genList_(null, user),
           totals: { fuel: round_(lvl, 0), cap: round_(cap, 0) },
           month: summarize_(sess.filter(inIds), logs.filter(inIds), events.filter(inIds), monthStart_(now), now, ptsMap) };
}

/* ======================= FUEL CALC ======================= */
function curvePoints_(st, curves) {
  const pts = [{ l: 0, r: num_(st.IdleRate, 15) }];
  byGen_(curves || readAll_(SH.CURVE), st.GenID).forEach(c => pts.push({ l: num_(c.LoadPct, 0), r: num_(c.RateUsed, 0) }));
  if (pts.length < 2) pts.push({ l: 100, r: num_(st.IdleRate, 15) * 3 });   // กันกรณีลืมกรอกตาราง
  return pts.sort((a, b) => a.l - b.l);
}

function ptsOf_(ptsMap, s) {
  return ptsMap[String(s.GenID)] || ptsMap[Object.keys(ptsMap)[0]];
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

// ยอดคงถัง = ค่าวัดจริงล่าสุด + เติมหลังจากนั้น − ใช้หลังจากนั้น  (sessions/logs ต้องเป็นของเครื่องเดียวกัน)
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

function measureInternal_(gid, t, measured, note, user, st, pts, cap) {
  if (isNaN(measured) || measured < 0 || measured > cap * 1.1)
    throw new Error('ระดับน้ำมันที่วัดได้ไม่ถูกต้อง (0–' + cap + ' ลิตร)');
  const calc = fuelLevel_(st, byGen_(readAll_(SH.SESSIONS), gid).map(parseSession_), byGen_(readAll_(SH.FUEL), gid), pts, t).level;
  const diff = measured - calc, diffPct = cap ? diff / cap * 100 : 0;
  appendRow_(SH.FUEL, {
    FuelID: genId_('MSR'), Timestamp: new Date(t), Type: 'MEASURE', CalcLevel: round_(calc, 1),
    MeasuredLevel: measured, DiffL: round_(diff, 1), DiffPct: round_(diffPct, 2), LevelAfter: measured,
    Inspector: user.name, Note: note, GenID: gid
  });
  logEvent_(gid, t, '', 'MEASURE', 'ตรวจวัดระดับน้ำมัน', '',
    'วัดได้ ' + measured + ' ล. (คำนวณ ' + round_(calc, 1) + ' ล. ต่าง ' + round_(diff, 1) + ' ล.)', user.name);
  const warning = Math.abs(diffPct) > num_(st.DiffAlertPct, 5)
    ? 'ผลต่าง ' + round_(diff, 1) + ' ลิตร (' + round_(diffPct, 1) + '% ของถัง) เกินเกณฑ์ ควรตรวจสอบการรั่วซึมหรือการบันทึก' : '';
  return { calc: calc, diff: diff, diffPct: diffPct, warning: warning };
}

/* ======================= SESSIONS ======================= */
function newSession_(type, operator, note, gid) {
  const o = {};
  HEADERS.Sessions.forEach(h => o[h] = '');
  o.SessionID = genId_(type === 'OUTAGE' ? 'OUT' : 'WRM');
  o.Type = type; o.Status = 'OPEN'; o.Operator = operator; o.Note = note; o.GenID = gid; o.segs = [];
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

// ptsMap = { GenID: จุดเส้นโค้งอัตราสิ้นเปลือง }
function summarize_(sessions, logs, events, from, to, ptsMap) {
  const now = Date.now();
  const r = { outages: 0, outageMin: 0, warmups: 0, runHours: 0, loadHours: 0, fuelUsed: 0,
              refills: 0, refillL: 0, refillCost: 0, measures: 0, faults: 0 };
  sessions.forEach(s => {
    if (!inRange_(s.startMs, from, to)) return;
    const m = sessionMetrics_(s, ptsOf_(ptsMap, s), now);
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
           user: String(e.User || ''), session: String(e.SessionID || ''), gen: String(e.GenID || '') };
}

function fuelOut_(l) {
  return { id: String(l.FuelID), gen: String(l.GenID || ''), t: toMs_(l.Timestamp), type: String(l.Type), typeLabel: FUEL_LABEL[l.Type] || l.Type,
           liters: num_(l.Liters, null), price: num_(l.PricePerL, null), cost: num_(l.TotalCost, null),
           calc: num_(l.CalcLevel, null), measured: num_(l.MeasuredLevel, null), diff: num_(l.DiffL, null),
           diffPct: num_(l.DiffPct, null), after: num_(l.LevelAfter, null),
           by: String(l.Inspector || ''), note: String(l.Note || '') };
}

function sessionOut_(s, pts, now) {
  const m = sessionMetrics_(s, pts, now);
  return {
    id: String(s.SessionID), gen: String(s.GenID || ''), type: s.Type, typeLabel: TYPE_LABEL[s.Type] || s.Type, status: String(s.Status),
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

function headerOf_(sh) {
  const lc = sh.getLastColumn();
  return lc < 1 ? [] : sh.getRange(1, 1, 1, lc).getValues()[0].map(String);
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

// เขียนตามลำดับคอลัมน์จริงของชีต (ไม่พึ่งลำดับใน HEADERS)
function appendRow_(name, obj) {
  const sh = sheet_(name);
  sh.appendRow(headerOf_(sh).map(k => obj[k] === undefined ? '' : obj[k]));
}

function updateRow_(name, row, obj) {
  const sh = sheet_(name), h = headerOf_(sh);
  sh.getRange(row, 1, 1, h.length).setValues([h.map(k => obj[k] === undefined ? '' : obj[k])]);
}

function logEvent_(gid, t, sid, type, label, load, detail, user) {
  appendRow_(SH.EVENTS, { EventID: genId_('EV'), Timestamp: new Date(t), SessionID: sid, EventType: type,
                          EventLabel: label, LoadPct: load, Detail: detail, User: user, GenID: gid });
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