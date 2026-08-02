// serve-ingest.ts — run ONLY the Samsung Health ingest HTTP server, without the
// Discord client, so you can smoke-test the endpoints with curl. This uses the
// exact same request handler as production (src/http.ts); the only difference is
// that check-offs are logged to the console instead of posted to Discord.
//
//   INGEST_TOKEN=dev-secret DATA_DIR=./data PORT=3000 npm run serve:ingest
//
// Not used in production — index.ts starts the same server once Discord is ready.

import http from "node:http";
import { createIngestListener } from "./http";

const token = process.env.INGEST_TOKEN;
if (!token) {
  console.error(
    "Set INGEST_TOKEN first, e.g.\n  INGEST_TOKEN=dev-secret DATA_DIR=./data npm run serve:ingest",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? "3000");
const tz = process.env.TZ ?? "UTC";

const listener = createIngestListener({
  token,
  tz,
  onResults: (results) => {
    for (const r of results) {
      if (r.checkedOff) {
        console.log(`✅ ${r.name}: ${r.valueToday}/${r.goal} ${r.unit} — streak ${r.currentStreak}`);
      }
    }
  },
});

http.createServer(listener).listen(port, () => {
  console.log(`Ingest server listening on http://localhost:${port} (tz ${tz})`);
  console.log("Try:  curl -s localhost:" + port + "/healthz");
});
