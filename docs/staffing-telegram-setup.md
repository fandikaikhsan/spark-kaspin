# Panduan integrasi Telegram Staffing: dari grup sampai absensi pertama

Panduan ini untuk kondisi: kamu sudah mempunyai **satu grup Telegram, akun Telegram kamu, dan dua akun PNS**. Yang perlu disiapkan berikutnya ialah bot Staffing, database Supabase tes, dashboard yang membaca database tersebut, dan endpoint webhook pada dashboard Next.js.

Panduan mengikuti kode `feat/staffing`. Penulisan panduan ini tidak menjalankan migration remote, deployment AWS, pemasangan webhook, atau pengiriman pesan Telegram.

## 0. Pahami komponen dan peran tiga akun

| Komponen / akun | Tugas |
| --- | --- |
| Akun Telegram kamu | Pemilik bot melalui BotFather, anggota/admin grup, dan penguji klik dari akun yang bukan pihak kedua |
| Login dashboard kamu | Admin untuk setup; manager dengan akses region untuk operasi harian. Login dashboard terpisah dari akun Telegram |
| Telegram PNS A | Ditautkan ke profil Staff A; mencoba check-in, checkout dan mengajukan pergantian shift |
| Telegram PNS B | Ditautkan ke profil Staff B; mencoba absensi sendiri dan persetujuan pihak kedua |
| Bot Staffing | Satu bot untuk grup serta chat pribadi kedua PNS; gunakan bot berbeda dari bot POS |
| Dashboard Next.js | Mengatur region/store/staff/jadwal, membuat undangan dan memproses review |
| Supabase | Menyimpan identitas, jadwal, absensi, pengajuan, audit dan antrean pesan |
| Webhook Next.js | Menerima update Telegram, menjalankan validasi database dan mengirim balasan |
| Lambda POS existing | Tetap melakukan ingestion POS, sekaligus retry notifikasi Staffing dengan budget singkat |

Aliran data: **Telegram → webhook dashboard Next.js → Supabase**. Balasan langsung dikirim oleh webhook; Lambda POS existing membantu retry antrean notifikasi.

Tiga hal yang sering tertukar:

- Menu **Pengaturan → Telegram** di dashboard mendaftarkan **ID grup ke store**. Token bot diisi melalui environment server, bukan melalui form pada menu itu.
- Akun PNS ditautkan dari **profil staff → Buat undangan Telegram**. PNS tidak perlu dibuatkan login dashboard atau akun Supabase Auth.
- Menjadi admin grup atau pemilik bot tidak memberikan hak manager aplikasi. Pada tahap ini review manager dilakukan melalui login dashboard; belum ada penautan akun manager Telegram.

## 1. Siapkan lingkungan integrasi yang terpisah

Mulai dengan Supabase development/staging untuk grup tes ini. Database lokal preview sebelumnya memakai fixture terisolasi; perubahan pada fixture itu **belum berarti migration sudah terpasang di project Supabase milikmu**.

### 1.1. Buat salinan kode tanpa environment produksi

Perintah berikut dijalankan dari Terminal di Mac. Salinan mencakup perubahan kode yang belum di-commit, tetapi tidak membawa `.env`, cache build atau konfigurasi deployment lama.

```bash
cd /Users/fandika/Projects/spark-kaspin
mkdir -p /tmp/spark-staff-telegram-integration
rsync -a \
  --exclude='.git/' \
  --exclude='.aws/' \
  --exclude='*.zip' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='.aws-sam/' \
  --exclude='.env*' \
  --exclude='samconfig*.toml' \
  --exclude='api.json' \
  ./ /tmp/spark-staff-telegram-integration/
cd /tmp/spark-staff-telegram-integration
pnpm install --frozen-lockfile
```

Seluruh perintah selanjutnya memakai folder `/tmp/spark-staff-telegram-integration`, kecuali disebut berbeda. Salinan ini memisahkan `.next` dari server lokal yang sedang berjalan di checkout utama.

Siapkan Node.js 22 atau lebih baru untuk perintah lokal, pnpm, AWS CLI dan AWS SAM CLI. Worker Lambda pada template menggunakan runtime Node.js 22:

```bash
node --version
pnpm --version
aws --version
sam --version
```

Gunakan AWS profile untuk akun yang akan menampung stack tes. Contoh perintah dalam panduan memakai `YOUR_AWS_PROFILE`; ganti dengan nama profile milikmu.

```bash
aws sts get-caller-identity --profile YOUR_AWS_PROFILE
```

**Hasil yang diharapkan:** account AWS sesuai tujuan tes. Perintah ini hanya memeriksa identitas AWS, belum membuat resource.

### 1.2. Buat satu file konfigurasi di luar folder kode

Buat `/tmp/spark-staffing-telegram.env` melalui editor lokal. Letakkan file ini di luar folder kode agar tidak ikut dibawa oleh `CodeUri: .` saat build worker.

```dotenv
# Project Supabase DEVELOPMENT/STAGING yang sama untuk dashboard dan Lambda
SUPABASE_URL=https://YOUR_TEST_PROJECT.supabase.co
SUPABASE_SECRET_KEY=REPLACE_WITH_TEST_PROJECT_SERVER_SECRET
SUPABASE_SERVICE_ROLE_KEY=

# Diisi setelah membuat bot; username tanpa @
STAFFING_TELEGRAM_BOT_USERNAME=
STAFFING_TELEGRAM_BOT_TOKEN=
STAFFING_TELEGRAM_WEBHOOK_SECRET=
# URL endpoint publik dashboard integrasi, bukan localhost
STAFFING_TELEGRAM_WEBHOOK_URL=

# Login bootstrap dashboard integrasi
SETTINGS_ADMIN_USERNAME=staffing.admin
SETTINGS_ADMIN_PASSWORD="REPLACE_WITH_A_NEW_STRONG_PASSWORD"
AUTH_SESSION_SECRET=REPLACE_WITH_RANDOM_SECRET

# Matikan fallback kredensial/integrasi POS pada sesi tes ini
BASE_URL=http://127.0.0.1:9
TOKEN=
REFRESH_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
```

