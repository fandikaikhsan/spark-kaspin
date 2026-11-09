# Koreksi pengajuan saat review

Pada detail pengajuan berstatus **Menunggu review**, admin / manager sesuai cakupan region dapat menekan **Edit pengajuan**.

- Izin/sakit/darurat: ubah tanggal mulai, tanggal selesai, serta tanggal/unit yang dihitung (0, ½, atau 1 hari). Total dihitung ulang dari rincian tersebut.
- Kasbon: ubah nominal rupiah. Plafon tidak berubah, dan nominal baru harus masuk ke sisa jatah setelah utang, kasbon yang disetujui, serta pengajuan pending lain diperhitungkan.
- Isi alasan perubahan lalu **Simpan perubahan**. Status tetap menunggu review; setelah rincian benar, pilih **Setujui**. Saldo izin dan utang tidak berubah hanya karena koreksi disimpan.
- Pengajuan awal dan bukti tetap tersimpan. Detail menunjukkan nilai awal dan catatan koreksi terakhir; audit menyimpan sebelum/sesudah setiap perubahan. Staf tertaut menerima pemberitahuan pribadi Telegram mengenai koreksi tersebut.

Edit ditolak jika pengajuan sudah diproses, data modal sudah berubah, saldo tidak cukup, tanggal bertabrakan, menyentuh payroll final, atau penugasan melibatkan store di luar cakupan manager. Pengajuan yang sudah disetujui mengikuti workflow pembatalan existing, bukan diubah diam-diam.

## Rollout tambahan

Database harus sudah menyelesaikan migration self-service `20261109180000_staffing_self_service.sql` sebelumnya. Jangan mengulang file migration yang telah sukses.

1. Jalankan seluruh isi `supabase/migrations/20261109200000_staffing_request_amendment.sql` pada Supabase SQL Editor.
2. Jalankan `supabase/checks/staffing-request-amendment-postflight.sql`; semua kolom harus `true`.
3. Deploy source branch `feat/staffing-request-review` melalui jalur Git/Vercel existing.

Tidak perlu Lambda, webhook, env, atau setup bot baru. Migration menambah metadata revisi dan RPC server-only; tidak mengubah pengajuan lama atau memotong saldo. Bila aplikasi perlu di-rollback, pertahankan data koreksi/audit dan metadata schema; jangan menghapus pengajuan untuk rollback UI.
