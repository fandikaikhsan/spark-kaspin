import { createUser, listUsers, parseUserInput } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ users: await listUsers() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load users" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await createUser(parseUserInput(await request.json(), true));
    return Response.json({ users: await listUsers() }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create user" },
      { status: 400 },
    );
  }
}