Buat nilai acak yang berbeda untuk webhook secret dan session secret. Contoh generator yang dijalankan sendiri di Terminal:

```bash
openssl rand -hex 32
```

Webhook secret memakai 32–256 karakter berupa huruf, angka, `_` atau `-`; output hex 64 karakter sesuai. Salin nilai langsung ke file konfigurasi, jangan ke chat atau repository.

```bash
chmod 600 /tmp/spark-staffing-telegram.env
```

File `.env` khusus ini **tidak dimuat otomatis oleh Next.js atau SAM**. Perintah di bawah akan memuatnya secara eksplisit untuk dashboard/script; parameter Lambda diisi pada deployment.

Gunakan satu sesi Terminal khusus integrasi. Variabel yang sudah di-export oleh shell mengalahkan nilai dari `node --env-file`. Jika sebelumnya mengekspor environment aplikasi lain, bersihkan nama variabel berikut di sesi khusus ini sebelum melanjutkan:

```bash
unset SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY
unset STAFFING_TELEGRAM_BOT_USERNAME STAFFING_TELEGRAM_BOT_TOKEN
unset STAFFING_TELEGRAM_WEBHOOK_SECRET STAFFING_TELEGRAM_WEBHOOK_URL
unset SETTINGS_ADMIN_USERNAME SETTINGS_ADMIN_PASSWORD AUTH_SESSION_SECRET
unset BASE_URL TOKEN REFRESH_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

Periksa tujuan yang terbaca tanpa mencetak secret:

```bash
node --env-file=/tmp/spark-staffing-telegram.env --input-type=module -e \
  'console.log({supabase: process.env.SUPABASE_URL, bot: process.env.STAFFING_TELEGRAM_BOT_USERNAME})'
