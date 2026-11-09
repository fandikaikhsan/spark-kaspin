# Bukti inline, PDF payroll, dan absen diwakili

## Review

Bukti foto / PDF izin dibuka di dalam detail pengajuan, dengan otorisasi region dan tanpa tab baru. Review absensi tidak mewajibkan catatan lagi, termasuk koreksi waktu; catatan opsional maksimal 1000 karakter. Status, waktu sebelum/sesudah, dan aktor tetap diaudit. Edit pengajuan izin / kasbon tetap memerlukan alasan sesuai workflow sebelumnya.

## Finalisasi payroll

1. Buka Staff Management → staf → Keuangan → Proses payroll. Atur tarif yang berlaku untuk awal periode, absensi terkonfirmasi lengkap dengan checkout, serta izin, bonus, dan kasbon terkait.
2. Pilih tanggal awal/akhir **inklusif**, maksimal 62 hari. Tanggal default sekarang bulan lalu yang sudah selesai. Tanggal akhir harus lebih awal daripada tanggal lokal hari ini pada home store staf. Misalnya, periode berakhir 31 Oktober baru bisa difinalisasi mulai 1 November di timezone store.
3. Hitung preview. Selesaikan semua blocker (aturan belum ada/berubah di tengah periode, absensi belum direview, sesi terbuka, periode bertabrakan, data jam/upah tidak valid, atau periode masih berjalan).
4. Tekan Finalisasi payroll. Server menghitung dan memeriksa ulang versi data, menyimpan snapshot, mengalokasikan bonus, dan mencatat pengembalian kasbon sekali. Ini tidak mentransfer gaji ke bank.
5. Pratinjau PDF final muncul sesudah finalisasi. Slip juga tersedia pada riwayat/detail payroll di Keuangan. Preview hitungan yang belum final dapat diekspor sebagai PDF dengan label **DRAFT - BELUM FINAL**; hanya snapshot final yang bisa dikirim ke staf.

Pesan “periode belum berakhir; hasil ini masih preview” berarti tanggal akhir masih hari ini/masa depan menurut timezone home store, termasuk seluruh hari tersebut. Pilih tanggal akhir kemarin atau tunggu hari berikutnya; jangan mengubah timezone untuk melewati pemeriksaan ini.

## PDF dan penerima Telegram

Bot menggunakan `sendDocument` multipart upload. Pratinjau dan download PDF memerlukan login serta otorisasi region. PDF dibentuk dari snapshot final tersimpan, bukan nominal dari browser.

Tombol Kirim menampilkan nama/kode staf pemilik payroll. API tidak menerima `chat_id`, target staf lain, atau flag aktor dari browser. Database mengambil Telegram User.id dari staf pemilik payroll yang aktif dan sudah tertaut; versi tautan diperiksa ulang terhadap preview. Backend memeriksa `getChat` harus berupa chat pribadi dengan ID yang persis sama. Perubahan tautan akun/status/home store ditahan selama pengiriman aktif atau belum pasti. Respons `sendDocument` juga diperiksa ID chat-nya dan hasil kirim diaudit.

Staf perlu menekan Start pada bot melalui undangan pribadinya. Nama / username Telegram bukan kunci identitas. Dokumen tidak dikirim ke grup atau pelapor absensi. `protect_content` diaktifkan, namun ini bukan pengganti verifikasi identitas staf saat onboarding.

Pengiriman yang sudah sukses tidak diulang oleh klik berulang. Kegagalan eksplisit sebelum upload atau penolakan Telegram dapat dicoba lagi setelah preview dimuat ulang. Jika upload timeout atau receipt database gagal, status menjadi `uncertain` atau tetap `sending`; sistem tidak mengulang otomatis. Periksa chat penerima dan log/audit terlebih dahulu. Status tersebut juga menahan relink akun; administrator database harus merekonsiliasinya berdasarkan bukti kirim yang sebenarnya sebelum membuka pengiriman / perubahan akun lagi. Jangan mengubah status hanya untuk memaksa retry tanpa memeriksa penerima.

## Absen untuk rekan

Tetap hanya dalam grup store terdaftar:

```
/masuk KODE_STAF
/pulang KODE_STAF
```

Gunakan `/masuk@SparkStaffBot KODE_STAF` jika grup berisi beberapa bot. `/masuk` / `/pulang` tanpa argumen tetap untuk diri sendiri. Kode stabil ditampilkan bersama nama pada `/jadwal`. Jangan memakai nama bebas atau username Telegram yang dapat berubah / sama.

Pelapor harus staf aktif tertaut yang home store-nya store grup, atau memiliki penugasan di store tersebut dalam jendela sekitar hari itu. Pemilik absensi harus aktif, memiliki tepat satu shift yang sesuai untuk masuk atau sesi terbuka di store tersebut untuk pulang. Identitas pemilik dan pelapor tidak digabung: attempt dan sesi menyimpan keduanya.

Bot menampilkan siapa yang diwakili / mewakili. Hanya pelapor awal dapat mengonfirmasi serta membalas prompt lokasi dan foto. Bukti pelapor adalah bukti pendukung; bukan bukti bahwa ponsel pemilik berada di lokasi. Batas 10 menit dan timestamp command awal tetap berlaku. Riwayat / detail absensi menampilkan **Diwakili**; identitas pelapor masuk dan pulang bisa berbeda. Pemilik tertaut menerima notifikasi pribadi. Semua sesi tetap menunggu review manager dan tidak langsung masuk payroll terkonfirmasi.

Proses lain tidak boleh menimpa verifikasi aktif untuk staf yang sama. `/batal` di grup membatalkan proses verifikasi milik pengirim (termasuk yang mewakili staf lain), tanpa menghapus sesi yang selesai atau mengubah jadwal. Mewakili absen tidak memindahkan shift; fitur tukar / pengganti shift tetap berbeda.

## Rollout

Jika migration koreksi pengajuan sebelumnya belum diterapkan, jalankan dulu `20261109200000_staffing_request_amendment.sql` dan postflight-nya. Jangan mengulang migration yang sudah sukses.

1. Jalankan seluruh `supabase/migrations/20261109210000_staffing_payroll_documents_proxy.sql` di Supabase SQL Editor.
2. Jalankan `supabase/checks/staffing-payroll-documents-postflight.sql`; semua kolom harus `true`.
3. Deploy source dashboard yang mencakup perubahan ini. Endpoint `/api/telegram/staffing` dan env bot existing tetap dipakai.
4. Lambda POS existing tidak perlu di-update: pengiriman PDF berjalan melalui endpoint Next.js, sedangkan retry plain-text existing tetap kompatibel. Tidak membuat worker / scheduler baru.
5. Uji dengan dua akun nyata: absen perwakilan di grup, pastikan pemilik dan pelapor berbeda di dashboard; review tanpa catatan; buka bukti izin inline; hitung/finalisasi periode lampau; preview/download slip; kirim hanya ke akun staf pemilik payroll. Pengujian otomatis menggunakan fixture dan Telegram mock, tanpa pengiriman slip produksi.

Jika ingin menyegarkan deskripsi command, jalankan script setup bot existing sesudah deploy. Syntax command baru sudah dikenali tanpa setup ulang menu.
