import type { AttendanceUpdate } from "./telegram";
export type AttendanceDirectoryEntry = { user_id: number; username: string | null };
type Member = { status: string; is_member?: boolean; user: { id: number; username?: string; is_bot?: boolean } };
// Recheck aliases against current numeric Telegram membership. Unknown aliases in
// small stores can be discovered without making every colleague run /menu first.
export async function resolveAttendanceTargets(update: AttendanceUpdate, directory: AttendanceDirectoryEntry[], member: (id: number) => Promise<Member>): Promise<AttendanceUpdate> {
  if (!update.attendeeRefs) return update;
  const cache = new Map<number, Promise<Member | null>>();
  function lookup(id: number) {
    if (!cache.has(id)) cache.set(id, member(id).then(found => found.user.id === id && !found.user.is_bot && !["left", "kicked"].includes(found.status) && (found.status !== "restricted" || found.is_member) ? found : null).catch(() => null));
    return cache.get(id)!;
  }
  try {
    const resolved = await Promise.all(update.attendeeRefs.map(async ref => {
      if (ref.username && ref.username === update.senderUsername) return update.userId;
      const candidates = directory.filter(entry => ref.userId ? entry.user_id === ref.userId : entry.username?.toLowerCase() === ref.username);
      if (candidates.length === 1) {
        const found = await lookup(candidates[0].user_id);
        if (found && (!ref.username || found.user.username?.toLowerCase() === ref.username)) return found.user.id;
      }
      if (ref.username && directory.length <= 30) {
        const matches = (await Promise.all(directory.map(entry => lookup(entry.user_id)))).filter(found => found?.user.username?.toLowerCase() === ref.username);
        if (matches.length === 1) return matches[0]!.user.id;
      }
      throw new Error("Mention cannot be verified");
    }));
    return {...update,attendeeIds:[...new Set([...(update.includeSelf ? [update.userId] : []),...resolved])]};
  } catch { return {...update,attendanceError:true}; }
}
