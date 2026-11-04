import { resetTestDatabase } from './db.ts';

// Every run starts from a clean database: drop, migrate from zero, seed default fixture.
export default async function setup(): Promise<void> {
  await resetTestDatabase();
}
