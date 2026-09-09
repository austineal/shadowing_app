import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

// Public web config for the "shadowing-practice-app" Firebase project.
// These values are not secrets; access is controlled by Auth + security rules.
const firebaseConfig = {
  projectId: "shadowing-practice-app",
  appId: "1:265798863216:web:8d03b603db55ffa5a8a7b5",
  storageBucket: "shadowing-practice-app.firebasestorage.app",
  apiKey: "AIzaSyBYmympqhnwbQ1yggrhXZgoXDz5NFwtU4g",
  authDomain: "shadowing-practice-app.firebaseapp.com",
  messagingSenderId: "265798863216",
};

export const FUNCTIONS_REGION = "europe-west2";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const storage = getStorage(app);
export const functions = getFunctions(app, FUNCTIONS_REGION);
