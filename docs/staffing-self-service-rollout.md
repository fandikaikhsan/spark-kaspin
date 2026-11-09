# Store dan pengajuan Telegram

Perubahan ini menambahkan satu migration di atas **tujuh migration yang sudah terpasang**. Jangan jalankan ulang tujuh file lama. Tidak membutuhkan Lambda, scheduler, bot, atau environment variable baru.

## Urutan update production

1. Di Supabase SQL Editor, jalankan seluruh isi `supabase/migrations/20261109180000_staffing_self_service.sql`. Satu transaksi; bila gagal, jangan lanjut deploy. Jika editor memperingatkan soal RLS, SQL sudah mengaktifkan RLS dan mencabut akses client secara eksplisit dalam transaksi.
2. Jalankan `supabase/checks/staffing-self-service-postflight.sql`. Semua kolom harus `true`. Pemeriksaan ini read-only, tanpa pesan Telegram.
3. Deploy branch `feat/staffing-requests` ke dashboard existing melalui jalur Git/Vercel. Webhook dan env existing tetap dipakai.
4. Lambda POS tidak perlu diperbarui untuk pengajuan ini: pemrosesan input baru ada pada dashboard + SQL, sedangkan worker retry existing memanggil RPC receipt yang kompatibel.
5. Opsional: setelah deploy, jalankan script setup bot existing dengan `--apply` untuk menyegarkan deskripsi command. URL webhook tetap sama; menu pengajuan di dalam pesan tersedia tanpa menjalankan setup ulang.

Draft pemilihan tukar shift dari versi lama perlu dimulai ulang dengan `/tukar` setelah update; permintaan yang sudah terkirim tetap dipertahankan.

SQL menambah WIT, field bukti pada pengajuan, state draft pribadi, dan RPC terkait. Tidak mengubah nominal plafon, saldo izin, catatan POS, ataupun waktu shift yang sudah ada. Jika ada constraint timezone tambahan di database yang tidak dikenali, migration berhenti untuk ditinjau. Setelah rollback aplikasi, pertahankan migration dan data baru; jangan menghapus tabel pengajuan untuk rollback UI.

## Store dan region

Pengaturan → Store → **Edit store**: nama, zona waktu (WIB/WITA/WIT), status, dan integrasi existing. Jadwal, absensi, PDF, payroll, dan tanggal operasional memakai zona store; shift disimpan sebagai waktu absolut. Koreksi timezone mengubah cara waktu itu ditampilkan, tanpa menggeser shift tersimpan. Untuk staf yang sementara bekerja di store lain, jam shift/absensinya memakai store tempat bekerja; periode payroll mengikuti home store.

Pengaturan → Region → **Edit region**: mengganti nama, mempertahankan ID dan relasi. Pengaturan → Store → **Ubah region**: tindakan admin yang memindahkan cakupan akses manager, memerlukan alasan, menolak edit basi dan proses absensi / tukar yang masih aktif, serta mencatat audit. Manager tetap mengelola staf dalam region yang diberikan; pengaturan organisasi tetap mengikuti hak admin existing.

## Chat pribadi

- `/kasbon`: plafon, utang, ketersediaan, riwayat, dan **Ajukan kasbon**. Isi angka rupiah tanpa tanda pemisah lalu konfirmasi **Kirim pengajuan**. Batas dicek saat input dan submit di transaksi yang mengunci staf. Pengajuan pending lain ikut mengurangi jumlah yang boleh diajukan. Persetujuan dan pencairan tetap tindakan manager; hanya pencairan yang mencatat utang untuk pengembalian melalui payroll.
- `/izin`: saldo, riwayat, dan **Ajukan izin / sakit**. Pilih izin berbayar, tanpa upah, atau sakit; isi tanggal mulai/selesai dengan `DD/MM/YYYY`, alasan, dan bukti foto atau PDF/JPG/PNG maksimal 10 MB. Balas langsung pertanyaan bot. Periksa ringkasan lalu kirim. Bukti tetap di Telegram dan referensinya dapat dibuka manager dari detail pengajuan dashboard sesuai region.
- Rentang maksimum 62 hari; tanggal lokal store antara 30 hari lalu sampai satu tahun ke depan. Semua tanggal dalam rentang dihitung satu hari kalender dan ditampilkan sebelum konfirmasi. Untuk setengah hari / tanggal libur yang perlu dikecualikan, manager mencatat pengajuan dengan rincian unit yang sesuai. Saldo izin berbayar diperiksa terhadap pengajuan pending; saldo baru berkurang setelah persetujuan manager. Tanggal yang bertabrakan dengan pengajuan pending/disetujui harus diselesaikan dahulu.
- Draft pribadi kedaluwarsa 30 menit sejak dimulai. Keyboard lama, balasan ke pertanyaan lama, akun lain, forward, dan input yang mencoba mengubah identitas/plafon tidak memberikan hak manager.

## Tukar jadwal di grup store

`/tukar` → pilih **nama rekan** → pilih jenis perubahan. Untuk **Tukar dua shift**, pilih jadwal committed rekan yang diinginkan lalu shift milik sendiri yang ditukar. Untuk **Minta pengganti**, pilih shift milik sendiri. Pilihan dibatasi staf aktif tertaut dalam region dan shift mendatang di store grup. Jika tidak ada nama, periksa region, status aktif, dan tautan Telegram.

Pesan permintaan muncul di grup. Hanya akun Telegram rekan yang dipilih dapat menekan **Saya bersedia** / **Tolak**. Setelah rekan bersedia, manager menyetujui di Activities; jadwal baru berubah setelah persetujuan manager. Snapshot shift dan akun peserta diperiksa ulang agar persetujuan tidak dipakai untuk jadwal yang telah berubah.

## Apa itu `/batal`?

`/batal` menghentikan proses **yang belum selesai di chat tempat command dikirim**:

- Chat pribadi: membuang draft izin / kasbon yang belum dikirim.
- Grup: membuang pemilihan tukar shift dan membatalkan verifikasi absen yang belum selesai, milik pengirim command tersebut.

Command ini tidak menghapus check-in/out yang sudah tercatat, shift committed, atau pengajuan yang sudah dikirim. Pengaju membatalkan permintaan tukar terkirim menggunakan **Batalkan permintaan** pada pesan itu (selama masih menunggu). Pengajuan izin / kasbon terkirim ditangani manager dari dashboard. Pembatalan draft tidak mengurangi saldo atau utang.
