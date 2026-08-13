// ============================================================
// YTtv — login Google (Firebase Auth) + sync su Firestore
// ============================================================
//
// Se firebase-config.js non è compilato, tutte le funzioni restano inerti
// e l'app continua a funzionare in locale.

import { firebaseConfig, isFirebaseConfigured, firestoreDatabaseId } from './firebase-config.js';
import {
  state, userDataSnapshot, mergeRemoteData, setCloudPush, emit,
} from './store.js';
import { debounce } from './utils.js';

export const cloud = {
  available: isFirebaseConfigured(),
  user: null,            // { uid, name, email, photo }
  syncing: false,
  lastSync: 0,
  error: null,           // messaggio tecnico
  errorHint: null,       // spiegazione + cosa fare, in italiano
  needsSetup: false,     // true se il database Firestore non esiste / regole bloccano
};

// Traduce gli errori Firestore in messaggi comprensibili con la soluzione.
function describeError(e) {
  const code = e?.code || '';
  const msg = (e?.message || String(e)).toLowerCase();
  if (code.includes('permission-denied') || msg.includes('permission') || msg.includes('insufficient')) {
    return {
      hint: 'Le regole di sicurezza di Firestore bloccano il salvataggio. Apri la console Firebase → Firestore Database → scheda "Regole" e incolla le regole indicate nel README, poi Pubblica.',
      setup: true,
    };
  }
  if (code.includes('unavailable') || msg.includes('unavailable') || msg.includes('transport') || msg.includes('network') || msg.includes('failed to get') || msg.includes('backend')) {
    return {
      hint: 'Impossibile raggiungere Cloud Firestore: la connessione al database non si apre (capita su Safari/iPad o su reti che bloccano lo streaming). Controlla la rete e riprova; se persiste, ricarica la pagina.',
      setup: false,
    };
  }
  if (msg.includes('does not exist') || msg.includes('not-found') || code.includes('not-found') || msg.includes('no document')) {
    return {
      hint: 'Il database Cloud Firestore non risulta creato. Attenzione: NON è il "Realtime Database" (prodotto diverso). Vai su console.firebase.google.com → il tuo progetto → menu "Cloud Firestore" (o "Firestore Database") → "Crea database" → modalità Nativa/Produzione → scegli una regione. Deve chiamarsi "(default)". Poi ricarica il sito.',
      setup: true,
    };
  }
  return { hint: `Sincronizzazione non riuscita: ${e?.message || e}. Riprovo automaticamente.`, setup: false };
}

// Firestore rifiuta i valori undefined: puliamo lo snapshot in modo difensivo.
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

let fb = null; // moduli firebase caricati dinamicamente
let db = null;
let auth = null;
let unsubSnapshot = null;
let suppressPush = false;
let lastRemoteStamp = 0; // updatedAt dell'ultimo documento remoto già elaborato

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
    // Su Safari/iPad (e su reti che bloccano i WebChannel) il trasporto
    // predefinito di Firestore spesso non riesce ad aprire la connessione:
    // letture e scritture restano appese e niente arriva sul cloud, mentre il
    // login via HTTPS continua a funzionare. Forzare il long-polling rende la
    // sincronizzazione affidabile su tutti i dispositivi.
    const fsSettings = { experimentalForceLongPolling: true };
    db = (firestoreDatabaseId && firestoreDatabaseId !== '(default)')
      ? fb.initializeFirestore(app, fsSettings, firestoreDatabaseId)
      : fb.initializeFirestore(app, fsSettings);
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
    handleError(e);
  }
}

// Codici per cui il popup non è utilizzabile: si passa al redirect (tipico di
// Safari su iPhone/iPad e dei browser in-app).
const REDIRECT_CODES = [
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/web-storage-unsupported',
  'auth/internal-error',
];
// Codici che significano "l'utente ha annullato": nessun errore da mostrare.
const CANCEL_CODES = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'];

