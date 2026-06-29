// Prisma 7 moved CLI/Migrate configuration out of schema.prisma into this file.
// `prisma generate`, `prisma db push`, and `prisma migrate` read the datasource
// URL from here. Env vars are NOT auto-loaded, so we pull in dotenv explicitly
// (harmless in Docker, where DATABASE_URL comes from the container environment).
import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma generate` loads this config but never connects, so it must not throw
// when DATABASE_URL is unset (e.g. the Docker builder stage). The placeholder is
// only a parse-time fallback; `db push`/`migrate` use the real env-provided URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder:5432/placeholder",
  },
});
