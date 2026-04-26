export interface SerializedUser {
  id: string;
  email: string;
}

export function serializeUser(raw: Record<string, unknown>): SerializedUser {
  return {
    id: String(raw.id),
    email: String(raw.email),
  };
}

export const SERIALIZED_FIELDS: (keyof SerializedUser)[] = ["id", "email"];
