import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";

import { createDatabase } from "./connection.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const { client, db } = createDatabase();

try {
  await migrate(db, { migrationsFolder });
  console.log("データベースのマイグレーションが完了しました");
} finally {
  await client.end();
}
