# Rollout Staffing melalui Supabase SQL Editor

> Untuk database yang sudah menyelesaikan tujuh migration awal, gunakan [panduan update pengajuan Telegram](staffing-self-service-rollout.md). Jangan mengulang instalasi awal di bawah ini.

Pengguna mengonfirmasi pada 9 November 2026 bahwa perubahan sebelumnya dilakukan dengan copy-paste SQL ke SQL Editor Supabase. Jalur rollout ini mengikuti proses manual tersebut. Tidak ada deployment, perubahan history, atau perubahan data produksi yang dijalankan saat menulis panduan ini.

File SQL repository adalah source perubahan yang ditinjau. History CLI tidak dapat dianggap sebagai daftar lengkap perubahan yang pernah dilakukan manual. Dua file POS lama sama-sama memakai prefix `20260927`; ini bukan blocker rollout manual Staffing, dan keduanya **tidak dijalankan ulang**. Peralihan ke CLI di masa depan membutuhkan baseline schema dan reconciliation tersendiri. SQL Editor tidak otomatis mencatat perubahan ke history CLI. [Dokumentasi Supabase](https://supabase.com/docs/guides/deployment/database-migrations)

## 1. Ambil kondisi schema aktual, read-only

1. Buka dashboard Supabase dan pilih **project tujuan yang benar**. Mulai dari staging/salinan dengan baseline sama, sebelum produksi.
2. Buka **SQL Editor → New query**.
3. Salin isi penuh [`supabase/checks/staffing-production-preflight.sql`](../supabase/checks/staffing-production-preflight.sql), lalu **Run**. Query ini memakai transaksi READ ONLY dan ditujukan untuk Spark existing yang sudah mempunyai `stores` dan `app_users`.
4. Simpan isi cell `staffing_preflight` sebagai `preflight.json` di luar checkout. Export JSON SQL Editor berformat `[{"staffing_preflight": {...}}]` juga didukung.
5. Kirim hasil JSON untuk review bila diperlukan; jangan menyertakan server key, token bot atau password.

Jalankan pemeriksaan lokal dari root repo:

```bash
pnpm db:staffing:check
pnpm db:staffing:plan --preflight /path/to/preflight.json
```

Keduanya hanya membaca file lokal. Tidak membutuhkan token atau koneksi database dan tidak mengeksekusi SQL.

Plan manual untuk **instalasi pertama** mengharuskan:

- Kolom/tipe dan primary key UUID `stores`/`app_users` sesuai.
- `incompatible_app_user_roles=0`, `additional_role_constraints=[]`, akses service role dan generator UUID tersedia, serta timezone store didukung.
- `existing_staffing_relations=[]` dan `existing_staffing_functions=[]`.
- Tidak ada history CLI yang berisi entri yang belum ditinjau. Jika preflight menemukan tabel history CLI, export melalui query read-only [`staffing-migration-history.sql`](../supabase/checks/staffing-migration-history.sql) dan tambahkan `--history /path/history.json`. History kosong dapat diterima; history berisi entri membuat plan manual berhenti agar metode deployment tidak dicampur tanpa audit.

Hasil `ok=true` hanya berarti source lokal dan snapshot yang diberikan lolos pemeriksaan. Ini bukan pembacaan database langsung, jaminan snapshot masih terbaru, atau izin deployment otomatis. Ambil preflight baru mendekati waktu penerapan.

### Jika objek Staffing sudah ada

Plan sengaja berhenti. Jangan menganggap satu marker tabel membuktikan sebuah migration selesai, dan jangan replay semua file. Bandingkan kolom, constraint, index, trigger, definisi function dan privilege dengan SQL repository serta query yang pernah dijalankan. Setelah versi actual dipastikan, susun hanya perubahan yang tersisa; plan first-install bukan perencana upgrade otomatis.

Nama lama fondasi adalah `20261107_staffing_attendance.sql`; nama source sekarang `20261107180000_staffing_attendance.sql`. Rename source tidak berarti SQL lama perlu dijalankan ulang. Jika pernah menerapkan versi lama secara manual, review definisi actual dan perubahan guard secara terpisah.

## 2. Tinjau file yang akan diterapkan

Untuk **Spark existing dengan Staffing yang benar-benar belum terpasang**, urutannya:

| Urutan | File | Isi |
| --- | --- | --- |
| 1 | `20261107180000_staffing_attendance.sql` | Region, staff, grup, absensi, undangan, audit, outbox |
| 2 | `20261107193000_staffing_weekly_schedule.sql` | Jadwal mingguan dan commit |
| 3 | `20261107203000_staffing_operations_payroll.sql` | Izin/sakit, kasbon dan payroll |
| 4 | `20261107220000_staffing_create_staff.sql` | Create staff, kode dan saldo awal |
| 5 | `20261108003000_staffing_review_replacement.sql` | Review absensi dan penggantian staff |
| 6 | `20261108100000_staffing_telegram_workflows.sql` | Telegram dan persetujuan tukar shift |
| 7 | `20261109090000_staffing_group_management.sql` | Pengelolaan satu grup per store |

Semua file berada di `supabase/migrations/`. Jangan menyalin `schema.sql`, migration POS/auth lama, atau SQL dari folder fixture ke produksi existing. Plan hanya menampilkan Staffing dan hash SHA-256 source yang dibaca; hash itu belum membuktikan SQL remote sama.

Migration pertama memeriksa konflik role/grant sebelum DDL. Setiap file memakai `lock_timeout=5s`, `statement_timeout=120s`, `search_path=public` dan satu transaksi. Migration terakhir menolak mapping beberapa grup untuk satu store tanpa menghapus duplikat otomatis.

Untuk upgrade yang sudah memiliki tabel grup, cek duplikat terlebih dahulu:

```sql
select store_id, count(*) as group_count
from public.staffing_groups
 group by store_id
having count(*) > 1;
```

Query ini hanya berlaku jika tabel sudah ada. Hasil duplikat memerlukan pemilihan mapping yang benar dan peninjauan proses/pesan lama sebelum migration remediasi; jangan menghapus berdasarkan perkiraan.

## 3. Uji staging, lalu lakukan rollout terpantau

Pastikan backup dan prosedur restore tersedia untuk database tujuan. Pada staging dengan baseline yang sama, jalankan file yang sudah ditinjau satu per satu dan lakukan pengujian Telegram nyata sebelum produksi.

Untuk setiap file yang memang belum diterapkan:

1. Buka isi lengkap file repository, dari `BEGIN` sampai `COMMIT`.
2. Buat query baru di SQL Editor dengan nama filename, lalu salin isi lengkap tersebut. Periksa lagi project tujuan.
3. Klik **Run** dan tunggu hasil sukses sebelum file berikutnya.
4. Catat project, filename, hash dari plan, tanggal/waktu, hasil dan operator. Simpan nama/query SQL Editor bersama catatan rollout.
5. Jika gagal, hentikan urutan, simpan error dan pastikan transaksi gagal telah rollback. Periksa penyebab dan keadaan schema sebelum retry; jangan melompati file atau memaksa replay dengan `IF NOT EXISTS`.

Setiap file adalah transaksi sendiri: file yang sudah sukses tidak ikut rollback jika file berikutnya gagal. Error/timeout dapat terjadi karena lock, constraint atau drift schema. Periksa penyebabnya; jangan membuka RLS atau menghapus data untuk memaksa sukses.

Tidak ada command deploy produksi otomatis dalam panduan atau script plan. Setelah database lengkap, baru deploy versi dashboard/worker yang membutuhkannya.

## 4. Verifikasi sesudah penerapan

Salin seluruh isi [`supabase/checks/staffing-production-postflight.sql`](../supabase/checks/staffing-production-postflight.sql) ke query baru dan Run. Semua kolom hasil harus `true`; query ini read-only dan tidak mengirim pesan Telegram.

Jalankan lagi preflight read-only. Tabel Staffing perlu RLS dengan akses klien tertutup; seluruh function Staffing harus menunjukkan `anon_execute=false`, `authenticated_execute=false`, `service_execute=true`. Cocokkan objek dan definisi dengan tujuh file, bukan hanya hasil plan first-install (yang sekarang memang akan menolak karena objek sudah ada).

Di dashboard, gunakan project Supabase yang sama dengan worker: buat region, hubungkan store, lalu **Pengaturan → Telegram → Hubungkan grup**. Mapping existing dapat diganti melalui **Ubah grup** oleh admin, dengan alasan dan pengecekan proses lama. Badge “Konfigurasi tersedia” hanya memeriksa environment; verifikasi webhook, undangan akun, absen lengkap ≤10 menit, persetujuan dua pihak dan review manager melalui Telegram staging secara terpisah.

## Jika kelak beralih ke CLI/CI

Ambil schema actual, catatan query manual dan snapshot privileges. Tentukan baseline yang merepresentasikan schema tersebut, rapikan identitas file historis tanpa replay POS, lalu rekonsiliasikan history secara terkontrol. Jangan melakukan `db push`, `migration repair`, atau menandai migration applied hanya berdasarkan filename. Mode pemeriksaan CLI (`node scripts/staffing-migrations.mjs --history ...`) tetap tersedia untuk proses masa depan; bukan jalur produksi saat ini.

## Transport Telegram setelah migration

Arsitektur yang dipilih memakai webhook dashboard Next.js dan retry pada Lambda POS existing; ikuti [aktivasi dashboard webhook](staffing-dashboard-webhook.md). Tidak ada migration tambahan atau kebutuhan menambah Lambda. Jangan mengaktifkan template standalone hanya untuk memasang webhook.
