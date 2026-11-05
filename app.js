/* Kho Hoành Uy – app web đọc/ghi thẳng Google Sheet "Kho Hoanh Uy - Du lieu" bằng tài khoản Google của người dùng.
 * Sheet giữ nguyên cấu trúc cũ (chương trình Apps Script vẫn dùng chung được):
 *   DanhMuc: Ma | Ten | DVT | Nhom | TonToiThieu | GhiChu | TonChuan
 *   Nhap:    Ngay | NCC | Ma | SL | DVT | Gia | CoHD | GhiChu | Nguon | NguoiNhap | SoPhieu
 *   Xuat:    Ngay | SoHD | Khach | Ma | SL | DVT | CoHD | GhiChu | Nguon | NguoiNhap | SoPhieu
 *   KiemKe:  Ngay | Ma | SLDem | GhiChu | NguoiNhap
 * Quy tắc tồn: Tồn = TonChuan + Nhập mới − Xuất mới. Dòng có chữ ở cột Nguon là lịch sử cũ, không tính tồn.
 * Phiếu điều chỉnh kiểm kê (số phiếu DC-…) ghi vào Nhap (tăng) hoặc Xuat (giảm), NCC/Khách = "Kiểm kê".
 */
var CFG = window.KHO_CONFIG || {};
var SHEET = CFG.sheetId;
var API = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET;
var TEN_LOAI = { N: 'Nhập', X: 'Xuất', D: 'Điều chỉnh' };
var HOM_NAY = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); })();

var DB = { hang: [], phieu: [], phieuDoc: [], kiemKe: [] };
var HMAP = {};
var token = null, tokenHet = 0, tokenClient = null, email = '', SHEET_IDS = {};
var daNap = false;

