# GenLog — ระบบบริหารจัดการเครื่องกำเนิดไฟฟ้า (หลายเครื่อง)

- `index.html` + `config.js` : หน้าเว็บ (เปิดผ่าน GitHub Pages)
- `Code.gs` : Backend (Google Apps Script) — ข้อมูลเก็บใน Google Sheets

## ติดตั้ง
1. สร้าง Google Sheet → Extensions → Apps Script → วาง `Code.gs` → รัน `setup` 1 ครั้ง
2. Deploy → New deployment → Web app → Execute as: **Me** · Who has access: **Anyone** → คัดลอก URL (`.../exec`)
3. วาง URL ลงใน `config.js` (`GENLOG_API_URL`) แล้ว commit
4. GitHub → Settings → Pages → Deploy from branch `main` / root
5. เปลี่ยน PIN เริ่มต้นในชีต `Users` ทันที

> แก้ `Code.gs` แล้วต้อง Deploy → Manage deployments → Edit → New version เพื่อให้ URL เดิมใช้โค้ดใหม่
