import { createHash } from "node:crypto";

export type AttendanceUpdate = {
  updateId: number;
  kind: "start" | "check_in" | "check_out" | "cancel" | "confirm" | "report" | "location" | "photo" | "schedule" |
    "menu" | "balance" | "history" | "income" | "leave_status" | "cash_status" | "help" |
    "swap_start" | "swap_pick" | "swap_accept" | "swap_reject" | "swap_cancel" |
    "request_start" | "request_pick" | "request_input" | "document" | "proxy_check_in" | "proxy_check_out" | "batch_confirm" | "batch_cancel";
  userId: number; chatId: number; chatType: string; messageId: number | null; replyTo: number | null;
  sentAt: string | null; timestampSource: "telegram_message" | "server_received";
  attendanceVersion?: 2; senderUsername?: string | null;
  attendeeRefs?: { userId?: number; username?: string }[]; includeSelf?: boolean; attendeeIds?: number[]; attendanceError?: boolean; batchId?: string;
  attendeeCode?: string;
  attemptId?: string; tokenHash?: string; latitude?: number; longitude?: number; fileId?: string; fileUniqueId?: string;
  inputText?: string; fileMime?: string; fileSize?: number;
  flowToken?: string; choice?: string; entityId?: string; requestId?: string; scheduleDate?: string;
};
type Message = {
  message_id: number; date: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean; username?: string };
  sender_chat?: unknown; forward_origin?: unknown; is_automatic_forward?: boolean;
  entities?: { type: string; offset: number; length: number; user?: { id: number; is_bot?: boolean } }[];
  text?: string; reply_to_message?: { message_id: number };
  location?: { latitude: number; longitude: number };
  document?: { file_id: string; file_unique_id: string; mime_type?: string; file_size?: number };
  photo?: { file_id: string; file_unique_id: string; width: number; height: number }[];
};
export type TelegramUpdate = { update_id: number; message?: Message; callback_query?: { id: string; from: { id: number; is_bot?: boolean; username?: string }; message?: Message; data?: string } };
export function invitationHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const menuKinds = { menu: "menu", balance: "balance", history: "history", income: "income", leave: "leave_status", cash: "cash_status", schedule: "schedule", help: "help" } as const;