```

Supabase URL harus menunjuk project tes yang akan kamu migrasikan. Setelah username bot terisi, ulangi pemeriksaan ini sebelum memasang webhook. Perilaku precedence environment dijelaskan dalam [Node.js CLI](https://nodejs.org/api/cli.html#--env-filefile).


## 2. Buat bot Staffing dan dapatkan ID grup

### 2.1. Buat bot melalui BotFather

1. Dari akun Telegram kamu, buka **@BotFather** yang resmi.
2. Kirim `/newbot`, lalu pilih nama dan username bot yang berakhiran `bot`.
3. Simpan username tanpa `@` ke `STAFFING_TELEGRAM_BOT_USERNAME`.
4. Simpan token lengkap ke `STAFFING_TELEGRAM_BOT_TOKEN` di file konfigurasi.
5. Di BotFather, gunakan `/setjoingroups`, pilih bot, lalu **Enable**.
6. Gunakan `/setprivacy`, pilih bot, lalu **Enable**.
7. Tambahkan bot ke grup Telegram yang sudah kamu buat. Bot cukup menjadi anggota biasa yang boleh mengirim pesan; tidak perlu menjadi admin.
8. Pastikan akun kamu, PNS A, dan PNS B berada di grup itu.

BotFather mendokumentasikan pengaturan tersebut pada [Telegram Bot Features](https://core.telegram.org/bots/features#botfather). Dengan privacy mode, command yang ditujukan ke bot dan reply ke pesan bot tetap diterima. [Telegram FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)

Belum ada balasan bot pada tahap ini adalah normal: worker/webhook belum dipasang.

### 2.2. Ambil ID grup sebelum memasang webhook

Di grup, dari akunmu kirim command dengan username bot yang sebenarnya:

```text
/bantuan@username_bot_kamu
```

Dari folder integrasi, jalankan snippet berikut. Snippet membaca token dari environment dan hanya menampilkan ID/nama/jenis grup; token serta isi percakapan tidak ditampilkan.

```bash
node --env-file=/tmp/spark-staffing-telegram.env --input-type=module <<'NODE'
const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Isi token bot Staffing terlebih dahulu.');
async function api(method) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', signal: AbortSignal.timeout(15000)
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error();
    return data.result;
  } catch { throw new Error(`Telegram ${method} gagal; respons/token tidak dicetak.`); }
}
const info = await api('getWebhookInfo');
if (info.url) throw new Error('Webhook sudah aktif. Jangan gunakan getUpdates atau menghapus webhook tanpa pemeriksaan.');
const groups = new Map();
for (const u of await api('getUpdates')) {
  const c = u.message?.chat;
  if (c && ['group', 'supergroup'].includes(c.type)) groups.set(c.id, { id: c.id, title: c.title, type: c.type });
}
console.log(JSON.stringify([...groups.values()], null, 2));
NODE
```

Catat ID grup yang namanya sesuai, misalnya `-1001234567890`. Gunakan angka negatif **lengkap**, bukan nama grup, `@username`, atau link undangan.

Jika hasil `[]`, kirim command lagi di grup, pastikan bot sudah menjadi anggota, lalu ulangi. `getUpdates` dipakai sebelum webhook; Telegram tidak mengizinkan polling ini bersamaan dengan webhook aktif. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)

## 3. Pasang schema dan migration di Supabase

Untuk database produksi Spark yang sudah ada, baca [hasil review dan langkah preflight produksi](staffing-production-review.md) terlebih dahulu. Query catalog read-only tersedia di [`supabase/checks/staffing-production-preflight.sql`](../supabase/checks/staffing-production-preflight.sql). Jangan replay fondasi POS atau menjalankan semua file berdasarkan urutan nama.

Untuk membuat project tes baru: buka dashboard Supabase → pilih organisasi → **New project** → beri nama misalnya `spark-staffing-test` → tentukan password database dan region → tunggu project siap. Simpan password database secara pribadi. Gunakan Project URL dan server key project baru ini pada konfigurasi tes. Jika sudah mempunyai project staging, gunakan project itu dan periksa schema existing terlebih dahulu.

### 3.1. Tentukan jalur database

| Kondisi | Langkah |
| --- | --- |
| Project tes benar-benar baru/kosong | Jalankan `supabase/schema.sql` satu kali, kemudian tujuh migration Staffing sesuai urutan di bawah |
| Database sudah mempunyai fondasi Spark: `stores`, `app_users`, dan tabel POS | Jangan replay `schema.sql`. Periksa migration Staffing yang sudah diterapkan, lalu jalankan hanya yang belum ada |
| Enam migration Staffing awal sudah lengkap | Terapkan migration pengelolaan grup setelah memeriksa duplikat mapping |
| Project sudah dikelola pipeline Supabase CLI | Pertahankan pipeline/history itu; cocokkan history dan urutan file dahulu sebelum deployment, jangan campur dengan SQL Editor |

Migration fondasi Staffing kini bernama `20261107180000_staffing_attendance.sql`, sehingga ketujuh file Staffing memakai timestamp 14 digit dan berurutan. Nama lama adalah `20261107_staffing_attendance.sql`. Jika version lama `20261107` pernah tercatat applied, jangan menerapkan ulang versi baru; cocokkan definisi schema actual dan catatan SQL yang pernah dijalankan terlebih dahulu.

**Produksi project ini sebelumnya memakai copy-paste SQL Editor**, sesuai koreksi pengguna. Ikuti [runbook produksi manual](staffing-production-rollout.md). Prefix `20260927` yang sama pada dua file POS lama bukan blocker instalasi manual Staffing; file POS lama tidak dijalankan ulang. Jika kelak memakai CLI, baseline/history harus direkonsiliasikan terlebih dahulu.

Jalankan `pnpm db:staffing:check` untuk memeriksa source Staffing, lalu `pnpm db:staffing:plan --preflight /path/preflight.json` untuk memeriksa rencana instalasi pertama berdasarkan hasil query read-only. Perintah ini hanya membaca file; tidak menghubungi database, deploy, atau mengubah history. Jika objek Staffing sudah ada, review definisi dan perubahan yang tersisa secara terpisah.

Untuk project yang masih dikelola manual, termasuk project ini, langkah SQL Editor di bawah dapat digunakan setelah preflight dan review schema. Ini memakai file SQL di repo sebagai sumber yang dijalankan, tetapi **tidak mendaftarkannya ke history Supabase CLI**. Catat nama file dan tanggal penerapan. Jika nanti beralih ke CLI, lakukan baseline/reconciliation, bukan menandai migration sebagai applied tanpa verifikasi. Supabase menjelaskan perbedaan ini dalam [panduan migrations](https://supabase.com/docs/guides/deployment/database-migrations).

### 3.2. Periksa kondisi awal melalui SQL Editor

Buka project Supabase tujuan → **SQL Editor → New query**. Pastikan nama/project reference sesuai project tes, kemudian jalankan query baca berikut:

```sql
select
  to_regclass('public.stores') as stores,
  to_regclass('public.app_users') as dashboard_accounts,
  to_regclass('public.staffing_staff') as staffing_staff,
  to_regclass('public.staffing_requests') as leave_cash_requests,
  to_regclass('public.staffing_payrolls') as payrolls,
  to_regclass('public.staffing_shift_requests') as telegram_shift_requests;
