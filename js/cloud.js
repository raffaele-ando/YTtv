// ============================================================
// YTtv — login Google (Firebase Auth) + sync su Firestore
// ============================================================
//
// Se firebase-config.js non è compilato, tutte le funzioni restano inerti
// e l'app continua a funzionare in locale.

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import {
  state, userDataSnapshot, mergeRemoteData, setCloudPush, emit,
} from './store.js';
import { debounce } from './utils.js';

export const cloud = {
  available: isFirebaseConfigured(),
  user: null,            // { uid, name, email, photo }
  syncing: false,
  lastSync: 0,
  error: null,
};

let fb = null; // moduli firebase caricati dinamicamente
let db = null;
let auth = null;
let unsubSnapshot = null;
let suppressPush = false;

const userListeners = new Set();
export function onAuthChange(fn) { userListeners.add(fn); }
function notifyAuth() { userListeners.forEach((fn) => fn(cloud.user)); emit('auth'); }

async function loadFirebase() {
  if (fb) return fb;
  const [appMod, authMod, fsMod] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
  ]);
  fb = { ...appMod, ...authMod, ...fsMod };
  return fb;
}

export async function initCloud() {
  if (!cloud.available) return;
  try {
    await loadFirebase();
    const app = fb.initializeApp(firebaseConfig);
    auth = fb.getAuth(app);
    db = fb.getFirestore(app);
    setCloudPush(pushDebounced);

    fb.onAuthStateChanged(auth, async (user) => {
      if (user) {
        cloud.user = {
          uid: user.uid,
          name: user.displayName || 'Utente',
          email: user.email || '',
          photo: user.photoURL || '',
        };
        await startSync();
      } else {
        cloud.user = null;
        stopSync();
      }
      notifyAuth();
    });

    // completa un eventuale login via redirect (mobile)
    fb.getRedirectResult(auth).catch(() => {});
  } catch (e) {
    cloud.error = e.message;
  }
}

export async function signIn() {
  if (!cloud.available || !auth) throw new Error('Cloud non configurato');
  const provider = new fb.GoogleAuthProvider();
  try {
    await fb.signInWithPopup(auth, provider);
  } catch (e) {
    // i popup spesso sono bloccati su mobile → redirect
    if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) {
      if (e.code === 'auth/popup-blocked') await fb.signInWithRedirect(auth, provider);
    } else {
      throw e;
    }
  }
}

export async function signOutUser() {
  if (auth) await fb.signOut(auth);
}

// ---------- sincronizzazione ----------

function docRef() {
  return fb.doc(db, 'users', cloud.user.uid, 'yttv', 'data');
}

async function startSync() {
  if (!cloud.user || !db) return;
  cloud.syncing = true;
  emit('sync');
  try {
    const snap = await fb.getDoc(docRef());
    if (snap.exists()) {
      suppressPush = true;
      mergeRemoteData(snap.data());
      suppressPush = false;
    }
    // il merge locale può contenere cose che il cloud non ha → push
    await pushNow();

    // aggiornamenti live da altri dispositivi
    stopSnapshot();
    unsubSnapshot = fb.onSnapshot(docRef(), (s) => {
      if (!s.exists() || s.metadata.hasPendingWrites) return;
      const remote = s.data();
      if ((remote.meta?.updatedAt || 0) <= (state.meta.updatedAt || 0)) return;
      suppressPush = true;
      mergeRemoteData(remote);
      suppressPush = false;
    });
    cloud.lastSync = Date.now();
    cloud.error = null;
  } catch (e) {
    cloud.error = e.message;
  } finally {
    cloud.syncing = false;
    emit('sync');
  }
}

function stopSnapshot() {
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
}

function stopSync() {
  stopSnapshot();
}

async function pushNow() {
  if (!cloud.user || !db || suppressPush) return;
  try {
    await fb.setDoc(docRef(), userDataSnapshot(), { merge: false });
    cloud.lastSync = Date.now();
    cloud.error = null;
  } catch (e) {
    cloud.error = e.message;
  }
  emit('sync');
}

const pushDebounced = debounce(pushNow, 2500);