// This is a deterministic allow-list. No natural-language instruction, forwarded
// message, claimed role, actor ID or financial field is forwarded to a write RPC.
export function normalizeUpdate(update: unknown, botUsername: string): AttendanceUpdate | null {
  if (!object(update) || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return null;
  const callback = object(update.callback_query) ? update.callback_query : null;
  const message = callback?.message || update.message;
  if (!object(message) || !object(message.chat)) return null;
  const sender = callback?.from || message.from;
  if (!object(sender) || !positive(sender.id) || sender.is_bot || message.sender_chat || message.forward_origin || message.is_automatic_forward) return null;
  const chat = message.chat;
  if (typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) || !["private", "group", "supergroup"].includes(String(chat.type)) ||
    (chat.type === "private" ? chat.id !== sender.id : chat.id >= 0) || !positive(message.message_id)) return null;
  if (!callback && (!positive(message.date) || !Number.isFinite(new Date(message.date * 1000).getTime()))) return null;
  const base: AttendanceUpdate = {
    updateId: update.update_id, kind: "cancel", attendanceVersion: 2, senderUsername: typeof sender.username === "string" && /^[A-Za-z0-9_]{1,32}$/.test(sender.username) ? sender.username.toLowerCase() : null, userId: sender.id, chatId: chat.id, chatType: String(chat.type), messageId: message.message_id,
    replyTo: object(message.reply_to_message) && positive(message.reply_to_message.message_id) ? message.reply_to_message.message_id : null,
    sentAt: callback ? null : new Date((message.date as number) * 1000).toISOString(), timestampSource: callback ? "server_received" : "telegram_message",
  };
  if (callback) {
    if (typeof callback.data !== "string" || callback.data.length > 64 || typeof callback.id !== "string") return null;
    const parts = callback.data.split(":");
    if (parts[0] === "ba" && parts.length === 3 && ["c", "x"].includes(parts[1]) && uuid.test(parts[2]) && chat.type !== "private") return { ...base, kind: parts[1] === "c" ? "batch_confirm" : "batch_cancel", batchId: parts[2] };
    if (parts[0] === "sf" && parts.length === 3 && ["c", "x", "r"].includes(parts[1]) && uuid.test(parts[2])) {
      const kind = ({ c: "confirm", x: "cancel", r: "report" } as const)[parts[1] as "c" | "x" | "r"];
      return kind ? { ...base, kind, attemptId: parts[2] } : null;
    }
    if (parts[0] === "rq" && parts.length === 2 && ["leave", "cash", "overtime"].includes(parts[1])) return { ...base, kind: "request_start", choice: parts[1] };
    if (parts[0] === "rf" && parts.length === 4 && /^[a-f0-9]{12}$/.test(parts[2]) &&
      ((parts[1] === "type" && ["paid_leave", "unpaid_leave", "sick"].includes(parts[3])) ||
       (["send", "cancel"].includes(parts[1]) && parts[3] === "yes") || (parts[1] === "session" && uuid.test(parts[3])))) return { ...base, kind: "request_pick", choice: parts[1], flowToken: parts[2], entityId: parts[3] };
    if (parts[0] === "sg" && parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
      const date = new Date(parts[1] + "T00:00:00Z");
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === parts[1] ? { ...base, kind: "schedule", scheduleDate: parts[1] } : null;
    }
    if (parts[0] === "sm" && parts.length === 2 && Object.hasOwn(menuKinds, parts[1])) return { ...base, kind: menuKinds[parts[1] as keyof typeof menuKinds] };
    if (parts[0] === "sx" && parts.length === 4 && /^[a-f0-9]{12}$/.test(parts[2])) {
      const [ , choice, flowToken, entityId] = parts;
      if (!["mode", "shift", "person", "other", "page", "cancel"].includes(choice)) return null;
      if (choice === "cancel" ? entityId !== "yes" : choice === "mode" ? !["replace", "swap"].includes(entityId) : choice === "page" ? !["next", "prev"].includes(entityId) : !uuid.test(entityId)) return null;
      return { ...base, kind: "swap_pick", choice, flowToken, entityId };
    }
    if (parts[0] === "sr" && parts.length === 3 && ["y", "n", "x"].includes(parts[1]) && uuid.test(parts[2])) {
      const kind = ({ y: "swap_accept", n: "swap_reject", x: "swap_cancel" } as const)[parts[1] as "y" | "n" | "x"];
      return kind ? { ...base, kind, requestId: parts[2] } : null;
    }
    return null;
  }
  if (typeof message.text === "string") {
    const text = message.text;
    if (chat.type === "private" && !text.trim().startsWith("/") && text.trim().length <= 2000) {
      return { ...base, kind: "request_input", inputText: text.trim() };
    }
    const parts = text.trim().split(/\s+/);
    const [name, target, extra] = parts[0].split("@");
    if (extra || (target && target.toLowerCase() !== botUsername.toLowerCase())) return null;
    const commands: Record<string, AttendanceUpdate["kind"]> = { "/start": "start", "/masuk": "check_in", "/pulang": "check_out", "/batal": "cancel", "/jadwal": "schedule", "/menu": "menu", "/saldo": "balance", "/absensi": "history", "/absen": "history", "/penghasilan": "income", "/izin": "leave_status", "/kasbon": "cash_status", "/tukar": "swap_start", "/bantuan": "help" };
    if (name === "/lembur" && parts.length === 1 && chat.type === "private") return { ...base, kind: "request_start", choice: "overtime" };
    const kind = commands[name];
    if ((kind === "check_in" || kind === "check_out") && parts.length > 1) {
      if (!["group", "supergroup"].includes(String(chat.type))) return null;
      const refs: { userId?: number; username?: string }[] = [];
      let includeSelf = false;
      const entities = Array.isArray(message.entities) ? message.entities.filter(object) : [];
      let cursor = text.indexOf(parts[0]) + parts[0].length;
      while (cursor < text.length) {
        const separator = /^[\s,]+/.exec(text.slice(cursor)); if (separator) cursor += separator[0].length;
        if (cursor >= text.length) break;
        const entity = entities.find(e => e.type === "text_mention" && e.offset === cursor && Number.isSafeInteger(e.length) && Number(e.length) > 0 && cursor + Number(e.length) <= text!.length);
        if (entity) {
          if (!object(entity.user) || !positive(entity.user.id) || entity.user.is_bot) return null;
          refs.push({userId:entity.user.id}); cursor += Number(entity.length);
          if (cursor < text.length && !/[\s,]/.test(text[cursor])) return null;
        } else {
          const token = /^(saya|@[A-Za-z0-9_]{1,32}|[A-Za-z0-9._-]{1,40})(?=$|[\s,])/i.exec(text.slice(cursor));
          if (!token) return null;
          if (token[0].toLowerCase() === "saya") includeSelf = true;
          else if (token[0].startsWith("@")) refs.push({username:token[0].slice(1).toLowerCase()});
          else return parts.length === 2 ? { ...base, kind: kind === "check_in" ? "proxy_check_in" : "proxy_check_out", attendeeCode:token[0] } : null;
          cursor += token[0].length;
        }
        if (refs.length + Number(includeSelf) > 10) return null;
      }
      return refs.length || includeSelf ? { ...base, kind, attendeeRefs:refs, includeSelf } : null;
    }
    if (parts.length > 2) return null;
    if (!kind || (parts.length === 2 && (kind !== "start" || !/^[a-f0-9]{48}$/.test(parts[1])))) return null;
    return { ...base, kind, ...(kind === "start" && parts[1] ? { tokenHash: invitationHash(parts[1]) } : {}) };
  }
  if (object(message.location)) {
    const { latitude, longitude } = message.location;
    if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { ...base, kind: "location", latitude, longitude };
  }
  if (chat.type === "private" && object(message.document)) {
    const d = message.document;
    if (typeof d.file_id !== "string" || !d.file_id.length || d.file_id.length > 1024 || typeof d.file_unique_id !== "string" || !d.file_unique_id.length || d.file_unique_id.length > 256 || !["application/pdf", "image/jpeg", "image/png"].includes(String(d.mime_type)) || !positive(d.file_size) || d.file_size > 10 * 1024 * 1024) return null;
    return { ...base, kind: "document", fileId: d.file_id, fileUniqueId: d.file_unique_id, fileMime: String(d.mime_type), fileSize: d.file_size };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const photos = message.photo.filter(p => object(p) && typeof p.file_id === "string" && p.file_id.length > 0 && p.file_id.length <= 1024 && typeof p.file_unique_id === "string" && p.file_unique_id.length > 0 && p.file_unique_id.length <= 256 && positive(p.width) && positive(p.height)) as NonNullable<Message["photo"]>;
    const photo = photos.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return photo ? { ...base, kind: "photo", fileId: photo.file_id, fileUniqueId: photo.file_unique_id } : null;
  }
  return null;
}
export function verifyWebhookSecret(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0; for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