```

- Semua `NULL` pada project baru: jalankan file `supabase/schema.sql` terlebih dahulu.
- `stores`/`app_users` ada: jangan menjalankan ulang schema dasar. Cocokkan versi fondasi POS/auth dengan README dan history project.
- Tabel Staffing hanya sebagian ada: periksa file yang pernah sukses diterapkan. Satu tabel ada bukan bukti seluruh migration selesai.

Untuk melihat apakah project mempunyai history CLI:

```sql
select to_regclass('supabase_migrations.schema_migrations') as cli_history;
```

Jika history tersebut dipakai project, tinjau isinya melalui pengelolaan migration yang sudah digunakan tim sebelum menerapkan perubahan manual.

### 3.3. Jalankan file dengan urutan dependency berikut

Untuk project yang dikelola manual, buka isi penuh tiap file yang sudah dipastikan belum diterapkan di SQL Editor, jalankan sesuai urutan, dan tunggu sukses sebelum melanjutkan. Jika kelak memakai CLI, baseline dan history perlu ditinjau terpisah sebelum mengubah jalur deployment. Worker Lambda tidak membutuhkan deployment Supabase Edge Function.

| Urutan | File dari root repo | Fungsi |
| --- | --- | --- |
| 1 | `supabase/migrations/20261107180000_staffing_attendance.sql` | Region, staff, grup, undangan, absensi, evidence, audit dan outbox |
| 2 | `supabase/migrations/20261107193000_staffing_weekly_schedule.sql` | Timetable, versioning dan commit mingguan |
| 3 | `supabase/migrations/20261107203000_staffing_operations_payroll.sql` | Izin/sakit, kasbon, payroll dan antrean aktivitas |
| 4 | `supabase/migrations/20261107220000_staffing_create_staff.sql` | Create Staff, kode otomatis dan saldo awal |
| 5 | `supabase/migrations/20261108003000_staffing_review_replacement.sql` | Review absensi dan riwayat Menggantikan |
| 6 | `supabase/migrations/20261108100000_staffing_telegram_workflows.sql` | Waktu command awal, menu pribadi dan persetujuan perubahan shift |
| 7 | `supabase/migrations/20261109090000_staffing_group_management.sql` | Satu grup per store, perubahan grup oleh admin dan audit |

File ini bukan skrip yang bebas diulang. Error `relation already exists`, `function already exists` atau `column already exists` perlu dicocokkan dengan penerapan sebelumnya; jangan menghapus objek/data untuk memaksa ulang.

Migration nomor 1 mengubah constraint peran `app_users` agar menerima `manager`. Data user existing tidak dihapus. Pada database produksi, tetap lakukan review perubahan dan backup sebelum penerapan; panduan utama ini untuk tes terlebih dahulu.

### 3.4. Verifikasi hasil migration

Cara paling ringkas: salin isi [`supabase/checks/staffing-production-postflight.sql`](../supabase/checks/staffing-production-postflight.sql) ke query baru SQL Editor dan jalankan. Semua kolom hasil harus `true`. Query ini read-only; tidak mengirim pesan Telegram.

Jalankan query berikut. Kolom function seharusnya menampilkan signature, bukan `NULL`; kedua kolom privilege terakhir seharusnya `false`.

```sql
select
  to_regprocedure('public.staffing_apply_update(jsonb)') as telegram_dispatcher,
  to_regprocedure('public.staffing_create_staff(uuid,boolean,jsonb)') as create_staff,
  to_regprocedure('public.staffing_review_attendance(uuid,boolean,jsonb)') as review_attendance,
  to_regprocedure('public.staffing_decide_shift(uuid,boolean,uuid,text,text)') as decide_shift,
  has_function_privilege('anon', 'public.staffing_apply_update(jsonb)', 'execute') as anon_can_write,
  has_function_privilege('authenticated', 'public.staffing_decide_shift(uuid,boolean,uuid,text,text)', 'execute') as client_can_approve;
```

Pastikan dispatcher baru, bukan versi absensi lama:

```sql
select
  position('staffing_apply_update_v4' in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure)) > 0
  and position('staffing_attendance_update_v3' in pg_get_functiondef('public.staffing_apply_update_v4(jsonb)'::regprocedure)) > 0
  as new_dispatcher_installed;
```

Hasil yang diharapkan: `true`.

Jika RPC belum muncul pada Data API setelah migration berhasil, reload schema cache:

```sql
notify pgrst, 'reload schema';
```

### 3.5. Ambil koneksi project tes

Di Supabase, salin **Project URL** dan **server secret key** (`sb_secret_…` atau legacy `service_role` yang sesuai). Isi `SUPABASE_URL` dan `SUPABASE_SECRET_KEY` di file konfigurasi eksternal.

Jangan memakai publishable/anon key untuk worker atau dashboard server, dan jangan menaruh server secret pada variabel `NEXT_PUBLIC_*`. Dashboard dan Lambda harus memakai **project yang sama**. [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)

### 3.6. Siapkan satu store tes

Jika store tujuan sudah tersedia, gunakan store tersebut. Untuk project staging baru khusus Staffing, kamu dapat menambahkan store tanpa kredensial POS:

```sql
insert into public.stores(name, time_zone, utc_offset, active)
values ('Sarkop Jatinangor - Telegram Test', 'Asia/Jakarta', '+07:00', true)
on conflict (name) do nothing;
```

Untuk Palu, gunakan `Asia/Makassar` dan `+08:00`.

Form **Tambah store** di dashboard saat ini masih meminta refresh token POS. Insert sederhana ini adalah jalur bootstrap untuk store khusus tes di database staging; tidak perlu memasukkan token POS palsu atau menyalin token produksi. Webhook dashboard Staffing tidak menjalankan ingestion POS. Jangan mengubah database/credential Lambda POS production untuk tes staging.

## 4. Jalankan atau deploy dashboard dengan environment yang benar

### Opsi A: dashboard lokal untuk tes pertama

Dari folder integrasi, pastikan file eksternal sudah terisi, lalu jalankan:

```bash
node --env-file=/tmp/spark-staffing-telegram.env \
  node_modules/next/dist/bin/next dev \
  --hostname 127.0.0.1 --port 3110
```

Buka `http://localhost:3110/login`, lalu login memakai `SETTINGS_ADMIN_USERNAME` dan `SETTINGS_ADMIN_PASSWORD` yang baru kamu tentukan. Buka `http://localhost:3110/staffing`.

Dashboard lokal boleh digunakan untuk review. Telegram tetap mengirim webhook ke **Lambda HTTPS publik**, sehingga tidak perlu mengekspos port localhost sebagai webhook. Tutup browser tidak menghentikan Lambda; hentikan/restart proses Next hanya jika mengubah environment dashboard lokal.

### Opsi B: dashboard preview/hosting

