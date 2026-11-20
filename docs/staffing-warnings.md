# Peringatan dan poin staf

## Aturan fitur

Sumber: `rules_staff_pns.pdf`, bagian 5, dan konfirmasi pemilik produk:

- Poin akumulatif: ringan 1, sedang 2, berat 3, sangat berat 4.
- Masa pembinaan diatur per surat. Selesainya masa pembinaan tidak menghapus poin.
- Manager dalam cakupan region atau admin dapat mengubah total poin dengan alasan. Kenaikan atau pengurangan membuat transaksi baru; saldo tidak boleh negatif.
- Tingkat surat SP1 / SP2 / SP3 dipilih terpisah dari bobot poin. Contoh: SP2 dapat berbobot 3 poin jika kategorinya berat.
- Saldo 4 atau lebih menjadi ambang evaluasi sesuai aturan. Tidak ada pemecatan, penonaktifan, atau sanksi otomatis.
- Angka denda per poin di PDF aturan masih berupa usulan. Fitur ini tidak membuat denda atau potongan payroll. Catatan sanksi tambahan hanya dicetak jika manager mengisinya.
- Catatan SP lama tetap masuk saldo dan riwayat; tidak diubah menjadi surat formal secara otomatis.

## Migration Supabase dan rollout

Database existing telah menerima sepuluh migration Staffing sampai `20261109210000_staffing_payroll_documents_proxy.sql`.

1. Pastikan project Supabase yang dipilih benar dan simpan backup sesuai prosedur production.
2. Buka SQL Editor. Copy **seluruh isi satu file baru**: `supabase/migrations/20261111170000_staffing_warnings.sql`, lalu Run satu kali. File memakai transaksi; error menggagalkan seluruh perubahan pada transaksi tersebut. Tidak perlu mengulang sepuluh file lama.
3. Jika SQL Editor mendeteksi tabel tanpa RLS, pilih **Run without RLS** agar menjalankan skrip asli. Skrip mengaktifkan RLS dan mencabut akses `anon` / `authenticated` sendiri sebelum commit. Jangan menambahkan kebijakan akses client.
4. Setelah berhasil, jalankan seluruh isi `supabase/checks/staffing-warnings-postflight.sql`. Semua kolom harus `true`.
5. Untuk UI Ubah poin, jalankan juga seluruh `supabase/migrations/20261111190000_staffing_point_adjustments.sql`, lalu `supabase/checks/staffing-point-adjustments-postflight.sql` (semua kolom `true`). Ini migration tambahan; file warning sebelumnya tidak diubah.
6. Deploy versi aplikasi yang menyertakan tab Peringatan dan endpoint `/api/staffing/warnings`. Migration perlu tersedia sebelum fitur ini digunakan.
7. Konfigurasi bot yang sudah ada tetap dipakai. Tidak ada environment variable, webhook, cron, Lambda, atau worker baru.
8. Uji dengan staf dummy di lingkungan pengujian terlebih dahulu. Jangan menerbitkan surat dummy untuk staf production.

Migration menambah empat tabel `staffing_warning_*` / `staffing_warnings`, kolom ledger pada `staffing_discipline`, trigger saldo dan penerima, RPC server, serta wrapper detail staf. Data POS, payroll, dan Telegram attendance tidak diubah. Tidak memakai `supabase db push` untuk mereplay riwayat SQL Editor lama.

Jika migration sudah berhasil tetapi deployment ditunda, data SP lama tetap dapat dibaca. Jangan menghapus tabel atau menurunkan ledger untuk rollback: kembalikan versi aplikasi terlebih dahulu, kemudian review migration perbaikan bila diperlukan.

## Alur manager

