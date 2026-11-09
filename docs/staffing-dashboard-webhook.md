# Aktivasi bot Staffing pada dashboard existing

Arsitektur pilihan pengguna: webhook di Next.js/Vercel, retry notifikasi pada Lambda POS existing. Tidak membuat Lambda, Function URL, atau schedule baru. Database memakai tujuh migration yang sudah diterapkan; tidak ada migration tambahan untuk perubahan transport ini.

## Target yang telah diverifikasi read-only

- Dashboard: `https://dashboard.sarkop.sparkfoodservice.com`
- Webhook: `https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing` (tanpa trailing slash)
- Lambda existing: `spark-kaspin-pos-poller`, region `us-east-2`, profile lokal `default`
- Handler `worker.handler`, Node.js 22, x86_64, 128 MB, timeout 58 detik
- Supabase Lambda cocok dengan `.env` dashboard. Tidak ditemukan kepemilikan CloudFormation atau Function URL pada fungsi ini.

Ini hasil pemeriksaan 9 November 2026, bukan asumsi dari `template.yaml`. Template SAM repo menjelaskan alternatif deployment dua fungsi; **jangan menjalankan SAM deploy template itu sebagai update deployment manual existing**.

## 1. Deploy dashboard ke project Vercel yang sudah ada

Tambahkan environment production server-side pada project Vercel yang memiliki domain dashboard tersebut:

| Variabel | Nilai |
| --- | --- |
| `SUPABASE_URL` | Project database yang baru dimigrasikan, sama dengan Lambda |
| `SUPABASE_SECRET_KEY` | Server key project tersebut; pertahankan konfigurasi existing yang benar |
| `STAFFING_TELEGRAM_BOT_USERNAME` | `SparkStaffBot`, tanpa `@` |
| `STAFFING_TELEGRAM_BOT_TOKEN` | Token Staffing dari konfigurasi lokal, berbeda dari bot POS |
| `STAFFING_TELEGRAM_WEBHOOK_SECRET` | Secret lokal yang sama, 32–256 karakter sesuai aturan setup script |

Pertahankan environment authentication/admin dashboard. Bot POS tidak perlu dipindahkan ke Vercel. Jangan memakai `NEXT_PUBLIC_` untuk credential server.

Deploy source `feat/staffing` yang sudah ditinjau ke **project Vercel existing**. Deployment harus mencakup route baru, middleware dan modul Staffing; memasang environment saja tidak menambahkan endpoint. Route harus dapat dijangkau Telegram tanpa login/cookie dashboard. Middleware membebaskan hanya path webhook yang tepat, kemudian route memverifikasi header `x-telegram-bot-api-secret-token` sebelum membaca body. Deployment protection Vercel yang memblokir endpoint publik perlu diselesaikan pada project tujuan; secret aplikasi tetap diperlukan.

Setelah deployment, pemeriksaan tanpa credential:

```bash
curl -i https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing
curl -i -X POST https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing \
  -H 'Content-Type: application/json' -d '{}'
```

Harapan: GET `405`, POST tanpa secret `401`. Query di atas tidak memproses command atau mengirim pesan. Jika masih diarahkan ke login, mendapat deployment-protection page atau GET `401`, pastikan source/middleware baru sudah dipublikasikan dan endpoint bisa dijangkau.

## 2. Build ZIP untuk Lambda existing

Dari root source yang sudah ditinjau:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm aws:build:staffing
```

Build memakai esbuild dari dependensi project dan menghasilkan `.aws-sam/staffing-poller/worker.zip`, berisi hanya `worker.js` di root. Handler tetap `worker.handler`; runtime, memory dan architecture Lambda tidak perlu diganti. Manifest mencatat SHA-256 ZIP dan lockfile. Tidak membaca/memasukkan `.env`, melakukan npm install ulang, atau menghubungi AWS.

## 3. Siapkan paket update dan rollback, tanpa deploy

Setelah login AWS (`aws login --profile default` bila sesi expired):

```bash
node scripts/prepare-staffing-poller-update.mjs \
  --function spark-kaspin-pos-poller \
  --region us-east-2 \
  --profile default \
  --prepare
