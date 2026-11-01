// Deliberately exact: public form access must never open a whole route prefix.
export function isEmployeeFormRequest(pathname: string, method: string): boolean {
  if ((method === "GET" || method === "HEAD") && ["/staff/stock-opname", "/staff/receiving"].includes(pathname)) return true;
  return method === "POST" && ["/api/staff/stock-opname", "/api/staff/receiving"].includes(pathname);
}