Deploy kode Staffing ke environment preview terpisah dan isi variabel server:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SETTINGS_ADMIN_USERNAME`
- `SETTINGS_ADMIN_PASSWORD`
- `AUTH_SESSION_SECRET`
- `STAFFING_TELEGRAM_BOT_USERNAME`
- `STAFFING_TELEGRAM_BOT_TOKEN`

Pilih environment preview yang benar, kemudian **redeploy** agar perubahan environment dipakai. Token Staffing pada dashboard dibutuhkan untuk proxy foto; undangan memakai username bot. `STAFFING_TELEGRAM_WEBHOOK_SECRET` dibutuhkan route webhook di dashboard, terpisah dari secret login dashboard.

**Hasil yang diharapkan:** halaman Staffing dapat dibuka dan menu Pengaturan tersedia untuk akun admin. Akun manager biasa belum dapat membuka semua kategori Pengaturan.

## 5. Siapkan region, akses, staff dan grup di dashboard

Gunakan URL lokal `http://localhost:3110` atau base URL preview milikmu untuk semua path berikut.

### 5.1. Buat region dan petakan store

1. Buka **Staffing → Pengaturan → Region**: `/staffing/settings?section=regions`.
2. Klik **Tambah region**, misalnya `Region Tes Jatinangor`.
3. Pada bagian **Hubungkan store ke region**, klik **Hubungkan store**.
4. Pilih store tes dan region tadi, lalu simpan.
5. Pastikan store muncul pada baris region yang benar.

Store yang sudah dipetakan ke region tidak dapat dipindah region melalui form ini. Untuk tes, gunakan mapping yang benar sejak awal atau store staging yang baru.

### 5.2. Siapkan akun manager bila diperlukan

Kamu dapat melakukan seluruh tes awal menggunakan login bootstrap admin. Untuk mencoba pembatasan manager:

1. **Pengaturan → Akun pengguna → Tambah akun**.
2. Buat akun aktif dengan peran **Manager**.
3. **Pengaturan → Akses manager → Tambah akses**.
4. Pilih akun manager tersebut dan region tes, lalu simpan.
5. Uji login manager di profil browser terpisah/incognito agar sesi admin tetap tersedia.

Manager tanpa region tidak otomatis melihat store. Password akun dashboard tidak dikirim ke Telegram.

### 5.3. Buat dua profil staff

1. Buka **Staff Management**: `/staffing/staff`.
2. Klik **Create staff**.
3. Buat Staff A memakai nama PNS A; pilih home store tes.
4. Isi saldo izin awal dan plafon kasbon khusus tes sesuai kebutuhan. Kode staff dibuat otomatis.
5. Ulangi untuk Staff B.
6. Pastikan keduanya aktif.

Akun Telegram kamu tidak perlu dibuatkan profil staff kecuali kamu juga ingin mencoba absensi sebagai staff. Staff A/B tidak perlu mendapat role admin/manager aplikasi.

### 5.4. Hubungkan grup melalui menu Telegram

1. Buka **Pengaturan → Telegram**: `/staffing/settings?section=telegram`.
2. Periksa username pada card **Bot staffing**.
3. Klik **Hubungkan grup**.
4. Pilih store tes yang sudah aktif dan terhubung ke region.
5. Isi **ID grup Telegram** yang diperoleh pada langkah 2.2, lengkap dengan tanda minus.
6. Klik **Hubungkan grup** dan pastikan baris store/ID muncul dengan status **Terdaftar**.

Arti status pada layar:

| Status | Yang sudah dibuktikan |
| --- | --- |
| **Konfigurasi tersedia** | Environment dashboard berisi username dan token; belum merupakan tes koneksi ke Telegram/AWS |
| **Terdaftar** | Mapping grup → store ada di database; belum membuktikan bot menjadi anggota grup atau webhook sehat |

Form ini tidak menambahkan bot ke grup secara otomatis. Jika tombol Hubungkan grup nonaktif, periksa store aktif, mapping region, serta apakah store sudah didaftarkan ke grup. Untuk mengganti mapping existing, klik **Ubah grup**, masukkan ID grup baru dan alasan perubahan. Hanya admin yang boleh menyimpan; proses absensi/tukar shift dan pengiriman pesan pada grup lama harus selesai terlebih dahulu. Migration pengelolaan grup harus terpasang.

## 6. Deploy webhook dashboard dan update Lambda POS existing

**Arsitektur produksi yang dipilih:** webhook pada Next.js/Vercel, dengan retry notifikasi pada satu Lambda POS existing. Tidak menambah Lambda atau EventBridge schedule.

Ikuti [runbook aktivasi dashboard webhook](staffing-dashboard-webhook.md). Target yang diverifikasi adalah Lambda `spark-kaspin-pos-poller` di `us-east-2`, handler `worker.handler`. Function ini dibuat tanpa kepemilikan CloudFormation yang ditemukan pada pemeriksaan; jangan menjalankan `staffing-template.yaml` atau template SAM dua fungsi sebagai update existing.

Langkah ringkas:

1. Tambahkan tiga variabel bot Staffing pada environment production dashboard, lalu deploy route `/api/telegram/staffing` beserta middleware dan modulnya.
2. Jalankan `pnpm aws:build:staffing` untuk menghasilkan ZIP satu poller dengan handler existing.
3. Jalankan script prepare pada runbook untuk membaca konfigurasi, mempertahankan seluruh environment POS, dan menyiapkan backup/rollback lokal tanpa mengubah AWS.
4. Setelah review, terapkan paket update existing. Runtime, handler, memory dan architecture dipertahankan.

URL webhook produksi:

```text
https://dashboard.sarkop.sparkfoodservice.com/api/telegram/staffing
```

Endpoint harus publik dan tidak diarahkan ke login dashboard. POST tetap dilindungi secret Telegram. Badge konfigurasi bot bukan bukti bahwa deployment/webhook aktif.

## 7. Pasang command menu dan webhook bot

Dari folder integrasi, tinjau rencana terlebih dahulu:

```bash
node --env-file=/tmp/spark-staffing-telegram.env \
  scripts/staffing-telegram-setup.mjs
```

