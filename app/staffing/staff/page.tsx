import{StaffRoster}from"@/components/staffing/roster";import{operationsRpc}from"@/lib/staffing/operations-service";import{staffingDashboard}from"@/lib/staffing/service";import type{RosterStaff}from"@/lib/staffing/operations-model";
export const dynamic="force-dynamic";
export default async function StaffList(){const[staff,data]=await Promise.all([operationsRpc<RosterStaff[]>("staffing_roster"),staffingDashboard()]);return <StaffRoster staff={staff}stores={data.stores}canConfigure={data.canConfigure}/>;}