export async function signIn() {
  if (!cloud.available || !auth) throw new Error('Cloud non configurato');
  const provider = new fb.GoogleAuthProvider();
  try {
    await fb.signInWithPopup(auth, provider);
  } catch (e) {
    if (REDIRECT_CODES.includes(e.code)) { await fb.signInWithRedirect(auth, provider); return; }
    if (CANCEL_CODES.includes(e.code)) return;
    throw e;
  }
}

export async function signOutUser() {
  if (auth) await fb.signOut(auth);
}

// ---------- sincronizzazione ----------

function docRef() {
  return fb.doc(db, 'users', cloud.user.uid, 'yttv', 'data');
}

// Fonde un documento remoto e, se ha cambiato qualcosa qui, riallinea il cloud
// (così anche le cancellazioni arrivate da un altro dispositivo restano scritte).
function handleRemote(remote) {
  const stamp = remote?.meta?.updatedAt || 0;
  suppressPush = true;
  const changed = mergeRemoteData(remote);
  suppressPush = false;
  lastRemoteStamp = Math.max(lastRemoteStamp, stamp);
  if (changed) pushDebounced();
  return changed;
}

async function startSync() {
  if (!cloud.user || !db) return;
  cloud.syncing = true;
  cloud.error = null; cloud.errorHint = null; cloud.needsSetup = false;
  emit('sync');
  try {
    const snap = await fb.getDoc(docRef());
    if (snap.exists()) handleRemote(snap.data());
    // Il documento locale è ora la fusione di tutto: lo riscriviamo per intero.
    // Con { merge: true } le cancellazioni non arrivavano mai nel cloud (un
    // canale rimosso, o un video segnato "da vedere", tornavano al sync dopo).
    await fb.setDoc(docRef(), stripUndefined(userDataSnapshot()));
    lastRemoteStamp = Math.max(lastRemoteStamp, state.meta.updatedAt || 0);

    // aggiornamenti live da altri dispositivi
    stopSnapshot();
    unsubSnapshot = fb.onSnapshot(docRef(), (s) => {
      if (!s.exists() || s.metadata.hasPendingWrites) return;
      const remote = s.data();
      const stamp = remote.meta?.updatedAt || 0;
      // Prima si confrontava lo stamp remoto con quello locale: se questo
      // dispositivo era stato usato più di recente (o aveva l'orologio avanti),
      // gli aggiornamenti degli altri venivano scartati per sempre.
      if (stamp && stamp === lastRemoteStamp) return;
      handleRemote(remote);
    }, (err) => { handleError(err); });

    cloud.lastSync = Date.now();
    cloud.error = null; cloud.errorHint = null; cloud.needsSetup = false;
  } catch (e) {
    handleError(e);
  } finally {
    cloud.syncing = false;
    emit('sync');
  }
}

function handleError(e) {
  const d = describeError(e);
  cloud.error = e?.message || String(e);
  cloud.errorHint = d.hint;
  cloud.needsSetup = d.setup;
  emit('sync-error');
  emit('sync');
}

// Nuovo tentativo manuale (bottone nelle Impostazioni / Profilo).
export async function syncNow() {
  if (!cloud.user) throw new Error('Accedi prima con Google');
  await startSync();
  return !cloud.error;
}

function stopSnapshot() {
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
}

function stopSync() {
  stopSnapshot();
  lastRemoteStamp = 0;
}

async function pushNow() {
  if (!cloud.user || !db || suppressPush) return;
  try {
    await fb.setDoc(docRef(), stripUndefined(userDataSnapshot()));
    lastRemoteStamp = Math.max(lastRemoteStamp, state.meta.updatedAt || 0);
    cloud.lastSync = Date.now();
    cloud.error = null; cloud.errorHint = null; cloud.needsSetup = false;
  } catch (e) {
    handleError(e);
  }
  emit('sync');
}

const pushDebounced = debounce(pushNow, 2500);

// Scrittura immediata: serve quando la pagina sta per chiudersi, altrimenti
// l'ultima azione (in attesa nel debounce di 2,5s) non arrivava nel cloud.
export function flushCloud() {
  if (!cloud.user || !db) return;
  pushNow();
}
