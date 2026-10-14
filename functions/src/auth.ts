import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { db } from "./admin.js";

/** Throws unless the caller is a signed-in, verified user listed in Firestore config/access. Returns uid. */
export async function assertAllowed(req: CallableRequest<unknown>): Promise<string> {
  const auth = req.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const email = (auth.token.email ?? "").toLowerCase();
  const verified = auth.token.email_verified === true;
  const allowed: string[] = (await db.doc("config/access").get()).get("emails") ?? [];
  if (!verified || !allowed.includes(email)) {
    throw new HttpsError("permission-denied", "This account is not allowed to use this app.");
  }
  return auth.uid;
}
