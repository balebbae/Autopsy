/** Minimal DB abstraction for the test project. */
export const db = {
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    // In production this would use pg or prisma
    console.log(`[DB] ${sql}`, params);
    return {};
  },
};
