import { listUsers, parseUserInput, updateUser } from "@/lib/users";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await updateUser(id, parseUserInput(await request.json(), false));
    return Response.json({ users: await listUsers() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update user" },
      { status: 400 },
    );
  }
}
