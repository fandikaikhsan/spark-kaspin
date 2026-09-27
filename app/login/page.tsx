import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const parameters = await searchParams;
  return <LoginForm nextPath={parameters.next || "/"} />;
}
