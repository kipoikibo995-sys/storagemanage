# Kho Hoành Uy

App web quản lý kho, đọc và ghi thẳng vào Google Sheet **Kho Hoanh Uy - Du lieu** bằng tài khoản Google của người dùng. Không có máy chủ riêng: dữ liệu nằm trong Google Sheet, app chỉ là trang web tĩnh.

## Tính năng
- Tổng quan: còn hàng, sắp hết, hết hàng, lệch kiểm kê, biểu đồ nhập xuất 12 tháng
- Phiếu nhập / xuất nhiều mặt hàng, tự đánh số PN-…, PX-…, chặn xuất vượt tồn
- Kiểm kê và điều chỉnh sổ theo số đếm (phiếu DC-…)
- Danh mục hàng: thêm, sửa
- Báo cáo tồn kho theo quý, chỉ hàng có hóa đơn hoặc tất cả, tải Excel
- Lịch sử từng mặt hàng, hỏi kho bằng từ khóa

Quy tắc tồn: **Tồn = Tồn chuẩn (DanhMuc!G) + Nhập mới − Xuất mới**. Dòng có chữ ở cột `Nguon` là lịch sử cũ, chỉ để tra cứu.

## Cấu trúc Google Sheet
| Trang | Cột |
|---|---|
| DanhMuc | Ma, Ten, DVT, Nhom, TonToiThieu, GhiChu, TonChuan |
| Nhap | Ngay, NCC, Ma, SL, DVT, Gia, CoHD, GhiChu, Nguon, NguoiNhap, SoPhieu |
| Xuat | Ngay, SoHD, Khach, Ma, SL, DVT, CoHD, GhiChu, Nguon, NguoiNhap, SoPhieu |
| KiemKe | Ngay, Ma, SLDem, GhiChu, NguoiNhap |

Cột `SoPhieu` được app tự thêm khi lưu phiếu đầu tiên. Chương trình Apps Script cũ vẫn dùng chung Sheet được.

## Cài đặt (một lần)

### 1. Tạo OAuth Client ID
1. Vào https://console.cloud.google.com/ bằng Gmail chủ Sheet, tạo dự án mới (vd `Kho Hoanh Uy`).
2. **APIs & Services → Library** → tìm **Google Sheets API** → **Enable**.
3. **APIs & Services → OAuth consent screen**: chọn **External**, điền tên app, email hỗ trợ. Ở mục **Test users** thêm Gmail của những người được dùng app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://kipoikibo995-sys.github.io`
5. Chép **Client ID** (dạng `….apps.googleusercontent.com`).

### 2. Điền cấu hình
Mở `config.js`, dán Client ID vào `clientId`. `sheetId` là đoạn giữa `/d/` và `/edit` trong link Google Sheet.

### 3. Đăng lên GitHub Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch**, Branch `main`, thư mục `/ (root)`.

## Ai dùng được
- Người dùng phải được **chia sẻ Google Sheet** (quyền Người chỉnh sửa) **và** có trong danh sách **Test users**.
- Client ID và Sheet ID không phải mật khẩu: không có quyền trên Sheet thì không đọc được gì.
- Google có thể hỏi đăng nhập lại khoảng mỗi giờ.

## Chạy thử trên máy
Mở bằng một web server tĩnh tại `http://localhost:8080` (thêm origin này vào Client ID nếu muốn thử), ví dụ: `npx serve -l 8080`.
