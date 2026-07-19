# YTtv — La tua TV di YouTube 📺

Un sito ultra-moderno in stile **Netflix / Apple TV** per seguire i tuoi canali YouTube preferiti:
aggiungi i canali, YTtv controlla quando pubblicano **video e shorts**, ti mostra cosa devi ancora
vedere e riproduce tutto **dentro il sito**, senza mai aprire YouTube.

## ✨ Funzionalità

- **Home in stile TV** — billboard cinematografico con l'ultimo video da vedere, righe "Continua a guardare", "Da vedere", "Shorts", "Guarda dopo" e una riga per ogni canale.
- **Player integrato** — i video si aprono in una scheda cinematografica dentro il sito, con ripresa da dove eri rimasto, "segna come visto", "guarda dopo" e riproduzione continua.
- **Shorts trattati da shorts** — copertine verticali reali (9:16), player verticale immersivo a schermo intero con swipe/frecce/rotellina, contatore e azioni rapide. Esperienza separata dai video normali.
- **Doppia sorgente dati, sempre funzionante** — YouTube **Data API v3** come sorgente primaria; se la quota finisce o la chiave non funziona, passa da solo ai **feed RSS ufficiali** di YouTube.
- **Ricerca globale** — cerca nei tuoi canali e video, e su tutta YouTube per **nome**, **@tag** o **link**; aggiungi un canale con un click.
- **Filtri per canale** — di un canale che pubblica più rubriche/podcast puoi tenere solo ciò che ti interessa: regole "mostra solo…" o "nascondi…" per **parole nel titolo e/o nella descrizione** e per **appartenenza alle playlist/podcast del canale** (selezionabili da un elenco), più l'opzione "niente shorts". Tutto applicato **automaticamente anche ai video futuri**, con anteprima in tempo reale, scheda "Nascosti dal filtro" e sincronizzazione nel cloud.
- **Cronologia e tracciamento di tutto** — visti, avanzamento di riproduzione, guarda dopo, statistiche (ore guardate, video/shorts visti).
- **Login Google + sync cloud** — con Firebase (gratuito): stesso stato su telefono, tablet e computer, aggiornato in tempo reale.
- **Mobile-first** — tab bar in basso, layout adattivo, installabile come app (PWA manifest).

## 🚀 Messa online (GitHub Pages)

1. Vai in **Settings → Pages** del repository.
2. In "Build and deployment" scegli **Deploy from a branch** e seleziona il branch principale (cartella `/root`).
3. Il sito sarà su `https://<tuo-utente>.github.io/YTtv/`.

> Il sito è 100% statico: funziona anche su Netlify, Vercel, Cloudflare Pages o qualsiasi hosting.

## 🔑 Chiave API YouTube

La chiave è integrata in `js/config.js` e modificabile dalle **Impostazioni** del sito.

**Importante:** trattandosi di un sito statico, la chiave è visibile nel codice. Proteggila su
[Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Apri la chiave → **Application restrictions** → *Websites*.
2. Aggiungi il dominio del sito (es. `https://tuoutente.github.io/*`).
3. In **API restrictions** limita alla sola *YouTube Data API v3*.

Se l'API non risponde (quota esaurita ecc.), YTtv continua a funzionare con i feed RSS.

## ☁️ Login Google e sincronizzazione multi-dispositivo (5 minuti)

Serve un progetto **Firebase** gratuito (è il modo standard per avere login Google + database cloud da un sito statico):

1. Vai su [console.firebase.google.com](https://console.firebase.google.com) → **Aggiungi progetto** (nome libero, Analytics non serve).
2. Nella pagina del progetto clicca l'icona **Web `</>`** → registra l'app → copia l'oggetto `firebaseConfig`.
3. Incollalo in **`js/firebase-config.js`** (sostituendo i campi vuoti).
4. **Authentication → Get started → Sign-in method** → abilita **Google**.
5. **Authentication → Settings → Authorized domains** → aggiungi il dominio del sito (es. `tuoutente.github.io`).
6. **Firestore Database → Create database** (production mode) → scheda **Rules** → incolla:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

7. Ricarica il sito → **Profilo → Accedi con Google**. Da quel momento canali, visti,
   avanzamenti e impostazioni sono sincronizzati in tempo reale su tutti i dispositivi.

Finché Firebase non è configurato, tutto viene comunque salvato in locale sul dispositivo
(e puoi spostare i dati con **Impostazioni → Esporta/Importa backup**).

## 🗂 Struttura

```
index.html              Shell dell'app (topbar, tab bar mobile, root dei player)
manifest.webmanifest    PWA manifest (installabile su telefono)
css/style.css           Design system "cinema" (dark, glassmorphism, animazioni)
js/config.js            Chiave API di default, proxy CORS per gli RSS, costanti
js/firebase-config.js   Configurazione Firebase (da compilare per il cloud)
js/utils.js             Utility, icone SVG, toast, modali
js/api.js               YouTube Data API v3 + fallback feed RSS + ricerca
js/store.js             Stato, persistenza locale, refresh, statistiche
js/cloud.js             Login Google (Firebase Auth) + sync Firestore in tempo reale
js/player.js            Player video integrato + player Shorts verticale
js/app.js               Router e viste (home, video, shorts, ricerca, canali, profilo, impostazioni)
```

## 🧠 Come riconosce gli Shorts

1. Durata ≤ 60s → short; `#shorts` nel titolo → short.
2. Per i casi ambigui (60s–3min o video da RSS) verifica l'esistenza della
   **miniatura verticale** (`oar2.jpg`), che YouTube genera solo per gli Shorts.
