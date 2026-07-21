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
  apiKey: "AIzaSyARBqO5igl6JggqrQ5-jquTaWPgoLqWAFc",
  authDomain: "yttv-a545f.firebaseapp.com",
  projectId: "yttv-a545f",
  storageBucket: "yttv-a545f.firebasestorage.app",
  messagingSenderId: "1007834493117",
  appId: "1:1007834493117:web:483b9b08716b4974c307d4",
  measurementId: "G-NHELX8C9WS"
};

// ID del database Firestore. Lascia "(default)" a meno che, creando il
// database su Firebase, tu non gli abbia dato un nome diverso: in quel caso
// scrivi qui esattamente quel nome (lo trovi in Firestore Database, in alto,
// nel menu a tendina dei database).
export const firestoreDatabaseId = "(default)";

export const isFirebaseConfigured = () =>
  Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
