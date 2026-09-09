import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { allowedEmails } from "./config.js";

/** Throws unless the caller is a signed-in, verified, allow-listed user. Returns uid. */
export function assertAllowed(req: CallableRequest<unknown>): string {
  const auth = req.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const email = (auth.token.email ?? "").toLowerCase();
  const verified = auth.token.email_verified === true;
  const allowed = allowedEmails
    .value()
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!verified || !allowed.includes(email)) {
    throw new HttpsError("permission-denied", "This account is not allowed to use this app.");
  }
  return auth.uid;
}
