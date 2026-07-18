// ============================================================
// YTtv — configurazione Firebase (login Google + sync cloud)
// ============================================================
//
// Per attivare il login con Google e la sincronizzazione multi-dispositivo:
//
//  1. Vai su https://console.firebase.google.com e crea un progetto (gratis).
//  2. Aggiungi una "App Web" (icona </>) e copia qui sotto l'oggetto
//     firebaseConfig che ti viene mostrato.
//  3. In "Authentication" → "Sign-in method" abilita "Google".
//  4. In "Authentication" → "Settings" → "Authorized domains" aggiungi il
//     dominio dove pubblichi il sito (es. tuonome.github.io).
//  5. In "Firestore Database" crea un database e usa queste regole:
//
//     rules_version = '2';
//     service cloud.firestore {
//       match /databases/{database}/documents {
//         match /users/{uid}/{document=**} {
//           allow read, write: if request.auth != null && request.auth.uid == uid;
//         }
//       }
//     }
//
// Finché questo oggetto resta vuoto, il sito funziona comunque:
// tutto viene salvato in locale sul dispositivo.

export const firebaseConfig = {
  apiKey: "AIzaSyDQ5fyY_nHSzi5jruHGzgEjacK54snyOy4",
  authDomain: "gen-lang-client-0578386900.firebaseapp.com",
  projectId: "gen-lang-client-0578386900",
  storageBucket: "gen-lang-client-0578386900.firebasestorage.app",
  messagingSenderId: "646615244971",
  appId: "1:646615244971:web:7d9ea1288772867e3ed7ee"
};

export const isFirebaseConfigured = () =>
  Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
