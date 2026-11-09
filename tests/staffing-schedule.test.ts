import { describe, expect, it } from "vitest";
import { addDays, allocation, clippedMinutes, fillToTarget, fragments, mondayOf, moveShift, plannerDirty, shiftRange, validMonday, validPlacement, type PlanShift } from "@/lib/staffing/schedule";
import type { Staff } from "@/lib/staffing/model";
const week = "2026-11-09"; const zone = "Asia/Jakarta";
const staff: Staff[] = [{id:"alice",code:"A",full_name:"Alice",home_store_id:"store",active:true,telegram_linked:false},{id:"bob",code:"B",full_name:"Bob",home_store_id:"store",active:true,telegram_linked:false}];
function shift(id: string, start: number, end: number, staffId="alice"): PlanShift { return moveShift({id,staff_id:staffId,store_id:"store",label:"Shift",starts_at:"",ends_at:"",locked:false,editable:true,full_name:staffId,persisted:false},start,end,week,zone); }
function random() { let n=12345; return () => { n=(n*16807)%2147483647; return n/2147483647; }; }
const options={targetMinutes:2400,duration:480,startMinute:480,days:[0,1,2,3,4,5]};

describe("weekly timetable planning",()=>{
  it("uses Monday boundaries and store timezone instead of host timezone",()=>{
    expect(mondayOf("2026-11-15")).toBe(week);expect(addDays("2026-12-28",7)).toBe("2027-01-04");
    expect(validMonday(week)).toBe(true);expect(validMonday("2026-11-10")).toBe(false);expect(validMonday("2026-02-30")).toBe(false);
    expect(shift("a",0,480).starts_at).toBe("2026-11-08T17:00:00.000Z");
  });
  it("splits overnight cards and counts only hours inside the selected week",()=>{
    const night=shift("night",6*1440+1320,7*1440+360);
    const carry=shift("carry",-120,360);
    expect(clippedMinutes(night,week,zone)).toBe(120);expect(clippedMinutes(carry,week,zone)).toBe(360);
    const mid=shift("mid",1320,1800);const p=fragments([mid],week,zone);
    expect(p).toHaveLength(2);expect(p[0]).toMatchObject({day:0,start:1320,end:1440,continues:true});expect(p[1]).toMatchObject({day:1,start:0,end:360,continued:true});
    expect(allocation("alice",[mid],week,zone)).toEqual({minutes:480,days:[0,1]});
  });
  it("lays overlapping people in separate lanes without treating them as staff conflicts",()=>{
    const a=shift("a",480,960);const b=shift("b",600,1080,"bob");const c=shift("c",1080,1200);
    const rows=fragments([a,b,c],week,zone);expect(rows.find(s=>s.shift.id==="a")?.lanes).toBe(2);expect(rows.find(s=>s.shift.id==="b")?.lane).toBe(1);expect(rows.find(s=>s.shift.id==="c")?.lanes).toBe(1);
    expect(validPlacement(a,[b],[],week,zone)).toBeNull();
  });
  it("rejects same-person overlaps, including availability in another store",()=>{
    const existing=shift("a",480,960);expect(validPlacement(shift("b",900,1100),[existing],[],week,zone)).toMatch(/penugasan/);
    expect(validPlacement(shift("b",900,1100),[],[existing],week,zone)).toMatch(/penugasan/);
    expect(validPlacement(shift("b",960,1200),[existing],[],week,zone)).toBeNull();
    expect(validPlacement(shift("b",-30,60),[],[],week,zone)).not.toBeNull();
    expect(validPlacement(shift("b",0,1500),[],[],week,zone)).not.toBeNull();
  });
  it("fills each person's remaining weekly target and leaves the input draft untouched",()=>{
    const original=[shift("existing",480,960)];const copy=JSON.stringify(original);
    const result=fillToTarget(original,[],staff,"store",week,zone,options,random());
    expect(result).toHaveLength(10);expect(allocation("alice",result,week,zone).minutes).toBe(2400);expect(allocation("bob",result,week,zone).minutes).toBe(2400);
    expect(JSON.stringify(original)).toBe(copy);expect(result[0]).toBe(original[0]);
    for(const row of result)expect(validPlacement(row,result,[],week,zone)).toBeNull();
  });
  it("accounts for another store's assignments and uses a partial final shift",()=>{
    const other=shift("other",480,960);const result=fillToTarget([], [other], [staff[0]],"store",week,zone,{...options,targetMinutes:2490},random());
    expect(allocation("alice",[...result,other],week,zone).minutes).toBe(2490);expect(result).toHaveLength(5);
    expect(result.some(row=>{const[a,b]=shiftRange(row,week,zone);return b-a===90;})).toBe(true);
    expect(result.some(row=>allocation("alice",[row],week,zone).days.includes(0))).toBe(false);
  });
  it("can fill consecutive overnight shifts without mistaking their continuation for another start",()=>{
    const result=fillToTarget([],[],[staff[0]],"store",week,zone,{...options,startMinute:1320},random());
    expect(result).toHaveLength(5);expect(allocation("alice",result,week,zone).minutes).toBe(2400);
    for(const row of result)expect(validPlacement(row,result,[],week,zone)).toBeNull();
  });
  it("does not overwrite existing cards or claim to fill an impossible target",()=>{
    const result=fillToTarget([],[],[staff[0]],"store",week,zone,{...options,targetMinutes:3000,days:[0,1]},random());
    expect(allocation("alice",result,week,zone).minutes).toBe(960);expect(result).toHaveLength(2);
    expect(fillToTarget(result,[],[staff[0]],"store",week,zone,{...options,days:[]},random())).toBe(result);
  });
  it("treats a pure ordering change as clean and tracks moves/deletions as dirty",()=>{
    const a=shift("a",480,960),b=shift("b",1920,2400);expect(plannerDirty([b,a],[a,b])).toBe(false);
    expect(plannerDirty([a],[a,b])).toBe(true);expect(plannerDirty([moveShift(a,510,990,week,zone),b],[a,b])).toBe(true);
  });
});