```

Script membaca konfigurasi existing, memastikan handler/runtime/database sesuai, memeriksa bot Staffing berbeda dari bot POS, mengunduh backup code dan memverifikasi hash. Script **tidak memperbarui AWS**.

Output menunjukkan `privatePackage`: folder lokal dengan permission terbatas, di luar repo/artifact. Folder ini berisi:

- `review.json`: metadata review tanpa secret.
- `environment-update.json`: mempertahankan seluruh environment existing dan menambahkan/mengganti hanya `STAFFING_TELEGRAM_BOT_TOKEN`.
- `environment-before.json`, `worker-before.zip`: backup privat untuk rollback.
- `worker-after.zip`, `apply.sh`, `rollback.sh`: paket update yang belum dijalankan.

Folder tersebut berisi credential existing dalam backup/request environment. Jangan commit, upload sebagai artifact aplikasi, atau paste isinya ke chat. Review hanya metadata. Parameter `RevisionId` mencegah update menimpa konfigurasi yang berubah setelah persiapan.

Setelah review dan persetujuan deployment, jalankan:

```bash
bash /PATH-PRIVATE-PACKAGE/apply.sh
```

Script menerapkan environment dengan revision guard, menunggu update selesai, mengambil revision baru, lalu memperbarui code. Output dibatasi ke metadata; environment tidak dicetak. Tidak membuat resource baru. Jika perlu rollback terkontrol, tinjau lalu jalankan `rollback.sh`; backup environment adalah snapshot saat persiapan, jadi perhatikan perubahan operator lain sesudahnya.

Retry berjalan sekali per invocation jadwal POS existing, paralel dengan polling, dibatasi budget jaringan 3 detik dan maksimal dua pesan. Kegagalan retry tidak menggagalkan POS. Webhook Next.js mengirim balasan langsung dengan budget terpisah, sehingga tidak menunggu poller.

Pengiriman notifikasi bersifat at-least-once: jika Telegram menerima pesan tetapi receipt gagal/timeout, retry dapat menghasilkan duplikat. Row yang deadline-nya habis tetap memakai lease 90 detik sebelum dicoba lagi; tidak dihapus atau ditandai sukses berdasarkan perkiraan.

## 4. Pasang menu dan webhook bot Staffing

Setelah endpoint production siap dan Lambda sudah diperbarui, jalankan dry-run dari root repo dengan `.env` lokal:

```bash
node --env-file=.env scripts/staffing-telegram-setup.mjs \
  --url https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing
```

Pastikan username `SparkStaffBot`, domain, dan path sesuai. Dry-run tidak mengirim request Telegram. Setelah review aktivasi:

```bash
node --env-file=.env scripts/staffing-telegram-setup.mjs \
  --url https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing \
  --apply
```

Script memeriksa identitas, menolak webhook lain tanpa penggantian eksplisit, memasang command menu dan webhook dengan secret. Pending updates tidak dibuang; sesudah aktif, command yang masih tertunda dapat diproses dan mendapat balasan. Bot POS dan setting webhook-nya tidak diubah.

Jika ingin menyimpan URL untuk penggunaan berikutnya, isi `STAFFING_TELEGRAM_WEBHOOK_URL` pada konfigurasi lokal dengan URL dashboard di atas. Token/secret harus sama dengan environment production Vercel; URL localhost bukan endpoint Telegram publik.

## 5. Uji alur nyata

1. Buat profil staff untuk setiap pegawai dan home store yang benar.
2. Dari Pengaturan Profil, buat undangan personal; pegawai bersangkutan membuka link lewat akun Telegramnya sendiri lalu Start.
3. Buat/commit jadwal untuk waktu pengujian.
4. Di grup store terdaftar, lakukan `/masuk@SparkStaffBot` → konfirmasi shift → lokasi → foto dalam 10 menit.
5. Periksa sesi/bukti di dashboard, review, kemudian checkout. Uji persetujuan pihak kedua dan manager sebelum jadwal pengganti berubah.
6. Tinjau log/error dan kesehatan POS sesudah update. Validasi lokal/HTTP tanpa credential tidak membuktikan seluruh alur Telegram nyata.

`staffing-template.yaml` dan adapter Lambda Staffing tetap tersedia sebagai alternatif standalone, tetapi bukan bagian deployment yang dipilih ini.

## Validasi implementasi sebelum deployment

194 tes lulus; TypeScript, ESLint dan production build Next.js lolos. Endpoint lokal production-build mengembalikan GET 405, POST tanpa secret 401, dan update malformed dengan secret valid 400; API dashboard lain tetap membutuhkan login. ZIP poller hanya berisi `worker.js`, dan paket backup/update/rollback telah diverifikasi tanpa menjalankan command update AWS.

Ini belum membuktikan deployment production atau pengiriman Telegram nyata. GET endpoint production saat diperiksa masih 401, sehingga route/middleware baru belum terverifikasi terpublikasi. Aktivasi webhook dilakukan setelah publikasi dashboard dan update Lambda ditinjau.