Hasil dry-run harus menunjukkan username bot Staffing dan URL dashboard `/api/telegram/staffing` yang benar. Dry-run tidak mengirim request Telegram.

Setelah benar, jalankan pemasangan:

```bash
node --env-file=/tmp/spark-staffing-telegram.env \
  scripts/staffing-telegram-setup.mjs --apply
```

Script memeriksa identitas bot, menolak webhook existing yang berbeda, memasang menu command grup/pribadi, lalu memasang webhook dengan secret. Tidak perlu memasukkan daftar command secara manual melalui BotFather.

Jika script menyebut ada webhook berbeda, periksa dulu tujuan lama dan pastikan bot benar-benar bot Staffing tes. Flag `--replace-webhook` hanya untuk penggantian yang memang disengaja, bukan solusi default untuk error koneksi.

### 7.1. Cek status webhook tanpa mencetak token

```bash
node --env-file=/tmp/spark-staffing-telegram.env --input-type=module <<'NODE'
const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Token Staffing belum diisi.');
try {
  const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    method: 'POST', signal: AbortSignal.timeout(15000)
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error();
  const w = data.result;
  console.log(JSON.stringify({
    url: w.url, pending_update_count: w.pending_update_count,
    last_error_date: w.last_error_date, last_error_message: w.last_error_message,
    allowed_updates: w.allowed_updates
  }, null, 2));
} catch { throw new Error('Gagal memeriksa webhook; token tidak dicetak.'); }
NODE
```

