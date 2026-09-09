import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "../firebase";

/** undefined = still resolving, null = signed out. */
export function useAuth(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

export async function signIn(): Promise<void> {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code.includes("popup")) {
      await signInWithRedirect(auth, googleProvider);
      return;
    }
    throw e;
  }
}

export function signOut(): Promise<void> {
  return fbSignOut(auth);
}
