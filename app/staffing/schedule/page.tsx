import{ScheduleIndex}from"@/components/staffing/schedule-index";import{staffingDashboard}from"@/lib/staffing/service";
export const dynamic="force-dynamic";
export default async function Scheduling(){const data=await staffingDashboard();return <ScheduleIndex stores={data.stores.filter(s=>s.active&&s.region_id)}canConfigure={data.canConfigure}/>;}
