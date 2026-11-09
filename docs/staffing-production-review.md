# Pemeriksaan rollout Staffing ke database Spark existing

Pemeriksaan REST produksi: 8 November 2026. Perbaikan source: 9 November 2026. Tidak ada migration remote, deployment, webhook, perubahan history atau data produksi yang dijalankan.

## Status

Pengguna mengoreksi informasi sebelumnya: perubahan produksi dilakukan dengan **copy-paste SQL Editor**, bukan CLI/CI. Ikuti [runbook produksi manual](staffing-production-rollout.md). Source Staffing telah diperbaiki dan diuji lokal; kondisi catalog aktual masih perlu ditinjau sebelum SQL produksi diterapkan.

Dua file POS lama memiliki prefix `20260927` yang sama. Ini bukan blocker untuk rollout manual Staffing, dan file POS tersebut tidak perlu diubah atau dijalankan ulang. Pemeriksaan CLI tetap menolaknya bila kelak memilih jalur CLI; proses baseline masa depan terpisah dari rollout manual sekarang.

## Perbaikan yang sudah dibuat

| Temuan | Perbaikan source |
| --- | --- |
| Timestamp fondasi Staffing tidak berurutan saat sort | Diubah dari `20261107_staffing_attendance.sql` ke `20261107180000_staffing_attendance.sql`; semua file Staffing bertimestamp 14 digit dan urut dependency. Jika identitas lama pernah applied, plan manual menolak menebak progres bila objek sudah ada; cocokkan definisi actual dan catatan SQL lama. |
| Konflik role/constraint authentication existing | Migration pertama memeriksa role incompatible, check constraint role tambahan, dan akses baca service role sebelum DDL. Tidak membuka akses anon/authenticated. |
| DDL menunggu lock tanpa batas yang jelas | Seluruh file Staffing memakai local lock timeout 5 detik, statement timeout 120 detik, serta search path eksplisit. Timeout membatalkan transaksi file tersebut. |
| Mapping grup sulit diubah | Ditambahkan Ubah grup dengan alasan, admin-only RPC, pengecekan mapping lama, dan audit sebelum/sesudah. Proses aktif/outbox lama harus selesai sebelum relink. |
| Beberapa grup dapat didaftarkan untuk satu store | Migration ketujuh menambahkan unique index per store; gagal dengan error yang jelas jika sudah ada duplikat, tanpa memilih atau menghapus grup lama. |
| Salah source/history dapat menyebabkan replay | `db:staffing:plan --preflight ...` memeriksa snapshot catalog untuk instalasi pertama dan hanya mencantumkan Staffing. Objek existing/partial membuat plan berhenti untuk review; POS lama tidak ikut dijalankan. Mode CLI/history tetap opsional untuk peralihan masa depan. |

Migration tetap bukan skrip yang aman diulang sembarangan. Replay SQL mentah sengaja gagal dan rollback. Gunakan definisi schema actual dan catatan SQL yang pernah sukses untuk memilih perubahan yang tersisa; history CLI tidak otomatis merekam query manual. Jangan replay `schema.sql` atau migration POS/auth lama pada produksi existing.

## Hasil REST produksi yang sudah diperiksa

Menggunakan URL/server key `.env` tanpa menampilkan credential:

- Schema API `stores` dan `app_users` mempunyai tipe kolom/UUID primary key yang dibutuhkan Staffing.
- Ada dua store aktif: Sarkop Palu dan Sarkop Jatinangor.
- Pembacaan role mengembalikan satu akun `admin`.
- Tabel penanda Staffing mengembalikan `PGRST205`; OpenAPI tidak menampilkan endpoint Staffing. Catalog SQL tetap dibutuhkan untuk membedakan schema yang belum dibuat dari masalah cache/exposure.
- Environment berisi username, token dan secret khusus Staffing; keberadaan variabel tidak memverifikasi bot atau webhook.

Temuan ini adalah snapshot pemeriksaan 8 November, bukan pembacaan ulang setelah perubahan source. Server key REST tidak menyediakan query catalog/history SQL.

## Bukti yang masih diperlukan sebelum production

