import { db } from "../db";

interface UserProfile {
  id: string;
  email: string;
}

export async function getProfile(userId: string): Promise<UserProfile> {
  const row = await db.query("SELECT id, email FROM users WHERE id = $1", [
    userId,
  ]);
  return row as UserProfile;
}

export async function updateProfile(
  userId: string,
  data: Partial<UserProfile>,
): Promise<UserProfile> {
  const fields = Object.entries(data)
    .map(([k, _v], i) => `${k} = $${i + 2}`)
    .join(", ");
  const values = Object.values(data);
  await db.query(`UPDATE users SET ${fields} WHERE id = $1`, [
    userId,
    ...values,
  ]);
  return getProfile(userId);
}
