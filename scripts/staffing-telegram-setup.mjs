// Explicit operator setup for the Staffing bot. Default target is the dashboard /api/telegram/staffing endpoint. Dry-run is the default.
const argv=process.argv.slice(2);
const apply=argv.includes('--apply');
const replace=argv.includes('--replace-webhook');
const urlIndex=argv.indexOf('--url');
const webhookUrl=urlIndex>=0?argv[urlIndex+1]:process.env.STAFFING_TELEGRAM_WEBHOOK_URL;
const username=process.env.STAFFING_TELEGRAM_BOT_USERNAME?.trim();
const token=process.env.STAFFING_TELEGRAM_BOT_TOKEN?.trim();
const secret=process.env.STAFFING_TELEGRAM_WEBHOOK_SECRET?.trim();
const group=[['masuk','Mulai check-in'],['pulang','Mulai checkout'],['jadwal','Jadwal committed store'],['tukar','Minta pengganti / tukar shift'],['batal','Batalkan proses aktif'],['bantuan','Panduan penggunaan']];
const personal=[['start','Tautkan akun / mulai'],['menu','Menu pribadi'],['jadwal','Jadwal saya'],['absensi','Riwayat absensi saya'],['saldo','Saldo pribadi'],['izin','Saldo dan riwayat izin'],['kasbon','Jatah dan riwayat kasbon'],['penghasilan','Payroll final, bonus dan SP'],['bantuan','Panduan penggunaan']];
function fail(message){console.error(message);process.exit(1);}
let parsed;try{parsed=new URL(webhookUrl);}catch{fail('Isi --url dengan HTTPS endpoint /api/telegram/staffing dari dashboard.');}
if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.search)fail('Webhook harus HTTPS tanpa kredensial, query atau fragment.');
if(!argv.includes('--standalone') && parsed.pathname!=='/api/telegram/staffing')fail('Gunakan endpoint dashboard /api/telegram/staffing tanpa trailing slash. --standalone hanya untuk deployment Lambda terpisah yang disengaja.');
if(!apply){console.log(JSON.stringify({mode:'dry-run',bot:username||'(belum dikonfigurasi)',webhook:parsed.href,operations:['verify getMe identity','verify existing webhook','set group/private command menus','setWebhook with secret token'],allowed_updates:['message','callback_query']},null,2));console.log('Tidak ada request Telegram yang dikirim. Tambahkan --apply setelah konfigurasi bot tes lengkap.');process.exit(0);}
if(!username||!/^[a-z0-9_]+bot$/i.test(username)||!token||!/^\d+:[A-Za-z0-9_-]+$/.test(token)||!secret||!/^[-_A-Za-z0-9]{32,256}$/.test(secret))fail('Periksa STAFFING_TELEGRAM_BOT_USERNAME, BOT_TOKEN dan WEBHOOK_SECRET (32–256 karakter).');
if(process.env.TELEGRAM_BOT_TOKEN && token.split(':')[0]===process.env.TELEGRAM_BOT_TOKEN.split(':')[0])fail('Token staffing sama dengan token POS. Gunakan bot staffing terpisah.');
async function telegram(method,payload={}){try{const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok||!data.ok)throw Error();return data.result;}catch{fail(`Telegram ${method} gagal. Token dan respons tidak ditampilkan.`);}}
if(secret===process.env.TELEGRAM_WEBHOOK_SECRET)fail('Webhook secret Staffing harus berbeda dari secret bot POS.');
const me=await telegram('getMe');
if(!me.is_bot||me.username?.toLowerCase()!==username.toLowerCase())fail('Identitas bot tidak cocok dengan username staffing. Tidak ada konfigurasi yang diubah.');
const info=await telegram('getWebhookInfo');
if(info.url&&info.url!==parsed.href&&!replace)fail('Bot memiliki webhook berbeda. Periksa tujuan terlebih dahulu; gunakan --replace-webhook hanya untuk bot Staffing yang benar.');
for(const [type,commands]of[['all_group_chats',group],['all_private_chats',personal]])await telegram('setMyCommands',{scope:{type},commands:commands.map(([command,description])=>({command,description}))});
await telegram('setWebhook',{url:parsed.href,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
console.log(`Menu dan webhook untuk @${username} sudah dikonfigurasi. Tidak ada pesan grup atau chat pribadi yang dikirim oleh script ini.`);