1. Project tujuan yang benar dan hasil preflight catalog baru. Catatan SQL Editor yang pernah dijalankan dipakai bersama definisi schema, bukan sebagai satu-satunya bukti versi.
2. [Preflight catalog read-only](../supabase/checks/staffing-production-preflight.sql): kolom/PK cocok, `incompatible_app_user_roles=0`, `additional_role_constraints=[]`, akses service role benar, timezone didukung, objek Staffing/privilege sesuai source dan history.
3. Jika preflight menemukan tabel history CLI, tinjau [export history read-only](../supabase/checks/staffing-migration-history.sql) sebelum mencampur metode. Bila tabel tidak ada, export ini tidak diperlukan. Hash file lokal bukan bukti bahwa definisi SQL remote identik.
4. Jika upgrade punya tabel grup, pastikan tidak ada store dengan lebih dari satu grup sebelum migration ketujuh. Remediasi perlu menentukan mapping yang benar dan meninjau proses/pesan, bukan menghapus duplikat secara otomatis.
5. Pengujian staging dengan baseline yang sama, catatan file/hash/waktu penerapan manual, backup/restore yang siap, dan pengujian Telegram nyata sebelum aktivasi produksi.

## Urutan migration Staffing

1. `20261107180000_staffing_attendance.sql`
2. `20261107193000_staffing_weekly_schedule.sql`
3. `20261107203000_staffing_operations_payroll.sql`
4. `20261107220000_staffing_create_staff.sql`
5. `20261108003000_staffing_review_replacement.sql`
6. `20261108100000_staffing_telegram_workflows.sql`
7. `20261109090000_staffing_group_management.sql`

Setiap file bertransaksi. Kegagalan file baru tidak membatalkan file sebelumnya yang sudah sukses; verifikasi schema dan catatan file yang sudah sukses sebelum retry. Enam migration awal tidak mengubah tabel transaksi POS. Perubahan tabel existing di luar prefix Staffing terbatas pada constraint role `app_users`.

## Hubungkan/Ubah grup di dashboard

Tambah grup membutuhkan store aktif, sudah punya region, dan belum terdaftar. Jika semua store sudah terhubung, gunakan **Ubah grup** di baris mapping existing. Admin mengisi ID baru dan alasan; backend menolak role manager, edit stale, ID invalid, mapping duplikat dan relink selama proses/pesan lama belum selesai. Bukti absensi historis tetap tersimpan.

Preview `localhost:3108` yang ditinjau sebelumnya memakai database dummy dengan satu store yang sudah terhubung ke grup dummy. Preview tidak terhubung ke Supabase/Telegram asli. Menambahkan bot ke grup tidak otomatis membuat mapping di database.

## Validasi

Tes PostgreSQL lokal (PGlite) mencakup penerapan berurutan, data/kolom/index/constraint POS tidak berubah kecuali role yang disengaja, preflight read-only, akses RPC/table tertutup untuk klien, rollback replay, guard role/constraint/grant, serta workflow mapping grup dan audit. Pemeriksaan source/history diuji dengan history cocok, gap, nama berbeda, identitas lama, dan version duplikat.

Validasi lokal tidak menggantikan catalog, migration history, concurrency/lock nyata, restore, maupun Telegram/AWS pada lingkungan tujuan.

Validasi source pada tahap sebelumnya: **165 tes lulus**, TypeScript dan ESLint bersih, serta production build Next.js berhasil. Pemeriksaan HTTP pada preview `localhost:3108` lulus untuk autentikasi, prasyarat region, create/edit mapping, edit stale, invalid ID, dan proses grup yang belum selesai. Semua data/integrasi pengujian ini lokal dan sintetis; tidak ada request Telegram nyata atau deployment produksi.

Setelah koreksi jalur SQL Editor manual: **170 tes lulus**, TypeScript dan ESLint bersih. Plan first-install menerima hasil preflight PostgreSQL nyata yang masih kosong Staffing, menolak schema partial dan metadata tidak lengkap, serta tidak menganggap prefix POS duplikat sebagai blocker manual. Tidak ada migration SQL yang diubah pada koreksi ini atau SQL produksi yang dijalankan.
