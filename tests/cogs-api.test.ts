import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
const mocks=vi.hoisted(()=>({cookie:undefined as string|undefined,report:vi.fn(),save:vi.fn(),stores:vi.fn()}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>mocks.cookie?{value:mocks.cookie}:undefined})}));
vi.mock("@/lib/cogs/service",()=>({getCogsReport:mocks.report,saveCogsConfig:mocks.save}));
vi.mock("@/lib/stores",()=>({listStores:mocks.stores}));
import { GET, POST } from "@/app/api/cogs/route";
const secret=process.env.AUTH_SESSION_SECRET;
const storeId="00000000-0000-4000-8000-000000000001";
const request=()=>new Request(`http://localhost/api/cogs?store=${storeId}&start=2026-10-23&end=2026-10-24`);
const input={storeId,kind:"pos",mapping:{itemCode:"POS-BEEF",productId:"MEAL",outputQuantity:1,outputUom:"porsi"}};
const post=(body:unknown)=>new Request("http://localhost/api/cogs",{method:"POST",body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();mocks.cookie=undefined;process.env.AUTH_SESSION_SECRET="cogs-test-secret";mocks.report.mockResolvedValue({rows:[]});mocks.stores.mockResolvedValue([{id:storeId,timeZone:"Asia/Makassar"}]);});
afterEach(()=>{if(secret===undefined)delete process.env.AUTH_SESSION_SECRET;else process.env.AUTH_SESSION_SECRET=secret;});
describe("Consumption API",()=>{
  it.each([undefined,"staff","employee","viewer"])("denies reads and writes to %s",async(role)=>{
    if(role)mocks.cookie=await createSessionToken({userId:"staff",username:"staff",role:role as "admin"});
    expect((await GET(request())).status).toBe(401);expect((await POST(post(input))).status).toBe(401);
    expect(mocks.report).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();expect(mocks.stores).not.toHaveBeenCalled();
  });
  it.each(["admin","super_admin"] as const)("allows %s to read and explicitly link POS codes",async(role)=>{
    mocks.cookie=await createSessionToken({userId:"manager",username:"manager",role});
    const response=await GET(request());expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.report).toHaveBeenCalledWith({id:storeId,timeZone:"Asia/Makassar"},"2026-10-23","2026-10-24",undefined);
    expect((await POST(post(input))).status).toBe(200);expect(mocks.save).toHaveBeenCalledWith(input);
  });
  it("validates scope, dates, closing count IDs and unit amounts before writes",async()=>{
    mocks.cookie=await createSessionToken({userId:"manager",username:"manager",role:"admin"});
    for(const query of ["store=bad&start=2026-10-23&end=2026-10-24",`store=${storeId}&start=2026-10-24&end=2026-10-23`,`store=${storeId}&start=2026-01-01&end=2026-10-24`,`store=${storeId}&start=2026-10-23&end=2026-10-24&closing=bad`])expect((await GET(new Request(`http://localhost/api/cogs?${query}`))).status).toBe(400);
    expect((await POST(post({...input,mapping:{...input.mapping,outputQuantity:0}}))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.stores.mockResolvedValueOnce([]);expect((await GET(request())).status).toBe(404);
    mocks.save.mockRejectedValueOnce(new ItemError("Conflicting count line",409));expect((await POST(post(input))).status).toBe(409);
  });
});
