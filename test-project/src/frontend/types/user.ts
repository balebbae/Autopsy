/** Auto-generated from the backend schema. Do not edit manually. */

export interface User {
  id: string;
  email: string;
}

export type UserCreateInput = Omit<User, "id">;
export type UserUpdateInput = Partial<Omit<User, "id">>;