/* ============ TIỆN ÍCH ============ */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function so(n) { return Number(n).toLocaleString('vi-VN'); }
function soDau(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + so(Math.abs(n)); }
function ngayVN(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : (s || ''); }
function boDau(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
function bao(id, kieu, html) { $(id).innerHTML = html ? '<div class="note ' + kieu + '">' + html + '</div>' : ''; }
function soPhieu(loai, n) { return (loai === 'N' ? 'PN' : loai === 'X' ? 'PX' : 'DC') + '-' + ('000' + n).slice(-4); }
function sapNgay(a, b) { return a.ngay < b.ngay ? -1 : a.ngay > b.ngay ? 1 : 0; }
function lapMap() { HMAP = {}; DB.hang.forEach(function (h) { HMAP[h.ma] = h; }); }
function num(v) {
  if (typeof v === 'number') return v;
  v = String(v == null ? '' : v).trim(); if (!v) return 0;
  if (v.indexOf(',') >= 0 && v.indexOf('.') < 0) v = v.replace(',', '.'); else v = v.replace(/,/g, '');
  var n = parseFloat(v); return isNaN(n) ? 0 : n;
}
// Ngày trong Sheet có thể là "2026-11-06", "6/11/2026" hoặc số ngày kiểu Excel
function chuanNgay(v) {
  if (typeof v === 'number' && v > 30000) { var d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s;
}
// Số lượng có dấu dùng để tính tồn: dòng cũ không tính
function delta(p) { if (p.cu) return 0; return p.loai === 'X' ? -p.sl : p.sl; }
// Số lượng có dấu để hiển thị
function hienSL(p) { return p.loai === 'X' ? -p.sl : p.sl; }
function maTu(v) {
  v = String(v).trim(); if (HMAP[v]) return v;
  var m = v.split(' · ')[0].trim(); if (HMAP[m]) return m; if (HMAP[m.toUpperCase()]) return m.toUpperCase();
  var q = boDau(v), f = DB.hang.filter(function (h) { return boDau(h.ten) === q; });
  return f.length ? f[0].ma : '';
}

/* ============ ĐĂNG NHẬP GOOGLE ============ */
function chuaCauHinh() { return !CFG.clientId || !SHEET; }
function khoiTaoDangNhap() {
  if (chuaCauHinh()) { bao('login-msg', 'err', 'App chưa có Client ID. Điền <b>clientId</b> trong file config.js (xem README).'); $('btn-login').disabled = true; return; }
  if (!window.google || !google.accounts || !google.accounts.oauth2) { setTimeout(khoiTaoDangNhap, 300); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets openid email',
    callback: async function (r) {
      if (r.error) { bao('login-msg', 'err', 'Đăng nhập không thành công (' + esc(r.error) + '). Thử lại.'); return; }
      token = r.access_token; tokenHet = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
      bao('login-msg');
      await layEmail();
      try { localStorage.setItem('kho-email', email); } catch (e) {}
      await napDuLieu(true);
    }
  });
}
function dangNhap() {
  if (!tokenClient) return;
  var hint = ''; try { hint = localStorage.getItem('kho-email') || ''; } catch (e) {}
  tokenClient.requestAccessToken({ prompt: hint ? '' : 'consent', login_hint: hint || undefined });
}
async function layEmail() {
  try { var r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } }); var j = await r.json(); email = j.email || ''; } catch (e) { email = ''; }
  $('me-name').textContent = email || ''; $('me-av').textContent = email ? email.charAt(0) : '?';
}
$('btn-login').onclick = dangNhap;
$('btn-logout').onclick = function () {
  if (token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(token, function () {});
  token = null; email = ''; daNap = false;
  try { localStorage.removeItem('kho-email'); } catch (e) {}
  hienDangNhap(true);
};
function hienDangNhap(on) {
  document.body.classList.toggle('logged-out', on);
  ['menu', 'btn-tao', 'fab', 'btn-reload', 'btn-backup', 'btn-logout', 'link-sheet'].forEach(function (id) { $(id).hidden = on; });
  $('sync').textContent = on ? 'Chưa đăng nhập' : 'Đã kết nối Google Sheet';
  if (on) { $('me-name').textContent = ''; $('me-av').textContent = '?'; PAGES.forEach(function (p) { $('p-' + p[0]).classList.remove('on'); }); $('p-dang-nhap').classList.add('on'); }
  else { $('p-dang-nhap').classList.remove('on'); mo(location.hash.slice(1)); }
}

/* ============ GỌI GOOGLE SHEETS API ============ */
async function api(path, opt) {
  if (!token || Date.now() > tokenHet) { hienDangNhap(true); bao('login-msg', 'err', 'Phiên đăng nhập đã hết. Đăng nhập lại để tiếp tục.'); throw { code: 'auth' }; }
  opt = opt || {};
  var r = await fetch(API + path, { method: opt.method || 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  if (r.status === 401) { token = null; hienDangNhap(true); bao('login-msg', 'err', 'Phiên đăng nhập đã hết. Đăng nhập lại để tiếp tục.'); throw { code: 'auth' }; }
  if (!r.ok) { var t = ''; try { t = (await r.json()).error.message; } catch (e) {} throw { code: r.status, message: t }; }
  return r.json();
}
function loiGhi(e) {
  if (e && e.code === 'auth') return 'Cần đăng nhập lại.';
  if (e && e.code === 403) return 'Gmail này không có quyền sửa Google Sheet. Nhờ chủ Sheet chia sẻ quyền Người chỉnh sửa.';
  if (e && e.code === 404) return 'Không tìm thấy Google Sheet. Kiểm tra sheetId trong config.js.';
  if (e && e.code === 429) return 'Thao tác quá nhanh, Google tạm chặn. Chờ một phút rồi thử lại.';
  return 'Không lưu được' + (e && e.message ? ' (' + esc(e.message) + ')' : '') + '. Kiểm tra mạng rồi thử lại.';
}
async function napDuLieu(lanDau) {
  $('sync').textContent = 'Đang tải dữ liệu…';
  try {
    if (lanDau) {
      var meta = await api('?fields=sheets.properties(sheetId,title),properties.title');
      SHEET_IDS = {}; meta.sheets.forEach(function (s) { SHEET_IDS[s.properties.title] = s.properties.sheetId; });
      ['DanhMuc', 'Nhap', 'Xuat', 'KiemKe'].forEach(function (t) { if (SHEET_IDS[t] == null) throw { code: 'thieu', message: 'Sheet thiếu trang ' + t }; });
      $('link-sheet').href = 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit';
    }
    var q = ['DanhMuc!A2:G', 'Nhap!A2:K', 'Xuat!A2:K', 'KiemKe!A2:E'].map(function (r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var d = await api('/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
    var v = d.valueRanges.map(function (x) { return x.values || []; });
    // Giữ đúng số dòng thật trên Sheet (có thể có dòng trống xen giữa) để sửa đúng chỗ
    DB.hang = []; v[0].forEach(function (r, i) { if (r[0] !== '' && r[0] != null) DB.hang.push({ ma: String(r[0]).trim(), ten: String(r[1] || ''), dvt: String(r[2] || ''), nhom: String(r[3] || ''), min: num(r[4]), gc: String(r[5] || ''), dau: num(r[6]), row: i + 2 }); });
    lapMap();
    var lines = [];
    v[1].forEach(function (r, i) {
      if (r[2] === '' || r[2] == null) return;
      var sp = String(r[10] || ''), dc = sp.indexOf('DC-') === 0;
      lines.push({ sheet: 'Nhap', row: i + 2, loai: dc ? 'D' : 'N', ngay: chuanNgay(r[0]), doiTac: String(r[1] || ''), ma: String(r[2]).trim(), sl: num(r[3]), dvt: String(r[4] || ''), gia: r[5], hd: String(r[6] || ''), gc: String(r[7] || ''), cu: !!String(r[8] || '').trim(), nguoi: String(r[9] || ''), so: sp, soHD: '' });
    });
    v[2].forEach(function (r, i) {
      if (r[3] === '' || r[3] == null) return;
      var sp = String(r[10] || ''), dc = sp.indexOf('DC-') === 0, sl = num(r[4]);
      lines.push({ sheet: 'Xuat', row: i + 2, loai: dc ? 'D' : 'X', ngay: chuanNgay(r[0]), soHD: String(r[1] || ''), doiTac: String(r[2] || ''), ma: String(r[3]).trim(), sl: dc ? -sl : sl, dvt: String(r[5] || ''), hd: String(r[6] || ''), gc: String(r[7] || ''), cu: !!String(r[8] || '').trim(), nguoi: String(r[9] || ''), so: sp });
    });
    DB.phieu = lines.sort(sapNgay);
    DB.kiemKe = [];
    v[3].forEach(function (r, i) { if (r[1] !== '' && r[1] != null) DB.kiemKe.push({ row: i + 2, ngay: chuanNgay(r[0]), ma: String(r[1]).trim(), sl: num(r[2]), gc: String(r[3] || ''), nguoi: String(r[4] || '') }); });
    gomPhieu();
    daNap = true; hienDangNhap(false);
    $('sync').textContent = 'Đã đồng bộ lúc ' + new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    veTatCa();
  } catch (e) {
    if (e && e.code === 'auth') return;
    $('sync').textContent = 'Lỗi tải dữ liệu';
    var msg = e && e.code === 403 ? 'Gmail ' + esc(email) + ' chưa được chia sẻ Google Sheet. Nhờ chủ Sheet chia sẻ quyền Người chỉnh sửa.' : e && e.code === 404 ? 'Không tìm thấy Google Sheet. Kiểm tra sheetId trong config.js.' : 'Không tải được dữ liệu' + (e && e.message ? ': ' + esc(e.message) : '') + '.';
    if (!daNap) { hienDangNhap(true); bao('login-msg', 'err', msg); } else banner('err', msg);
  }
}
// Gom các dòng thành phiếu: dòng có số phiếu theo số phiếu, dòng không có theo ngày + đối tác + số HĐ
function gomPhieu() {
  var g = {}, ds = [];
  DB.phieu.forEach(function (p) {
    var k = p.so || ('~' + p.sheet + '|' + p.ngay + '|' + p.doiTac + '|' + p.soHD + '|' + (p.cu ? 'c' : 'm'));
    if (!g[k]) { g[k] = { so: p.so, loai: p.loai, ngay: p.ngay, doiTac: p.doiTac, hd: p.hd, soHD: p.soHD, nguoi: p.nguoi, cu: p.cu, sheet: p.sheet, dong: [] }; ds.push(g[k]); }
    g[k].dong.push(p);
  });
  DB.phieuDoc = ds;
}
async function ghiDong(sheet, rows) {
  await api('/values/' + encodeURIComponent(sheet + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', body: { values: rows } });
}
var daCoCotSoPhieu = {};
async function damBaoCotSoPhieu(sheet) {
  if (daCoCotSoPhieu[sheet]) return;
  await api('/values/' + encodeURIComponent(sheet + '!K1') + '?valueInputOption=RAW', { method: 'PUT', body: { values: [['SoPhieu']] } });
  daCoCotSoPhieu[sheet] = true;
}

/* ============ TÍNH TỒN ============ */
function tonDen(ma, ngay) {
  var t = HMAP[ma] ? HMAP[ma].dau : 0;
  DB.phieu.forEach(function (p) { if (p.ma === ma && (p.ngay || '') <= ngay) t += delta(p); });
  return t;
}
function kkMoiNhat(ma) { var k = null; DB.kiemKe.forEach(function (x) { if (x.ma === ma && (!k || x.ngay > k.ngay || (x.ngay === k.ngay && x.row > k.row))) k = x; }); return k; }
function tinhTon() {
  var T = {};
  DB.hang.forEach(function (h) { T[h.ma] = { so: h.dau }; });
  DB.phieu.forEach(function (p) { if (T[p.ma]) T[p.ma].so += delta(p); });
  DB.hang.forEach(function (h) {
    var t = T[h.ma], k = kkMoiNhat(h.ma), dv = h.nhom === 'Dịch vụ';
    if (dv) t.so = 0;
    t.kk = k ? k.sl : null; t.kkNgay = k ? k.ngay : ''; t.kkTon = k ? tonDen(h.ma, k.ngay) : null;
    t.lech = k && !dv ? k.sl - t.kkTon : 0;
    t.tt = dv ? 'Dịch vụ' : t.so < 0 ? 'Âm kho' : t.lech !== 0 ? 'Lệch kiểm kê' : t.so === 0 ? 'Hết hàng' : (h.min > 0 && t.so <= h.min) ? 'Sắp hết' : 'Còn hàng';
  });
  return T;
}
function st(tt) { return '<span class="st ' + ({ 'Sắp hết': 'warn', 'Hết hàng': 'bad', 'Lệch kiểm kê': 'bad', 'Âm kho': 'bad', 'Dịch vụ': 'neu' }[tt] || '') + '">' + tt + '</span>'; }
function doiTacTheo(loai) { var s = {}; DB.phieu.forEach(function (p) { if (p.loai === loai && p.doiTac) s[p.doiTac] = 1; }); return Object.keys(s).sort(); }

/* ============ HỘP XÁC NHẬN ============ */
var dlgOk = null;
function hoiXacNhan(tieuDe, noiDung, nut, fn) { $('dlg-t').textContent = tieuDe; $('dlg-p').textContent = noiDung; $('dlg-yes').textContent = nut; dlgOk = fn; $('dlg').classList.add('on'); $('dlg-yes').focus(); }
$('dlg-no').onclick = function () { $('dlg').classList.remove('on'); dlgOk = null; };
$('dlg-yes').onclick = function () { $('dlg').classList.remove('on'); var f = dlgOk; dlgOk = null; if (f) f(); };
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('dlg').classList.contains('on')) $('dlg-no').click(); });

/* ============ ĐIỀU HƯỚNG ============ */
var PAGES = [['tong-quan', 'Tổng quan'], ['phieu', 'Nhập / Xuất'], ['ton-kho', 'Tồn kho'], ['kiem-ke', 'Kiểm kê'], ['danh-muc', 'Danh mục'], ['bao-cao', 'Báo cáo'], ['lich-su', 'Lịch sử'], ['hoi-kho', 'Hỏi kho']];
function mo(id) {
  if (!daNap) return;
  if (!PAGES.some(function (p) { return p[0] === id; })) id = 'tong-quan';
  PAGES.forEach(function (p) { $('p-' + p[0]).classList.toggle('on', p[0] === id); if (p[0] === id) $('m-' + p[0]).setAttribute('aria-current', 'page'); else $('m-' + p[0]).removeAttribute('aria-current'); });
}
function den(id) { mo(id); try { if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id); } catch (e) {} try { window.scrollTo(0, 0); } catch (e) {} }
var ICO = {
  'tong-quan': '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  'phieu': '<path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/>',
  'ton-kho': '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  'kiem-ke': '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
  'danh-muc': '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  'bao-cao': '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  'lich-su': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'hoi-kho': '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  'con': '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M8 12l3 3 5-5"/>',
  'sap': '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
  'het': '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>',
  'lech': '<path d="M3 12h4l3-8 4 16 3-8h4"/>'
};
function ico(k) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + ICO[k] + '</svg>'; }
$('menu').innerHTML = PAGES.map(function (p, i) { return (i === 0 ? '<div class="menu-h">Nghiệp vụ</div>' : i === 5 ? '<div class="menu-h">Báo cáo &amp; tra cứu</div>' : '') + '<button type="button" id="m-' + p[0] + '">' + ico(p[0]) + '<span>' + p[1] + '</span></button>'; }).join('');
PAGES.forEach(function (p) { $('m-' + p[0]).onclick = function () { den(p[0]); }; });
window.addEventListener('hashchange', function () { mo(location.hash.slice(1)); });
function ganDong(tbl, fn) { Array.prototype.forEach.call(tbl.querySelectorAll('tr[data-ma]'), function (tr) { tr.tabIndex = 0; var go = function () { fn(tr.dataset.ma); }; tr.onclick = go; tr.onkeydown = function (e) { if (e.key === 'Enter') go(); }; }); }
function xemLichSu(ma) { $('l-ma').value = ma + ' · ' + HMAP[ma].ten; veLichSu(); den('lich-su'); }

/* ============ NÚT + ============ */
function dongFab() { var m = $('fab-menu'); m.classList.remove('on', 'at-top'); m.style.left = m.style.top = m.style.right = m.style.bottom = ''; $('fab').setAttribute('aria-expanded', 'false'); }
function moFab(nut, oTren) {
  var m = $('fab-menu'); if (m.classList.contains('on')) { dongFab(); return; }
  if (oTren) { var r = nut.getBoundingClientRect(); m.classList.add('at-top'); m.style.left = (r.left + window.scrollX) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px'; m.style.right = 'auto'; m.style.bottom = 'auto'; }
  m.classList.add('on'); $('fab').setAttribute('aria-expanded', oTren ? 'false' : 'true'); m.querySelector('button').focus();
}
$('fab').onclick = function (e) { e.stopPropagation(); moFab(this, false); };
$('btn-tao').onclick = function (e) { e.stopPropagation(); moFab(this, true); };
Array.prototype.forEach.call($('fab-menu').querySelectorAll('[data-tao]'), function (b) {
  b.onclick = function () {
    var t = b.dataset.tao; dongFab();
    if (t === 'N' || t === 'X') { datLoai(t); den('phieu'); $('p-dt').focus(); }
    else if (t === 'KK') { den('kiem-ke'); $('kk-ma').focus(); }
    else { moFormDM(''); den('danh-muc'); $('dm-ma').focus(); }
  };
});
document.addEventListener('click', function (e) { if (!$('fab-menu').contains(e.target) && e.target !== $('fab') && e.target !== $('btn-tao')) dongFab(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('fab-menu').classList.contains('on')) { dongFab(); $('fab').focus(); } });
$('btn-reload').onclick = function () { napDuLieu(false); };

/* ============ TỔNG QUAN ============ */
function veTongQuan() {
  var T = tinhTon(), c = { con: 0, sap: 0, het: 0, lech: 0 }, nam = HOM_NAY.slice(0, 4);
  DB.hang.forEach(function (h) { var t = T[h.ma].tt; if (t === 'Còn hàng') c.con++; if (t === 'Sắp hết') c.sap++; if (t === 'Hết hàng') c.het++; if (t === 'Lệch kiểm kê' || t === 'Âm kho') c.lech++; });
  $('tq-ngay').textContent = 'Hôm nay ' + ngayVN(HOM_NAY) + ' · ' + DB.hang.filter(function (h) { return h.nhom !== 'Dịch vụ'; }).length + ' mặt hàng';
  $('stats').innerHTML = stat('ok', c.con, 'Còn hàng', 'con', 'mặt hàng có tồn') + stat('warn', c.sap, 'Sắp hết', 'sap', c.sap ? 'nên đặt thêm' : 'chưa đặt mức tối thiểu') + stat('bad', c.het, 'Hết hàng', 'het', 'tồn bằng 0') + stat('bad', c.lech, 'Lệch kiểm kê', 'lech', 'sổ khác số đếm hoặc âm');
  var thang = [], nhap = [], xuat = [], max = 1;
  for (var i = 11; i >= 0; i--) { var d = new Date(Number(nam), Number(HOM_NAY.slice(5, 7)) - 1 - i, 1); thang.push(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2)); }
  thang.forEach(function (k) {
    var a = 0, b = 0;
    DB.phieu.forEach(function (p) { var h = HMAP[p.ma]; if (h && (p.ngay || '').slice(0, 7) === k && h.nhom !== 'Keo' && h.nhom !== 'Dịch vụ') { if (p.loai === 'N') a += p.sl; if (p.loai === 'X') b += p.sl; } });
    nhap.push(a); xuat.push(b); max = Math.max(max, a, b);
  });
  var step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : max <= 250 ? 50 : 100, top = Math.ceil(max / step) * step;
  var W = 600, H = 220, L = 32, B = 24, ih = H - B - 8, cw = (W - L) / thang.length, bw = Math.min(10, cw * 0.28);
  var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Số lượng nhập và xuất 12 tháng gần nhất">';
  for (var g = 0; g <= top; g += step) { var y = H - B - g / top * ih; s += '<line class="g" x1="' + L + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + g + '</text>'; }
  thang.forEach(function (k, i) {
    var cx = L + i * cw + cw / 2, h1 = nhap[i] / top * ih, h2 = xuat[i] / top * ih, nhan = 'T' + Number(k.slice(5)) + '/' + k.slice(2, 4);
    s += '<rect class="bi" x="' + (cx - bw - 1) + '" y="' + (H - B - h1) + '" width="' + bw + '" height="' + h1 + '"><title>' + nhan + ': nhập ' + nhap[i] + '</title></rect>';
    s += '<rect class="bo" x="' + (cx + 1) + '" y="' + (H - B - h2) + '" width="' + bw + '" height="' + h2 + '"><title>' + nhan + ': xuất ' + xuat[i] + '</title></rect>';
    s += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">T' + Number(k.slice(5)) + '</text>';
  });
  $('chart').innerHTML = s + '</svg>';
  var dem = {};
  DB.phieu.forEach(function (p) { if (p.loai === 'X' && HMAP[p.ma] && HMAP[p.ma].nhom !== 'Dịch vụ' && (p.ngay || '').slice(0, 4) === nam) dem[p.ma] = (dem[p.ma] || 0) + 1; });
  var top5 = Object.keys(dem).sort(function (a, b) { return dem[b] - dem[a]; }).slice(0, 5), mx = top5.length ? dem[top5[0]] : 1;
  $('rank').innerHTML = top5.length ? top5.map(function (ma) { return '<li><span><b>' + esc(ma) + '</b> <span class="sub">' + esc(HMAP[ma].ten) + '</span></span><span class="num">' + dem[ma] + '</span><span class="bar"><i style="width:' + (dem[ma] / mx * 100) + '%"></i></span></li>'; }).join('') : '<li class="sub" style="display:block">Chưa có phiếu xuất năm nay.</li>';
  veNhom(T);
  var o = { 'Âm kho': 0, 'Hết hàng': 1, 'Lệch kiểm kê': 2, 'Sắp hết': 3 };
  var can = DB.hang.filter(function (h) { return o[T[h.ma].tt] != null && !(T[h.ma].tt === 'Hết hàng' && !daBanGanDay(h.ma)); }).sort(function (a, b) { return o[T[a.ma].tt] - o[T[b.ma].tt]; });
  $('can-dem').textContent = can.length + ' mặt hàng · hết hàng chỉ tính mã có bán trong 12 tháng';
  $('t-can').innerHTML = can.length ? '<thead><tr><th>Mã</th><th>Tên hàng</th><th class="r">Tồn</th><th class="r">Tối thiểu</th><th>Trạng thái</th><th>Việc nên làm</th></tr></thead><tbody>' +
    can.slice(0, 60).map(function (h) {
      var t = T[h.ma];
      var viec = t.tt === 'Lệch kiểm kê' ? 'Đếm lại: sổ ' + so(t.kkTon) + ', thực tế ' + so(t.kk) : t.tt === 'Âm kho' ? 'Kiểm tra phiếu xuất bị nhập dư' : t.tt === 'Hết hàng' ? 'Đặt hàng nếu còn bán' : 'Đặt thêm';
      return '<tr class="go" data-ma="' + esc(h.ma) + '"><td><b>' + esc(h.ma) + '</b></td><td style="white-space:normal">' + esc(h.ten) + '</td><td class="r">' + so(t.so) + '</td><td class="r">' + (h.min ? so(h.min) : '') + '</td><td>' + st(t.tt) + '</td><td class="sub">' + esc(viec) + '</td></tr>';
    }).join('') + '</tbody>' : '<tr><td class="empty">Không có mặt hàng nào cần xử lý.</td></tr>';
  ganDong($('t-can'), function (ma) { if (T[ma].tt === 'Lệch kiểm kê') den('kiem-ke'); else xemLichSu(ma); });
}
function veNhom(T) {
  var g = {};
  DB.hang.forEach(function (h) {
    if (h.nhom === 'Dịch vụ') return;
    var k = h.nhom || 'Chưa phân nhóm', t = T[h.ma].tt;
    if (!g[k]) g[k] = { con: 0, sap: 0, het: 0, lech: 0, n: 0 };
    g[k].n++;
    if (t === 'Còn hàng') g[k].con++; else if (t === 'Sắp hết') g[k].sap++; else if (t === 'Hết hàng') g[k].het++; else g[k].lech++;
  });
  var ds = Object.keys(g).sort(function (x, y) { return g[y].n - g[x].n; }), mx = ds.length ? g[ds[0]].n : 1;
  $('nhom-chart').innerHTML = ds.map(function (k) {
    var v = g[k], seg = function (n, mau, ten) { return n ? '<i style="width:' + (n / v.n * 100) + '%;background:var(' + mau + ')" title="' + ten + ': ' + n + '"></i>' : ''; };
    return '<button type="button" class="hb" data-nhom="' + esc(k) + '" title="' + esc(k) + ': ' + v.con + ' còn hàng, ' + v.sap + ' sắp hết, ' + v.het + ' hết hàng, ' + v.lech + ' lệch">' +
      '<span class="nm">' + esc(k) + '</span><span class="tr"><span class="sg" style="width:' + (v.n / mx * 100) + '%">' + seg(v.con, '--ok', 'Còn hàng') + seg(v.sap, '--warn', 'Sắp hết') + seg(v.het, '--het', 'Hết hàng') + seg(v.lech, '--bad', 'Lệch / âm') + '</span></span>' +
      '<span class="n"><b>' + v.con + '</b> / ' + v.n + ' còn</span></button>';
  }).join('') || '<p class="sub">Chưa có mặt hàng.</p>';
  Array.prototype.forEach.call($('nhom-chart').querySelectorAll('[data-nhom]'), function (b) {
    b.onclick = function () { var k = b.dataset.nhom; $('k-tim').value = ''; $('k-tt').value = ''; $('k-nhom').value = k === 'Chưa phân nhóm' ? '' : k; veTon(); den('ton-kho'); };
  });
}
// Lượng bán 12 tháng gần nhất của từng mã (tính cả lịch sử cũ)
function banNam() {
  var moc = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), b = {};
  DB.phieu.forEach(function (p) { if (p.loai === 'X' && (p.ngay || '') >= moc) b[p.ma] = (b[p.ma] || 0) + p.sl; });
  return b;
}
function daBanGanDay(ma) {
  var moc = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return DB.phieu.some(function (p) { return p.ma === ma && p.loai === 'X' && (p.ngay || '') >= moc; });
}
function stat(c, n, l, k, ghi) { return '<div class="stat ' + c + (n ? '' : ' zero') + '"><div class="stat-t"><span class="lb">' + l + '</span><span class="chip">' + ico(k) + '</span></div><span class="v">' + n + '</span><span class="cap">' + ghi + '</span></div>'; }

/* ============ PHIẾU NHIỀU DÒNG ============ */
var loai = 'N', soDong = 0, dangLuu = false;
function datLoai(l) {
  loai = l;
  $('seg-n').setAttribute('aria-pressed', l === 'N'); $('seg-x').setAttribute('aria-pressed', l === 'X');
  $('ph-title').textContent = l === 'N' ? 'Phiếu nhập' : 'Phiếu xuất';
  $('lb-dt').textContent = l === 'N' ? 'Nhà cung cấp' : 'Khách hàng';
  $('p-luu').textContent = l === 'N' ? 'Lưu phiếu nhập' : 'Lưu phiếu xuất';
  $('dl-dt').innerHTML = doiTacTheo(l).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  $('p-dt').value = ''; $('p-sohd').value = ''; bao('p-msg');
  $('lines').innerHTML = ''; soDong = 0; themDong(); themDong();
}
function themDong() {
  soDong++;
  var id = 'ln' + soDong, d = document.createElement('div');
  d.className = 'line'; d.id = id;
  d.innerHTML = '<span class="idx"></span>' +
    '<div class="f"><label class="sr" for="' + id + '-ma">Mặt hàng</label><input id="' + id + '-ma" class="ln-ma" list="dl-ma" placeholder="Gõ mã hoặc tên" autocomplete="off"></div>' +
    '<div class="f"><label class="sr" for="' + id + '-sl">Số lượng</label><input id="' + id + '-sl" class="ln-sl num" type="number" min="0" step="any" inputmode="decimal" placeholder="SL"></div>' +
    '<span class="hint"></span><button class="icon-btn" type="button" aria-label="Bỏ dòng này">×</button>';
  $('lines').appendChild(d);
  d.querySelector('.ln-ma').addEventListener('input', function () { goiYDong(d); });
  d.querySelector('.ln-sl').addEventListener('input', function () { goiYDong(d); });
  d.querySelector('.icon-btn').onclick = function () { if ($('lines').children.length > 1) { d.remove(); danhSo(); } else { d.querySelector('.ln-ma').value = ''; d.querySelector('.ln-sl').value = ''; goiYDong(d); } };
  danhSo(); return d;
}
function danhSo() { Array.prototype.forEach.call($('lines').children, function (d, i) { d.querySelector('.idx').textContent = i + 1; }); }
function goiYDong(d) {
  var raw = d.querySelector('.ln-ma').value.trim(), ma = maTu(raw), sl = Number(d.querySelector('.ln-sl').value), hint = d.querySelector('.hint');
  hint.className = 'hint';
  if (!raw) { hint.textContent = ''; return; }
  if (!ma) { hint.textContent = 'Không có trong danh mục'; hint.className = 'hint bad'; return; }
  var h = HMAP[ma], t = tinhTon()[ma].so;
  if (h.nhom === 'Dịch vụ') { hint.textContent = 'Dịch vụ, không tính tồn'; return; }
  hint.textContent = 'Tồn ' + so(t) + ' ' + String(h.dvt).toLowerCase();
  if (loai === 'X' && sl > t) { hint.textContent += ', không đủ'; hint.className = 'hint bad'; }
}
function goiYTatCaDong() { Array.prototype.forEach.call($('lines').children, goiYDong); }
$('add-line').onclick = function () { themDong().querySelector('.ln-ma').focus(); };
$('seg-n').onclick = function () { datLoai('N'); };
$('seg-x').onclick = function () { datLoai('X'); };
$('go-nhap').onclick = function () { datLoai('N'); den('phieu'); $('p-dt').focus(); };
$('go-xuat').onclick = function () { datLoai('X'); den('phieu'); $('p-dt').focus(); };
function soKeTiep(lo) {
  var pre = soPhieu(lo, 0).slice(0, 3), max = 0;
  DB.phieu.forEach(function (p) { if (p.so && p.so.indexOf(pre) === 0) max = Math.max(max, Number(p.so.slice(3)) || 0); });
  return soPhieu(lo, max + 1);
}
// Ghi một phiếu: N vào Nhap, X vào Xuat, D tách dòng tăng vào Nhap, dòng giảm vào Xuat
async function ghiPhieu(lo, dau, dong) {
  var sp = soKeTiep(lo), nhap = [], xuat = [];
  dong.forEach(function (x) {
    var h = HMAP[x.ma] || {}, tang = lo === 'N' || (lo === 'D' && x.sl > 0);
    if (tang) nhap.push([dau.ngay, dau.doiTac, x.ma, Math.abs(x.sl), h.dvt || '', dau.gia || '', dau.hd, dau.gc || '', '', email, sp]);
    else xuat.push([dau.ngay, dau.soHD || '', dau.doiTac, x.ma, Math.abs(x.sl), h.dvt || '', dau.hd, dau.gc || '', '', email, sp]);
  });
  if (nhap.length) { await damBaoCotSoPhieu('Nhap'); await ghiDong('Nhap', nhap); }
  if (xuat.length) { await damBaoCotSoPhieu('Xuat'); await ghiDong('Xuat', xuat); }
  return sp;
}
$('f-phieu').addEventListener('submit', async function (e) {
  e.preventDefault(); if (dangLuu) return;
  var ngay = $('p-ngay').value, dt = $('p-dt').value.trim(), loi = [], dong = [], tong = {};
  if (!ngay) loi.push('Chưa chọn ngày.'); else if (ngay > HOM_NAY) loi.push('Ngày ở tương lai, kiểm tra lại.');
  if (!dt) loi.push(loai === 'N' ? 'Chưa nhập nhà cung cấp.' : 'Chưa nhập khách hàng.');
  if (loai === 'X' && $('p-hd').value === 'Y' && !$('p-sohd').value.trim()) loi.push('Có hóa đơn nhưng chưa nhập số hóa đơn.');
  Array.prototype.forEach.call($('lines').children, function (d, i) {
    var raw = d.querySelector('.ln-ma').value.trim(), slRaw = d.querySelector('.ln-sl').value, ma = maTu(raw), sl = Number(slRaw);
    if (!raw && !slRaw) return;
    if (!ma) { loi.push('Dòng ' + (i + 1) + ': mặt hàng không có trong danh mục.'); return; }
    if (!(sl > 0)) { loi.push('Dòng ' + (i + 1) + ': số lượng phải lớn hơn 0.'); return; }
    if (tong[ma]) { loi.push('Dòng ' + (i + 1) + ': ' + ma + ' bị lặp, gộp vào một dòng.'); return; }
    tong[ma] = sl; dong.push({ ma: ma, sl: sl });
  });
  if (!dong.length && !loi.length) loi.push('Phiếu chưa có mặt hàng nào.');
  if (!loi.length && loai === 'X') { var T = tinhTon(); dong.forEach(function (x) { if (HMAP[x.ma].nhom !== 'Dịch vụ' && T[x.ma].so < x.sl) loi.push(x.ma + ': không đủ hàng, chỉ còn ' + so(T[x.ma].so) + ' ' + String(HMAP[x.ma].dvt).toLowerCase() + '.'); }); }
  if (loi.length) { bao('p-msg', 'err', loi.map(esc).join('<br>')); return; }
  dangLuu = true; $('p-luu').disabled = true; bao('p-msg', 'ok', 'Đang lưu vào Google Sheet…');
  try {
    var sp = await ghiPhieu(loai, { ngay: ngay, doiTac: dt, hd: $('p-hd').value, soHD: $('p-sohd').value.trim() }, dong);
    var l = loai; await napDuLieu(false); datLoai(l);
    bao('p-msg', 'ok', 'Đã lưu phiếu <b>' + sp + '</b>: ' + dong.length + ' mặt hàng, ' + esc(dt) + '.');
  } catch (err) { bao('p-msg', 'err', loiGhi(err)); }
  dangLuu = false; $('p-luu').disabled = false;
});
function veGan() {
  var ds = DB.phieuDoc.filter(function (p) { return !p.cu; }).sort(function (a, b) { return (a.ngay || '') < (b.ngay || '') ? 1 : (a.ngay || '') > (b.ngay || '') ? -1 : (b.dong[0].row - a.dong[0].row); }).slice(0, 15);
  $('t-gan').innerHTML = ds.length ? '<thead><tr><th>Số phiếu</th><th>Ngày</th><th>Loại</th><th>Đối tác</th><th>Mặt hàng</th><th>Hóa đơn</th><th>Người lập</th><th></th></tr></thead><tbody>' +
    ds.map(function (p, i) {
      var mt = p.dong.map(function (x) { return x.ma + ' ' + soDau(hienSL(x)); }).join(', ');
      var xoa = p.so && (!p.nguoi || p.nguoi === email);
      return '<tr><td><b>' + esc(p.so || '—') + '</b></td><td class="num">' + ngayVN(p.ngay) + '</td><td><span class="pill ' + (p.loai === 'N' ? 'in' : p.loai === 'X' ? 'out' : 'neu') + '">' + TEN_LOAI[p.loai] + '</span></td><td>' + esc(p.doiTac) + '</td><td class="sub" style="white-space:normal;min-width:220px">' + esc(mt) + '</td><td class="sub">' + (p.loai === 'D' ? '' : p.hd === 'Y' ? (p.soHD ? 'Số ' + esc(p.soHD) : 'Có') : 'Không') + '</td><td class="sub">' + esc(p.nguoi || '') + '</td><td class="r">' +
        (xoa ? '<button class="btn sec xs" type="button" data-xoa="' + esc(p.so) + '">Xóa</button>' : '') + '</td></tr>';
    }).join('') + '</tbody>' : '<tr><td class="empty">Chưa có phiếu mới nào. Phiếu lịch sử cũ xem ở mục Lịch sử.</td></tr>';
  Array.prototype.forEach.call($('t-gan').querySelectorAll('[data-xoa]'), function (b) {
    b.onclick = function () {
      var sp = b.dataset.xoa;
      hoiXacNhan('Xóa phiếu ' + sp + '?', 'Các dòng của phiếu này sẽ bị xóa khỏi Google Sheet, tồn kho tính lại.', 'Xóa phiếu', async function () {
        try { await xoaPhieu(sp); bao('p-msg', 'ok', 'Đã xóa phiếu ' + esc(sp) + '.'); } catch (err) { bao('p-msg', 'err', loiGhi(err)); }
      });
    };
  });
}
async function xoaPhieu(sp) {
  await napDuLieu(false); // lấy số dòng mới nhất trước khi xóa
  var dong = DB.phieu.filter(function (p) { return p.so === sp && !p.cu; });
  if (!dong.length) return;
  var req = dong.sort(function (a, b) { return a.sheet === b.sheet ? b.row - a.row : a.sheet < b.sheet ? -1 : 1; })
    .map(function (p) { return { deleteDimension: { range: { sheetId: SHEET_IDS[p.sheet], dimension: 'ROWS', startIndex: p.row - 1, endIndex: p.row } } }; });
  await api(':batchUpdate', { method: 'POST', body: { requests: req } });
  await napDuLieu(false);
}

/* ============ TỒN KHO ============ */
function veTon() {
  var T = tinhTon(), B = banNam(), q = boDau($('k-tim').value.trim()), nhom = $('k-nhom').value, tt = $('k-tt').value;
  var rows = DB.hang.filter(function (h) { if (q && boDau(h.ma + ' ' + h.ten).indexOf(q) < 0) return false; if (nhom && h.nhom !== nhom) return false; if (tt && T[h.ma].tt !== tt) return false; return true; });
  $('k-dem').textContent = rows.length + ' mặt hàng. Bấm một dòng để xem lịch sử.';
  $('t-ton').innerHTML = rows.length ? '<thead><tr><th>Mã</th><th>Tên hàng</th><th>Nhóm</th><th class="r">Tồn</th><th>ĐVT</th><th class="r">Tối thiểu</th><th class="r">Đếm gần nhất</th><th>Trạng thái</th></tr></thead><tbody>' +
    rows.map(function (h) { var t = T[h.ma], dv = h.nhom === 'Dịch vụ'; return '<tr class="go' + (t.so <= 0 && !dv ? ' dim' : '') + '" data-ma="' + esc(h.ma) + '"><td><b>' + esc(h.ma) + '</b></td><td style="white-space:normal">' + esc(h.ten) + '</td><td class="sub">' + esc(h.nhom) + '</td><td class="r">' + (dv ? '–' : mucTon(t.so, B[h.ma] || 0, h.min)) + '</td><td class="sub">' + esc(h.dvt) + '</td><td class="r">' + (h.min ? so(h.min) : '') + '</td><td class="r">' + (t.kk == null || dv ? '' : so(t.kk) + (t.lech ? ' (' + soDau(t.lech) + ')' : '')) + '</td><td>' + st(t.tt) + '</td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Không có mặt hàng nào khớp bộ lọc.</td></tr>';
  ganDong($('t-ton'), xemLichSu);
}
// Thanh mức tồn: so với lượng bán 3 tháng; chưa bán thì so với mức tối thiểu
function mucTon(ton, ban, min) {
  var ref = ban > 0 ? ban / 4 : min > 0 ? min * 2 : 0, pct, c, ghi;
  if (ton <= 0) { pct = 0; c = 'bad'; ghi = 'Hết hàng'; }
  else if (!ref) { pct = 100; c = 'neu'; ghi = 'Chưa bán trong 12 tháng'; }
  else { pct = Math.min(100, ton / ref * 100); c = pct < 34 ? 'bad' : pct < 67 ? 'warn' : ''; ghi = ban > 0 ? 'Đủ bán khoảng ' + Math.max(1, Math.round(ton / (ban / 365))) + ' ngày' : 'So với mức tối thiểu ' + so(min); }
  return '<span class="lv ' + c + '" title="' + ghi + '"><span class="bar"><i style="width:' + pct + '%"></i></span><b>' + so(ton) + '</b></span>';
}
['k-tim', 'k-nhom', 'k-tt'].forEach(function (id) { $(id).addEventListener('input', veTon); });

/* ============ KIỂM KÊ ============ */
$('kk-ma').addEventListener('input', function () { var ma = maTu(this.value); $('kk-hint').textContent = ma ? HMAP[ma].ten + ': sổ đang ghi ' + so(tinhTon()[ma].so) + ' ' + String(HMAP[ma].dvt).toLowerCase() : 'Chọn mặt hàng để xem sổ đang ghi bao nhiêu.'; });
$('f-kk').addEventListener('submit', async function (e) {
  e.preventDefault();
  var ngay = $('kk-ngay').value, ma = maTu($('kk-ma').value), raw = $('kk-sl').value, sl = Number(raw), loi = [];
  if (!ngay) loi.push('Chưa chọn ngày đếm.'); else if (ngay > HOM_NAY) loi.push('Ngày ở tương lai, kiểm tra lại.');
  if (!ma) loi.push('Mặt hàng không có trong danh mục.'); else if (HMAP[ma].nhom === 'Dịch vụ') loi.push('Dịch vụ không cần kiểm kê.');
  if (raw === '' || !(sl >= 0)) loi.push('Số đếm phải từ 0 trở lên.');
  if (loi.length) { bao('kk-msg', 'err', loi.map(esc).join('<br>')); return; }
  var lech = sl - tonDen(ma, ngay);
  try {
    await ghiDong('KiemKe', [[ngay, ma, sl, $('kk-gc').value.trim(), email]]);
    await napDuLieu(false);
    bao('kk-msg', lech ? 'err' : 'ok', lech ? esc(ma) + ': đếm được ' + so(sl) + ', sổ ghi ' + so(sl - lech) + ', lệch ' + soDau(lech) + '. Xem mục "Đang lệch với sổ" bên dưới.' : esc(ma) + ': số đếm khớp với sổ.');
    $('kk-ma').value = ''; $('kk-sl').value = ''; $('kk-gc').value = ''; $('kk-hint').textContent = 'Chọn mặt hàng để xem sổ đang ghi bao nhiêu.';
  } catch (err) { bao('kk-msg', 'err', loiGhi(err)); }
});
function veKiemKe() {
  var T = tinhTon(), lech = DB.hang.filter(function (h) { return T[h.ma].lech !== 0; });
  $('lech-dem').textContent = lech.length + ' mặt hàng';
  $('t-lech').innerHTML = lech.length ? '<thead><tr><th>Mã</th><th>Tên hàng</th><th>Ngày đếm</th><th class="r">Sổ ghi</th><th class="r">Đếm được</th><th class="r">Lệch</th><th></th></tr></thead><tbody>' +
    lech.map(function (h) { var t = T[h.ma]; return '<tr><td><b>' + esc(h.ma) + '</b></td><td style="white-space:normal">' + esc(h.ten) + '</td><td class="num">' + ngayVN(t.kkNgay) + '</td><td class="r">' + so(t.kkTon) + '</td><td class="r">' + so(t.kk) + '</td><td class="r out">' + soDau(t.lech) + '</td><td class="r"><button class="btn sec xs" type="button" data-dc="' + esc(h.ma) + '">Điều chỉnh sổ</button></td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Không có mặt hàng nào lệch. Sổ đang khớp số đếm gần nhất.</td></tr>';
  Array.prototype.forEach.call($('t-lech').querySelectorAll('[data-dc]'), function (b) {
    b.onclick = function () {
      var ma = b.dataset.dc, t = tinhTon()[ma];
      hoiXacNhan('Điều chỉnh sổ ' + ma + '?', 'Sổ sẽ đổi từ ' + so(t.kkTon) + ' thành ' + so(t.kk) + ' (' + soDau(t.lech) + ') theo số đếm ngày ' + ngayVN(t.kkNgay) + '. Chỉ làm khi đã xác nhận số đếm đúng.', 'Điều chỉnh', async function () {
        try {
          var sp = await ghiPhieu('D', { ngay: t.kkNgay, doiTac: 'Kiểm kê', hd: 'N', gc: 'Điều chỉnh theo kiểm kê' }, [{ ma: ma, sl: t.lech }]);
          await napDuLieu(false);
          bao('kk-msg', 'ok', 'Đã tạo phiếu ' + sp + ': ' + esc(ma) + ' ' + soDau(t.lech) + '. Sổ đã khớp số đếm.');
        } catch (err) { bao('kk-msg', 'err', loiGhi(err)); }
      });
    };
  });
  var ls = DB.kiemKe.slice().sort(function (a, b) { return a.ngay < b.ngay ? 1 : a.ngay > b.ngay ? -1 : b.row - a.row; }).slice(0, 20);
  $('t-kk').innerHTML = ls.length ? '<thead><tr><th>Ngày</th><th>Mã</th><th>Tên hàng</th><th class="r">Đếm được</th><th>Ghi chú</th><th>Người đếm</th></tr></thead><tbody>' +
    ls.map(function (k) { return '<tr><td class="num">' + ngayVN(k.ngay) + '</td><td><b>' + esc(k.ma) + '</b></td><td style="white-space:normal">' + esc(HMAP[k.ma] ? HMAP[k.ma].ten : '') + '</td><td class="r">' + so(k.sl) + '</td><td class="sub" style="white-space:normal">' + esc(k.gc) + '</td><td class="sub">' + esc(k.nguoi) + '</td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Chưa có lần kiểm kê nào.</td></tr>';
}

/* ============ DANH MỤC ============ */
var dmSua = '';
function moFormDM(ma) {
  dmSua = ma || ''; bao('dm-msg');
  var h = ma ? HMAP[ma] : null, coGD = ma && DB.phieu.some(function (p) { return p.ma === ma; });
  $('dm-title').textContent = h ? 'Sửa ' + ma : 'Thêm mặt hàng mới';
  $('dm-luu').textContent = h ? 'Lưu thay đổi' : 'Thêm vào danh mục';
  $('dm-ma').value = h ? h.ma : ''; $('dm-ma').readOnly = !!h;
  $('dm-ten').value = h ? h.ten : ''; $('dm-dvt').value = h ? h.dvt : ''; $('dm-nhom').value = h ? h.nhom : '';
  $('dm-min').value = h ? (h.min || '') : ''; $('dm-dau').value = h ? h.dau : '0'; $('dm-dau').readOnly = !!coGD;
  $('dm-hint').textContent = h ? (coGD ? 'Mã và tồn chuẩn đã có giao dịch nên không đổi được. Sửa tên, ĐVT, nhóm, tồn tối thiểu.' : 'Mã không đổi được. Muốn đổi mã thì thêm mã mới.') : 'Mã viết hoa, không dấu, không khoảng trắng.';
  veDanhMuc();
}
$('dm-moi').onclick = function () { moFormDM(''); $('dm-ma').focus(); };
$('dm-ma').addEventListener('input', function () { if (!this.readOnly) { var p = this.selectionStart; this.value = boDau(this.value).toUpperCase().replace(/\s+/g, '-'); try { this.setSelectionRange(p, p); } catch (e) {} } });
$('f-dm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var ma = $('dm-ma').value.trim(), ten = $('dm-ten').value.trim(), dvt = $('dm-dvt').value.trim(), nhom = $('dm-nhom').value.trim();
  var min = $('dm-min').value === '' ? 0 : Number($('dm-min').value), dau = $('dm-dau').value === '' ? 0 : Number($('dm-dau').value), loi = [];
  if (!dmSua) { if (!ma) loi.push('Chưa nhập mã hàng.'); else if (!/^[A-Z0-9][A-Z0-9.\-]*$/.test(ma)) loi.push('Mã chỉ gồm chữ in hoa không dấu, số, dấu gạch ngang hoặc dấu chấm.'); else if (HMAP[ma]) loi.push('Mã ' + ma + ' đã có trong danh mục.'); }
  if (!ten) loi.push('Chưa nhập tên hàng.');
  if (!dvt) loi.push('Chưa nhập đơn vị tính.');
  if (!nhom) loi.push('Chưa chọn nhóm.');
  if (!(min >= 0)) loi.push('Tồn tối thiểu phải từ 0 trở lên.');
  if (!(dau >= 0)) loi.push('Tồn chuẩn phải từ 0 trở lên.');
  if (loi.length) { bao('dm-msg', 'err', loi.map(esc).join('<br>')); return; }
  try {
    if (dmSua) {
      var h = HMAP[dmSua];
      await api('/values/' + encodeURIComponent('DanhMuc!A' + h.row + ':G' + h.row) + '?valueInputOption=RAW', { method: 'PUT', body: { values: [[h.ma, ten, dvt, nhom, min || '', h.gc || '', $('dm-dau').readOnly ? h.dau : dau]] } });
      await napDuLieu(false); bao('dm-msg', 'ok', 'Đã lưu thay đổi cho ' + esc(dmSua) + '.');
    } else {
      await ghiDong('DanhMuc', [[ma, ten, dvt, nhom, min || '', '', dau]]);
      await napDuLieu(false); dmSua = ma; veDanhMuc(); bao('dm-msg', 'ok', 'Đã thêm ' + esc(ma) + ' vào danh mục.');
    }
  } catch (err) { bao('dm-msg', 'err', loiGhi(err)); }
});
function veDanhMuc() {
  var T = tinhTon();
  $('dm-dem').textContent = DB.hang.length + ' mặt hàng. Bấm một dòng để sửa.';
  $('t-dm').innerHTML = DB.hang.length ? '<thead><tr><th>Mã</th><th>Tên hàng</th><th>ĐVT</th><th>Nhóm</th><th class="r">Tồn chuẩn</th><th class="r">Tối thiểu</th><th class="r">Tồn hiện tại</th></tr></thead><tbody>' +
    DB.hang.map(function (h) { return '<tr class="go' + (h.ma === dmSua ? ' sel' : '') + '" data-ma="' + esc(h.ma) + '"><td><b>' + esc(h.ma) + '</b></td><td style="white-space:normal">' + esc(h.ten) + '</td><td class="sub">' + esc(h.dvt) + '</td><td class="sub">' + esc(h.nhom) + '</td><td class="r">' + so(h.dau) + '</td><td class="r">' + (h.min ? so(h.min) : '') + '</td><td class="r">' + (h.nhom === 'Dịch vụ' ? '–' : so(T[h.ma].so)) + '</td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Chưa có mặt hàng nào.</td></tr>';
  ganDong($('t-dm'), function (ma) { moFormDM(ma); $('dm-ten').focus(); });
}

/* ============ BÁO CÁO ============ */
var BC = [], BC_TEN = '';
function napNam() {
  var ys = {}; ys[HOM_NAY.slice(0, 4)] = 1;
  DB.phieu.forEach(function (p) { if (/^\d{4}/.test(p.ngay || '') && !p.cu) ys[p.ngay.slice(0, 4)] = 1; });
  var cur = $('b-nam').value || HOM_NAY.slice(0, 4);
  $('b-nam').innerHTML = Object.keys(ys).sort().reverse().map(function (y) { return '<option>' + y + '</option>'; }).join('');
  $('b-nam').value = ys[cur] ? cur : HOM_NAY.slice(0, 4);
}
// Báo cáo theo kỳ: đầu kỳ = tồn chuẩn + phiếu mới trước kỳ; nhập/xuất = phiếu mới trong kỳ
function veBC() {
  var quy = Number($('b-quy').value), nam = $('b-nam').value || HOM_NAY.slice(0, 4), chiHD = $('b-hd').value === 'Y';
  var tu = nam + '-' + ('0' + (quy * 3 - 2)).slice(-2) + '-01', den2 = nam + '-' + ('0' + (quy * 3)).slice(-2) + '-31', rows = [];
  DB.hang.forEach(function (h) {
    if (h.nhom === 'Dịch vụ') return;
    var dau = h.dau, n = 0, x = 0, dc = 0;
    DB.phieu.forEach(function (p) {
      if (p.ma !== h.ma || p.cu || (chiHD && p.loai !== 'D' && p.hd !== 'Y')) return;
      var ng = p.ngay || '';
      if (ng < tu) dau += delta(p);
      else if (ng <= den2) { if (p.loai === 'N') n += p.sl; else if (p.loai === 'X') x += p.sl; else dc += p.sl; }
    });
    var cuoi = dau + n - x + dc;
    if (dau || n || x || dc || cuoi) rows.push([h.ma, h.ten, h.dvt, dau, n, x, dc, cuoi]);
  });
  BC = rows; BC_TEN = 'Bao-cao-ton-kho-Q' + quy + '-' + nam + (chiHD ? '-co-hoa-don' : '-tat-ca');
  $('b-tieude').textContent = 'Quý ' + quy + '/' + nam + ', ' + (chiHD ? 'hàng có hóa đơn' : 'tất cả hàng') + ', ' + rows.length + ' mặt hàng';
  $('t-bc').innerHTML = rows.length ? '<thead><tr><th>Mã</th><th>Tên hàng</th><th>ĐVT</th><th class="r">Đầu kỳ</th><th class="r">Nhập</th><th class="r">Xuất</th><th class="r">Điều chỉnh</th><th class="r">Cuối kỳ</th></tr></thead><tbody>' +
    rows.map(function (r) { return '<tr' + (r[7] <= 0 ? ' class="dim"' : '') + '><td><b>' + esc(r[0]) + '</b></td><td style="white-space:normal">' + esc(r[1]) + '</td><td class="sub">' + esc(r[2]) + '</td><td class="r">' + so(r[3]) + '</td><td class="r">' + so(r[4]) + '</td><td class="r">' + so(r[5]) + '</td><td class="r">' + (r[6] ? soDau(r[6]) : '') + '</td><td class="r"><b>' + so(r[7]) + '</b></td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Kỳ này không có số liệu.</td></tr>';
}
['b-quy', 'b-nam', 'b-hd'].forEach(function (id) { $(id).addEventListener('input', function () { bao('b-msg'); veBC(); }); });
var DAU_BC = ['Mã', 'Tên hàng', 'ĐVT', 'Đầu kỳ', 'Nhập', 'Xuất', 'Điều chỉnh', 'Cuối kỳ'];
$('b-copy').onclick = function () {
  var tsv = [DAU_BC].concat(BC).map(function (r) { return r.join('\t'); }).join('\n');
  var fail = function () { bao('b-msg', 'err', 'Trình duyệt chặn sao chép. Bôi đen bảng rồi nhấn Ctrl+C.'); };
  try { navigator.clipboard.writeText(tsv).then(function () { bao('b-msg', 'ok', 'Đã sao chép ' + BC.length + ' dòng. Mở Excel và nhấn Ctrl+V.'); }, fail); } catch (e) { fail(); }
};
function luuExcel(tenFile, sheets, msgId) {
  if (!window.XLSX) { bao(msgId, 'err', 'Chưa tải được thư viện Excel. Kiểm tra mạng rồi thử lại.'); return; }
  var wb = XLSX.utils.book_new();
  sheets.forEach(function (s) { var ws = XLSX.utils.aoa_to_sheet(s.rows); ws['!cols'] = s.rows[0].map(function (_, i) { return { wch: i === 1 ? 36 : 14 }; }); XLSX.utils.book_append_sheet(wb, ws, s.ten); });
  XLSX.writeFile(wb, tenFile + '.xlsx');
  bao(msgId, 'ok', 'Đã tải ' + esc(tenFile) + '.xlsx.');
}
$('b-xlsx').hidden = false;
$('b-xlsx').onclick = function () { luuExcel(BC_TEN, [{ ten: 'Bao cao', rows: [DAU_BC].concat(BC) }], 'b-msg'); };
$('btn-backup').onclick = function () {
  var T = tinhTon();
  luuExcel('Kho-Hoanh-Uy-sao-luu-' + HOM_NAY, [
    { ten: 'Ton kho', rows: [['Mã', 'Tên hàng', 'ĐVT', 'Nhóm', 'Tồn', 'Tối thiểu', 'Trạng thái']].concat(DB.hang.map(function (h) { return [h.ma, h.ten, h.dvt, h.nhom, T[h.ma].so, h.min, T[h.ma].tt]; })) },
    { ten: 'Phieu moi', rows: [['Số phiếu', 'Ngày', 'Loại', 'Đối tác', 'Mã', 'Số lượng', 'Hóa đơn', 'Số HĐ', 'Người lập']].concat(DB.phieu.filter(function (p) { return !p.cu; }).map(function (p) { return [p.so, p.ngay, TEN_LOAI[p.loai], p.doiTac, p.ma, hienSL(p), p.hd === 'Y' ? 'Có' : 'Không', p.soHD, p.nguoi]; })) },
    { ten: 'Kiem ke', rows: [['Ngày', 'Mã', 'Số đếm', 'Ghi chú', 'Người đếm']].concat(DB.kiemKe.map(function (k) { return [k.ngay, k.ma, k.sl, k.gc, k.nguoi]; })) }
  ], 'b-msg');
  den('bao-cao');
};

/* ============ LỊCH SỬ ============ */
function veLichSu() {
  var ma = maTu($('l-ma').value);
  if (!ma) { $('l-tom').textContent = 'Chọn một mặt hàng để xem mọi lần nhập, xuất và điều chỉnh.'; $('t-ls').innerHTML = ''; $('l-chart-wrap').hidden = true; return; }
  var h = HMAP[ma], T = tinhTon()[ma], nam = HOM_NAY.slice(0, 4), rows = DB.phieu.filter(function (p) { return p.ma === ma; }).sort(function (a, b) { return (a.ngay || '') < (b.ngay || '') ? 1 : (a.ngay || '') > (b.ngay || '') ? -1 : 0; });
  var ban = rows.filter(function (p) { return p.loai === 'X' && (p.ngay || '').slice(0, 4) === nam; }), tong = 0, kh = {};
  ban.forEach(function (p) { tong += p.sl; kh[p.doiTac] = (kh[p.doiTac] || 0) + p.sl; });
  var top = Object.keys(kh).sort(function (a, b) { return kh[b] - kh[a]; })[0];
  $('l-tom').innerHTML = '<b>' + esc(ma) + '</b> ' + esc(h.ten) + ' · tồn ' + so(T.so) + ' ' + esc(String(h.dvt).toLowerCase()) + ' (tồn chuẩn ' + so(h.dau) + ') · năm nay bán ' + so(tong) + ' qua ' + ban.length + ' lần' + (top ? ' · mua nhiều nhất: ' + esc(top) : '');
  veDuongTon(ma, h, T.so, rows);
  $('t-ls').innerHTML = rows.length ? '<thead><tr><th>Ngày</th><th>Số phiếu</th><th class="r">Số lượng</th><th>Đối tác</th><th>Hóa đơn</th><th>Ghi chú</th></tr></thead><tbody>' +
    rows.map(function (p) { var d = hienSL(p); return '<tr' + (p.cu ? ' class="dim"' : '') + '><td class="num">' + ngayVN(p.ngay) + '</td><td>' + esc(p.so || (p.cu ? 'Lịch sử cũ' : '')) + '</td><td class="r ' + (p.cu ? '' : d > 0 ? 'in' : 'out') + '">' + soDau(d) + '</td><td>' + esc(p.doiTac) + '</td><td class="sub">' + (p.loai === 'D' ? '' : p.hd === 'Y' ? (p.soHD ? 'Số ' + esc(p.soHD) : 'Có') : 'Không') + '</td><td class="sub" style="white-space:normal">' + esc(p.gc) + '</td></tr>'; }).join('') + '</tbody>' : '<tr><td class="empty">Mặt hàng này chưa có giao dịch.</td></tr>';
}
// Đường tồn 12 tháng: tính lùi từ tồn hiện tại qua từng lần nhập/xuất (kể cả lịch sử cũ)
function veDuongTon(ma, h, tonNay, rows) {
  if (h.nhom === 'Dịch vụ') { $('l-chart-wrap').hidden = true; return; }
  $('l-chart-wrap').hidden = false;
  var DAY = 864e5, homNay = Date.parse(HOM_NAY), bd = homNay - 365 * DAY;
  var ev = rows.filter(function (p) { return /^\d{4}-\d{2}-\d{2}$/.test(p.ngay || ''); }).map(function (p) { return { t: Date.parse(p.ngay), d: hienSL(p), p: p }; })
    .sort(function (x, y) { return x.t - y.t || (x.p.row || 0) - (y.p.row || 0); });
  var sau = 0; ev.forEach(function (e) { if (e.t > bd) sau += e.d; });
  var muc = tonNay - sau, ds = [], lo = Math.min(0, muc), hi = Math.max(muc, h.min || 0, 1);
  ev.forEach(function (e) { if (e.t <= bd || e.t > homNay) return; muc += e.d; ds.push({ t: e.t, v: muc, d: e.d, p: e.p }); lo = Math.min(lo, muc); hi = Math.max(hi, muc); });
  var dau = tonNay - sau;
  var raw = (hi - lo) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw || 1))), step = [1, 2, 5, 10].map(function (k) { return k * mag; }).filter(function (s) { return s >= raw; })[0] || mag * 10;
  var top = Math.ceil(hi / step) * step, bot = Math.floor(lo / step) * step;
  var W = 900, H = 240, L = 44, R = 12, T0 = 12, B = 28, iw = W - L - R, ih = H - T0 - B;
  var X = function (t) { return L + (t - bd) / (homNay - bd) * iw; }, Y = function (v) { return T0 + (top - v) / (top - bot || 1) * ih; };
  var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Tồn kho ' + esc(ma) + ' 12 tháng gần nhất">';
  for (var g = bot; g <= top + 1e-9; g += step) s += '<line class="g" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g) + '" y2="' + Y(g) + '"/><text x="' + (L - 6) + '" y="' + (Y(g) + 4) + '" text-anchor="end">' + so(Math.round(g * 100) / 100) + '</text>';
  var d0 = new Date(bd); d0 = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
  for (; d0.getTime() <= homNay; d0 = new Date(d0.getFullYear(), d0.getMonth() + 1, 1)) s += '<text x="' + X(d0.getTime()) + '" y="' + (H - 8) + '" text-anchor="middle">T' + (d0.getMonth() + 1) + '</text>';
  if (h.min > 0) s += '<line class="mn" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(h.min) + '" y2="' + Y(h.min) + '"/>';
  var path = 'M' + X(bd) + ' ' + Y(dau), v = dau;
  ds.forEach(function (e) { path += ' H' + X(e.t) + ' V' + Y(e.v); v = e.v; });
  path += ' H' + X(homNay);
  s += '<path class="area" d="' + path + ' V' + Y(Math.max(bot, 0)) + ' H' + X(bd) + ' Z"/><path class="ln" d="' + path + '"/>';
  ds.forEach(function (e) { s += '<circle class="' + (e.d >= 0 ? 'di' : 'do') + '" cx="' + X(e.t) + '" cy="' + Y(e.v) + '" r="4.5"><title>' + ngayVN(e.p.ngay) + ': ' + (e.d >= 0 ? 'nhập ' : 'xuất ') + so(Math.abs(e.d)) + (e.p.doiTac ? ' · ' + esc(e.p.doiTac) : '') + ' → tồn ' + so(e.v) + '</title></circle>'; });
  $('l-chart').innerHTML = s + '</svg>';
  $('l-chart-cap').textContent = ds.length ? ds.length + ' lần nhập/xuất trong 12 tháng. Rê chuột vào chấm để xem chi tiết. Đường tồn tính lùi từ tồn hiện tại.' : 'Không có nhập/xuất trong 12 tháng gần nhất, tồn giữ nguyên ' + so(tonNay) + '.';
}
$('l-ma').addEventListener('input', veLichSu);

/* ============ HỎI KHO ============ */
var BO_QUA = ['con', 'khong', 'ko', 'k', 'bao', 'nhieu', 'ton', 'kho', 'co', 'cai', 'hang', 'mon', 'oi', 'nhe', 'vay', 'xem', 'cho', 'toi', 'minh', 'a', 'ma'];
function timHang(q) { var tk = boDau(q).replace(/[?!.,]/g, ' ').split(/\s+/).filter(function (t) { return t && BO_QUA.indexOf(t) < 0; }); if (!tk.length) return []; return DB.hang.filter(function (h) { var s = boDau(h.ma + ' ' + h.ten + ' ' + h.nhom); var g = s.replace(/[\s\-_]/g, ''); return tk.every(function (t) { return s.indexOf(t) >= 0 || g.indexOf(t.replace(/[\-_]/g, '')) >= 0; }); }); }
function traLoi(q) {
  var T = tinhTon(), qn = boDau(q), nam = HOM_NAY.slice(0, 4);
  var khach = doiTacTheo('X').filter(function (k) { var w = boDau(k); return w.length > 2 && qn.indexOf(w) >= 0; })[0];
  if (khach) {
    var s = {};
    DB.phieu.forEach(function (p) { if (p.loai === 'X' && p.doiTac === khach && (p.ngay || '').slice(0, 4) === nam) s[p.ma] = (s[p.ma] || 0) + p.sl; });
    var top = Object.keys(s).sort(function (a, b) { return s[b] - s[a]; }).slice(0, 5);
    if (!top.length) return khach + ' chưa mua gì năm ' + nam + '.';
    return khach + ': năm ' + nam + ' mua nhiều nhất là\n\n' + top.map(function (ma) { return ma + ' · ' + (HMAP[ma] ? HMAP[ma].ten : '') + '\n' + so(s[ma]) + ' ' + (HMAP[ma] ? String(HMAP[ma].dvt).toLowerCase() : ''); }).join('\n\n');
  }
  if (/\bhet\b|dat hang|can dat/.test(qn) && !/\bcon\b/.test(qn)) {
    var ds = DB.hang.filter(function (h) { return (T[h.ma].tt === 'Hết hàng' && daBanGanDay(h.ma)) || T[h.ma].tt === 'Sắp hết'; });
    if (!ds.length) return 'Không có mã nào hết hoặc sắp hết (trong số mã có bán 12 tháng gần đây).';
    return 'Cần xem đặt thêm ' + ds.length + ' mã:\n\n' + ds.slice(0, 15).map(function (h) { return h.ma + ' · ' + h.ten + '\n' + T[h.ma].tt + ': còn ' + so(T[h.ma].so); }).join('\n\n');
  }
  var mDu = qn.match(/du\s*(?:giao)?\s*(\d+)\s+(.+)/);
  if (mDu) { var can = Number(mDu[1]), f = timHang(mDu[2]).filter(function (h) { return h.nhom !== 'Dịch vụ'; }); if (!f.length) return 'Không tìm thấy mặt hàng "' + mDu[2] + '". Thử gõ mã hàng.'; return f.slice(0, 4).map(function (h) { var t = T[h.ma].so; return h.ma + ' · ' + h.ten + '\nCần ' + can + ', còn ' + so(t) + (t >= can ? ': đủ' : ': thiếu ' + so(can - t)); }).join('\n\n'); }
  var kq = timHang(q).filter(function (h) { return h.nhom !== 'Dịch vụ'; });
  if (!kq.length) return 'Mình chưa hiểu câu này. Thử hỏi:\n· còn béc 0.4 không\n· hàng nào sắp hết\n· đủ giao 5 béc 0.4 không\n· hoặc gõ tên khách hàng';
  var con = kq.filter(function (h) { return T[h.ma].so > 0; });
  return con.length + '/' + kq.length + ' mã còn hàng:\n\n' + kq.slice(0, 6).map(function (h) { var t = T[h.ma]; return h.ma + ' · ' + h.ten + '\nCòn ' + so(t.so) + ' ' + String(h.dvt).toLowerCase() + (t.tt !== 'Còn hàng' ? ' (' + t.tt.toLowerCase() + ')' : ''); }).join('\n\n');
}
function them(text, who) { var d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = text; $('chat').appendChild(d); $('chat').scrollTop = $('chat').scrollHeight; }
function hoi(q) { if (!q.trim()) return; them(q, 'me'); them(traLoi(q), 'bot'); }
$('f-ask').addEventListener('submit', function (e) { e.preventDefault(); hoi($('c-in').value); $('c-in').value = ''; });
var GOI_Y = ['còn béc 0.4 không', 'hàng nào sắp hết', 'đủ giao 5 béc 0.4 không', 'keo VM457'];
$('sugs').innerHTML = GOI_Y.map(function (g, i) { return '<button class="sug" type="button" data-i="' + i + '">' + esc(g) + '</button>'; }).join('');
Array.prototype.forEach.call($('sugs').children, function (b) { b.onclick = function () { hoi(GOI_Y[b.dataset.i]); }; });
them('Chào bạn. Hỏi mình về tồn kho, hoặc bấm một gợi ý phía trên.', 'bot');

/* ============ VẼ LẠI ============ */
function napDanhSach() {
  $('dl-ma').innerHTML = DB.hang.map(function (h) { return '<option value="' + esc(h.ma + ' · ' + h.ten) + '">'; }).join('');
  var nhoms = [], dvts = [];
  DB.hang.forEach(function (h) { if (h.nhom && nhoms.indexOf(h.nhom) < 0) nhoms.push(h.nhom); if (h.dvt && dvts.indexOf(h.dvt) < 0) dvts.push(h.dvt); });
  nhoms.sort(); dvts.sort();
  $('dl-nhom').innerHTML = nhoms.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
  $('dl-dvt').innerHTML = dvts.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
  var cur = $('k-nhom').value;
  $('k-nhom').innerHTML = '<option value="">Tất cả nhóm</option>' + nhoms.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
  $('k-nhom').value = cur;
  $('dl-dt').innerHTML = doiTacTheo(loai).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
}
var hen = 0;
function veTatCa() { clearTimeout(hen); hen = setTimeout(function () { napDanhSach(); napNam(); veTongQuan(); veGan(); veTon(); veKiemKe(); veDanhMuc(); veBC(); veLichSu(); goiYTatCaDong(); }, 0); }
function banner(kieu, text) { var b = $('banner'); if (!text) { b.hidden = true; b.innerHTML = ''; return; } b.hidden = false; b.innerHTML = '<div class="note ' + kieu + '">' + esc(text) + '</div>'; }

/* ============ KHỞI ĐỘNG ============ */
$('p-ngay').value = HOM_NAY; $('p-ngay').max = HOM_NAY;
$('kk-ngay').value = HOM_NAY; $('kk-ngay').max = HOM_NAY;
$('b-quy').value = String(Math.floor((Number(HOM_NAY.slice(5, 7)) - 1) / 3) + 1);
$('l-ma').value = '';
datLoai('N'); moFormDM('');
hienDangNhap(true);
khoiTaoDangNhap();