URL harus cocok dengan endpoint `/api/telegram/staffing` dashboard yang sudah dipublikasikan. `allowed_updates` berisi `message` dan `callback_query`. Jumlah pending seharusnya berkurang setelah worker memprosesnya. `last_error_message` dapat berasal dari percobaan sebelumnya; cocokkan waktu error dan lakukan tes baru. Field tersebut dijelaskan pada [Telegram WebhookInfo](https://core.telegram.org/bots/api#webhookinfo).

## 8. Tautkan masing-masing PNS ke akun Telegramnya

Lakukan setelah worker dan webhook aktif agar bot dapat membalas `/start`.

### Staff A

1. Login dashboard sebagai admin atau manager dengan cakupan home store Staff A.
2. **Staff Management → klik nama Staff A**.
3. Buka **Pengaturan Profil**.
4. Klik tombol biru **Buat undangan Telegram**, di sebelah **Simpan profil**.
5. Salin link yang tampil. Link berisi token sekali pakai, berlaku **24 jam**.
6. Kirim link itu **secara pribadi ke PNS A**; jangan ke grup.
7. PNS A membuka link menggunakan **akun Telegram PNS A sendiri**, lalu menekan **Start**.
8. Bot membalas bahwa akun berhasil ditautkan dan mengarahkan ke `/menu`.
9. Refresh profil di dashboard. Status harus menjadi **Telegram tertaut**.
10. PNS A mengirim `/menu` di chat pribadinya dengan bot dan memastikan informasi/jadwal miliknya.

Ulangi seluruh langkah untuk Staff B dengan link yang berbeda dan **akun Telegram PNS B**.

Jangan membuka link undangan PNS A/B menggunakan akun Telegram kamu untuk mengetes, karena itu justru akan menautkan profil PNS ke akunmu. Satu profil ditautkan ke satu Telegram User ID; nama tampilan atau username bukan identitas login.

Jika link belum dipakai tetapi kedaluwarsa, buat undangan baru dari profil staff. Undangan baru membatalkan undangan lama yang belum digunakan. Jika salah akun sudah tertaut, hentikan pengujian profil itu dan lakukan reset penautan yang ditinjau; UI unlink/reset akun belum tersedia.

## 9. Uji absensi pertama

### 9.1. Siapkan satu shift yang bisa diabsen sekarang

1. Buka **Scheduling** → pilih store tes dan minggu sesuai tanggal store.
2. Klik **Buat jadwal / Edit jadwal**.
3. Tambahkan Staff A ke hari ini dengan shift yang sudah dimulai atau mulai dalam dua jam, dan jam selesai masih di masa depan.
4. Pastikan Staff A hanya mempunyai **satu shift yang memenuhi window tersebut** di store tes; jangan memakai shift historis atau draft yang belum di-commit.
5. Klik **Commit jadwal**.

Tanggal/jam mengikuti store: Jatinangor `Asia/Jakarta` (WIB), Palu `Asia/Makassar` (WITA). Gunakan hari store yang sebenarnya, walaupun tanggal di laptopmu bisa berbeda.

### 9.2. Jalankan check-in dari PNS A

Dari akun PNS A di grup:

```text
/masuk@username_bot_kamu
```

Kemudian:

1. Periksa nama, store dan shift pada balasan bot.
2. Klik **Benar, lanjutkan**.
3. Gunakan **Reply** ke pesan permintaan lokasi. Di Telegram mobile: attachment/klip → Location → kirim lokasi.
4. Tunggu pesan permintaan foto berikutnya.
5. Gunakan **Reply** ke pesan tersebut, lalu kirim satu foto sebagai **Photo**, bukan sebagai file document.
6. Selesaikan seluruh bukti dalam **10 menit dari command awal**.

**Hasil yang diharapkan:** bot mengumumkan check-in dan status menunggu review. Waktu efektif memakai timestamp command awal Telegram setelah bukti lengkap; command tanpa bukti lengkap tidak menjadi absensi.

### 9.3. Review dari dashboard

1. Buka **Activities → Kehadiran** atau **Antrean Review**.
2. Pilih store/tanggal yang sesuai, lalu klik **Perbarui** bila perlu.
3. Baris Staff A yang pending berlatar kuning muda. Klik **Review / Detail**.
4. Periksa lokasi, foto dan jam.
5. Pilih **Konfirmasi absensi** atau **Tolak absensi**, isi catatan, lalu **Simpan review**.
6. Periksa perubahan status di dashboard serta notifikasi chat pribadi Staff A.

Jika foto ada di grup tetapi tidak tampil di dashboard, periksa `STAFFING_TELEGRAM_BOT_TOKEN` pada environment dashboard: token harus berasal dari bot yang menerima foto tersebut.

### 9.4. Checkout

Dari akun PNS A di grup:

```text
/pulang@username_bot_kamu
```

Konfirmasi, reply lokasi, lalu reply foto lagi. Checkout memakai sesi yang masih terbuka dan mendukung melewati tengah malam. Bukti lengkap tetap dibutuhkan. Jika check-in sempat direview sebelum checkout, checkout baru membuat status kembali pending supaya jam akhir diperiksa manager.

Ulangi untuk PNS B dengan shift miliknya sendiri.

## 10. Uji penggantian dan pertukaran shift

Gunakan **shift lain di masa depan yang belum pernah dimulai proses absensinya**. Jangan memakai shift yang barusan dipakai untuk check-in: adanya attempt/sesi mengunci perubahan penugasan tersebut.

### 10.1. Penggantian satu shift

1. Commit shift mendatang milik Staff A, misalnya lusa. Pastikan B tidak mempunyai shift bentrok atau izin yang telah disetujui pada waktu itu.
2. Dari PNS A di grup, kirim `/tukar@username_bot_kamu`.
3. Pilih **Minta pengganti** → shift A → Staff B.
4. Bot menampilkan ringkasan dan tombol **Saya bersedia**, **Tolak**, **Batalkan permintaan**.
5. Coba akun kamu menekan **Saya bersedia**. Tidak boleh ada perubahan status persetujuan/jadwal; pesan bot di grup menjelaskan siapa pihak kedua yang dituju.
6. PNS B menekan **Saya bersedia**. Status menjadi menunggu manager; jadwal masih milik A.
7. Manager membuka **Activities → Antrean Review → Jenis antrean: Permintaan shift**.
8. Klik **Review perubahan**, periksa jam, jeda, total jam dan coverage, isi catatan keputusan.
9. Klik **Setujui & perbarui jadwal**.
10. Jadwal pindah ke B, hasil dikirim ke grup serta chat pribadi kedua staff. Riwayat penugasan B menyimpan **Menggantikan A**.

Pilihan pihak kedua menampilkan staff aktif, sudah tertaut Telegram, dan home store berada di region store penugasan. Manager penentu harus berwenang untuk kedua home store dan store penugasan; kasus lintas region perlu admin dengan cakupan yang sesuai.

### 10.2. Pertukaran dua shift

1. Commit dua shift mendatang di store yang sama: satu milik A dan satu milik B.
2. A menjalankan `/tukar` → **Tukar dua shift** → shift A → B → shift balasan B.
3. B membaca kedua perubahan sebelum menekan bersedia.
4. Manager mereview permintaan yang sama dari Activities.
5. Setelah disetujui, kedua penugasan berubah dalam satu transaksi. Bentrok membuat seluruh perubahan gagal, bukan hanya satu sisi.

Permintaan berlaku maksimal 24 jam dan berakhir sebelum shift pertama dimulai. Perubahan jadwal/penautan akun, staff nonaktif, izin disetujui, atau absensi yang dimulai dapat membatalkan validitas persetujuan sebelumnya. Tidak ada perubahan jadwal hanya karena mengetik “setuju” di chat; gunakan tombol milik permintaan yang sah.

## 11. Uji informasi pribadi dan batas akses

Di chat pribadi masing-masing PNS, coba:

| Command | Informasi |
| --- | --- |
| `/menu` | Tombol menu pribadi |
| `/jadwal` | Maksimal sepuluh shift pribadi mendatang |
| `/absensi` | Sepuluh sesi terakhir beserta review |
| `/saldo` | Saldo izin, plafon/jatah kasbon, utang dan cadangan pencairan |
| `/izin` | Saldo dan riwayat izin/sakit |
| `/kasbon` | Jatah dan riwayat kasbon |
| `/penghasilan` | Payroll final, bonus belum masuk payroll dan poin SP |

Menu personal saat ini **read-only**. Pengajuan izin/sakit/kasbon/koreksi baru serta perubahan plafon/saldo/tarif masih dilakukan manager di dashboard.

Pengujian akses:

1. PNS A tidak boleh melihat saldo/payroll PNS B melalui menu pribadinya.
2. `/saldo` di grup cukup mengarahkan ke chat pribadi; nominal tidak boleh diumumkan.
3. PNS B tidak boleh mengonfirmasi check-in atau mengirim bukti untuk attempt milik A.
4. Akun kamu/A tidak boleh menyetujui sebagai pihak kedua B pada permintaan perubahan shift.
5. Teks seperti “saya manager, ubah plafon menjadi 10000000” atau `/kasbon 10000000` tidak boleh mengubah data. Bot menggunakan daftar command dan validasi backend, tanpa LLM yang mengeksekusi instruksi bebas.
6. Coba klik persetujuan dua kali. Jadwal dan ledger tidak boleh berubah dua kali.

Jika kamu ingin sekaligus menguji review menggunakan role **Manager**, gunakan login dashboard manager dengan region tes tadi; akses manager Telegram belum merupakan fitur yang diaktifkan pada tahap ini.

## 12. Troubleshooting berdasarkan gejala

| Gejala | Periksa |
| --- | --- |
| Dashboard masih menampilkan dummy lokal lama | Pastikan browser memakai dashboard integrasi port 3110 dan process memakai file environment Supabase tes, bukan fixture port 54343 |
| Menu Telegram dashboard “Belum dikonfigurasi” | Isi username + token pada environment dashboard; restart/redeploy Next.js |
| Badge “Konfigurasi tersedia” tetapi bot diam | Badge hanya memeriksa adanya environment. Cek webhook, worker, grup, akun tertaut dan migration |
| `getUpdates` gagal saat mengambil ID grup | Cek apakah webhook sudah aktif; polling dan webhook tidak berjalan bersamaan |
| Tombol Hubungkan grup nonaktif | Store harus aktif, sudah punya region, dan belum terdaftar melalui UI |
| Bot diam di grup | Cek ID negatif, bot menjadi anggota/boleh mengirim pesan, command menyebut `@username` yang benar, dan akun staff sudah tertaut |
| Link undangan tidak mendapat balasan | Webhook dashboard harus aktif; periksa log Vercel, konfigurasi bot dan secret yang sama |
| Undangan tidak berlaku | Batas 24 jam, sekali pakai, undangan baru menggantikan yang belum dipakai; pastikan profil aktif |
| Tidak ditemukan satu shift sesuai | Jadwal harus committed, staff/store benar, mulai maksimal dua jam dari sekarang atau masih berlangsung, belum punya sesi; cek timezone dan shift lain dalam window |
| Lokasi/foto tidak melanjutkan proses | Reply ke prompt terbaru, gunakan akun yang sama dan grup yang sama, tahap lokasi sebelum foto, belum lewat 10 menit; foto harus dikirim sebagai Photo |
| Foto hanya ada di Telegram | Samakan token bot pada dashboard dan worker; periksa akses evidence sesuai region |
| Staff B tidak muncul sebagai pengganti | Staff aktif, Telegram tertaut, sesuai region store dan halaman pilihan; gunakan Berikutnya bila daftar lebih dari delapan |
| Manager tidak melihat permintaan shift | B harus sudah bersedia; cek filter antrean, store dan region manager mencakup kedua home store; permintaan belum kedaluwarsa |
| Jadwal terkunci / berubah | Buat permintaan baru dari jadwal terbaru; shift dengan attempt/sesi absensi tidak bisa dipindah |
| `PGRST202` / fungsi tidak ditemukan | Pastikan migration benar-benar dijalankan pada project yang sama; reload schema cache setelah sukses |
| `permission denied` pada store/user/RPC | Periksa jenis key server dan grant `service_role` sesuai schema/migration; jangan mematikan RLS atau memberikan hak tulis ke anon untuk mengatasi error |
| Webhook HTTP 401 | `STAFFING_TELEGRAM_WEBHOOK_SECRET` pada Vercel harus sama dengan nilai saat script `--apply` |
| Endpoint webhook diblokir sebelum handler | Pastikan domain/path dashboard benar, deployment protection tidak memblokir Telegram, dan middleware baru sudah aktif |
| HTTP 503 / update pending bertambah | Cek environment dashboard, Supabase URL/key, migration, dan log Vercel untuk webhook; cek log Lambda untuk retry |

Log webhook berada pada deployment Vercel dashboard. Retry notifikasi berada pada Lambda POS existing. Untuk log retry:

```bash
aws logs tail /aws/lambda/spark-kaspin-pos-poller \
  --region us-east-2 --profile default --since 10m
```

Worker sengaja tidak mencetak token, body chat atau isi bukti. Untuk antrean pesan, gunakan SQL baca yang tidak mengeluarkan payload pribadi:

```sql
select id, method, delivered_at, failures, retry_at
from public.staffing_outbox
order by id desc
limit 20;
```

`delivered_at` terisi menandakan worker telah menyimpan receipt pengiriman. Pengiriman Telegram memakai retry dan bersifat at-least-once: pesan notifikasi dapat terduplikasi pada kasus crash tertentu, sedangkan event absensi/keputusan database tetap dideduplicasi.

## 13. Kapan setup dianggap selesai?

- [ ] Dashboard integrasi dan Lambda menggunakan project Supabase tes yang sama.
- [ ] Tujuh migration Staffing lengkap dan privilege anon/authenticated tetap tertutup.
- [ ] Bot khusus Staffing ada di grup, menu command dan webhook berhasil dipasang.
- [ ] ID grup terdaftar pada store/region yang benar di dashboard.
- [ ] PNS A/B tertaut ke profil masing-masing dan `/menu` membalas informasi pribadi yang benar.
- [ ] Check-in/out lengkap muncul di dashboard dengan jam command awal dan bukti yang bisa dibuka.
- [ ] Review manager mengubah status dan mengirim hasil ke chat pribadi staff.
- [ ] Pergantian shift memerlukan persetujuan B lalu manager, dan hasilnya tersimpan atomik.
- [ ] Percobaan dari akun lain, command palsu dan klik berulang tidak mengubah data tanpa izin.

Untuk arsitektur produksi yang dipilih, gunakan [runbook dashboard webhook](staffing-dashboard-webhook.md); contoh stack standalone terdahulu bukan instruksi menambah Lambda baru. Folder `/tmp` pada panduan ini dipakai untuk tes dan dapat dibersihkan sistem. Untuk operasi permanen, simpan konfigurasi pada secret/environment deployment yang dikelola dan jalankan tahapan rollout produksi setelah pengujian nyata lulus. Migration remote, AWS deployment, webhook serta real Telegram tetap perlu diverifikasi pada lingkungan tujuan; hasil tes lokal tidak menggantikannya.
