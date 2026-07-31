// audible-setup.ts — one-time Audible login. Run locally to generate credentials:
//   npm run setup:audible
//
// It opens the Audible PKCE login flow, you sign in via the browser and paste back the
// redirect URL, and it saves credentials + prints a listening-time sanity check.

import readline from "readline";
import type { AudibleLocale } from "audible-api-ts";
import { saveCredentials, totalListenedMinutes } from "./audible";

type AudibleApi = typeof import("audible-api-ts");
const importAudibleApi = new Function('return import("audible-api-ts")') as () => Promise<AudibleApi>;

const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
};

const main = async (): Promise<void> => {
  const api = await importAudibleApi();
  const locale = (process.env.AUDIBLE_LOCALE || "com") as AudibleLocale;

  console.log(`\nStarting Audible login (locale: ${locale})...\n`);
  const { loginUrl, session, cookies } = await api.login(locale);

  console.log("1. Open this URL in your browser (a private/incognito window is safest) and sign in:\n");
  console.log("   " + loginUrl + "\n");
  console.log("   If sign-in is rejected, set these cookies for the Amazon domain first:");
  for (const c of cookies) console.log(`     ${c.name}=${c.value}  (domain ${c.domain})`);
  console.log(
    "\n2. After signing in you'll land on a page that may fail to load — its URL contains\n" +
      "   'openid.oa2.authorization_code'. Copy that FULL URL from the address bar.\n",
  );

  const redirect = await ask("Paste the full redirect URL here: ");
  let code: string | null = null;
  try {
    code = new URL(redirect).searchParams.get("openid.oa2.authorization_code");
  } catch {
    /* not a URL */
  }
  if (!code) {
    console.error("\n✗ Couldn't find 'openid.oa2.authorization_code' in that URL. Aborting.");
    process.exit(1);
  }

  console.log("\nRegistering device...");
  const creds = await api.register(code, session);
  saveCredentials(creds);
  console.log("✓ Credentials saved.");

  console.log("\nVerifying by fetching your library...");
  const { items } = await api.library(creds);
  const total = Math.round(totalListenedMinutes(items));
  const inProgress = items.filter(
    (i) => (i.listeningStatus?.percentComplete ?? 0) > 0 && !i.listeningStatus?.isFinished,
  );

  console.log(`\n✓ ${items.length} books in library. Derived total listened: ${total} min.`);
  if (inProgress.length) {
    console.log("In-progress:");
    for (const b of inProgress.slice(0, 10)) {
      console.log(`  • ${b.title} — ${b.listeningStatus?.percentComplete ?? 0}% of ${b.durationMinutes}m`);
    }
  }
  console.log(
    "\nDone. For Railway: copy the saved credentials JSON into the AUDIBLE_CREDENTIALS variable\n" +
      "(the bot writes it to the volume on first boot and auto-refreshes it from then on).\n",
  );
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