1. Staff Management → pilih staf → **Peringatan**.
2. Lihat total poin, jumlah surat terbit dan draft. Tabel Riwayat poin & surat menggabungkan seluruh transaksi dan surat; draft ada di atas dan dapat diklik untuk membuka modal. Daftar bisa dicari / difilter. Aktivitas detail ada di modal masing-masing surat.
3. Klik **Buat surat peringatan**. Isi:
   - SP1 / SP2 / SP3 serta kategori bobot poin.
   - Perihal, tanggal surat, jabatan / unit kerja staf.
   - Tanggal / jam opsional, tempat, kronologi kejadian, hasil pemeriksaan, dasar aturan yang telah dikonfirmasi, dan klarifikasi staf opsional.
   - Tindakan perbaikan (satu per baris), tindak lanjut jika terulang, sanksi tambahan opsional.
   - Awal / akhir pembinaan; contoh awal enam bulan dapat diganti per surat.
   - Kota, nama dan jabatan penerbit.
4. **Simpan draft & periksa PDF**. Draft boleh belum lengkap, belum mendapat nomor dan belum menambah poin. Edit draft sampai fakta dan isinya sesuai.
5. Periksa pratinjau, centang konfirmasi pemeriksaan, lalu **Terbitkan surat & catat poin**. Isian wajib harus lengkap. Nomor unik dibuat per tahun, contoh `001/SP2/SARKOP/XI/2026`. Isi dan identitas saat terbit dibekukan. Klik ulang tidak menggandakan poin.
6. Download PDF atau kirim melalui tombol Telegram. Penerbitan tidak mengirim otomatis. PDF menyediakan area tanda tangan; tidak menyalin tanda tangan dari contoh atau mengklaim tanda tangan digital.
7. Untuk perubahan poin: **Ubah poin** → total poin baru → alasan → Simpan. Dapat menaikkan atau menurunkan saldo. Selisih, saldo sebelum / setelah dan pelaku tercatat. Riwayat surat tidak dihapus.
8. Jika surat terbit keliru, gunakan **Batalkan surat / koreksi penerbitan** dan isi alasan. Surat asli dan catatan positif dipertahankan; dibuat transaksi koreksi sebesar paling banyak bobot surat dan saldo tersisa. Pengurangan terdahulu tidak menciptakan kredit negatif. PDF terbaru berpenanda DIBATALKAN dan dapat dikirim sebagai salinan pembatalan. Untuk isi pengganti, buat surat baru.

## Pengiriman Telegram

- Hanya surat terbit / dibatalkan dapat dikirim. Staf harus aktif, terhubung Telegram, dan pernah Start bot.
- Penerima berasal dari data staf server, tidak dapat diketik atau diganti dari payload browser. Versi akun dan dokumen diperiksa kembali sebelum mengirim.
- Backend memeriksa `getChat` harus private dan ID harus sama dengan akun staf tertaut. PDF dikirim menggunakan `sendDocument` dengan perlindungan konten; tidak diumumkan ke grup.
- Saat kirim belum selesai, perubahan Telegram / status / home store staf ditahan. Ini mencegah akun ditukar di tengah pengiriman.
- Satu versi surat yang telah terkirim tidak dikirim ulang. Surat pembatalan merupakan versi berbeda dan memiliki status kirim tersendiri.
- Jika koneksi putus setelah upload, hasil dicatat **belum pasti**; sistem tidak mengirim ulang otomatis. Manager memeriksa chat, klik **Perbarui status kirim**, lalu verifikasi diterima / belum diterima disertai alasan. Untuk status `sending` yang tertahan, tunggu dua menit sebelum verifikasi manual.
- Verifikasi “belum diterima” mengizinkan percobaan kirim berikutnya. Verifikasi manusia tetap tercatat. Hindari mengonfirmasi tanpa memeriksa chat penerima.
- Riwayat mencatat draft, perubahan isi, penerbitan, poin, permintaan download, pengiriman, verifikasi, dan pembatalan. Log download berarti server melayani permintaan; tidak membuktikan file tersimpan di perangkat.

## Validasi

Tes otomatis memakai database PGlite terisolasi, bukan production. Mencakup region, izin RPC, ledger lama, saldo, revisi / idempotensi, penerima, draft / terbit / batal, dan kegagalan pengiriman. Pengujian jaringan memakai mock Telegram. Tes bot nyata dilakukan manual setelah migration dan deployment; kode tidak mengirim surat production sebagai bagian tes.
