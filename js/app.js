/* Laverie Mapper — Phase 1 (ville pilote : Pessac)
 *
 * Modèle volontairement simple et transparent :
 * - la demande est portée par les centroïdes de quartiers (à remplacer par le carroyage INSEE 200 m)
 * - la couverture est un rayon piéton paramétrable (à remplacer par des isochrones)
 * - le CA est une fourchette issue des benchmarks secteur, jamais un chiffre unique
 */

const TAILLE_MENAGE = 2.2; // personnes par ménage (moyenne France, à affiner par quartier via INSEE)

// Rayon de référence du diagnostic par quartier. Volontairement indépendant du
// curseur d'affichage : les couleurs de la carte ne doivent pas changer de sens
// quand on ajuste la taille des cercles de couverture.
const RAYON_TENSION = 800;

const state = {
  laveries: [],
  quartiers: [],
  benchmarks: null,
  rayon: RAYON_TENSION,
  simulation: false,
  layers: {},
  candidats: [],
  // Hypothèses ajustables par l'utilisateur. null = valeur du secteur
  // (data/benchmarks.json). Les bouger permet de vérifier si le classement
  // résiste à l'incertitude, qui est ici la principale limite.
  hyp: { depenseMediane: null, facteurDemande: 1, caReference: null, poidsCaptif: 0.4, loyer: null, stressEnergie: false },
};

let map;

// ---------- utilitaires ----------

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtEur(n) {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
}

function fmtInt(n) {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
}

const COULEURS = { chaine: '#2563eb', independant: '#16a34a', captif: '#6b7280' };
const LIBELLES = { chaine: 'Chaîne / réseau', independant: 'Indépendant', captif: 'Captive (résidence)' };

// ATTRACTIVITÉ D'UNE LAVERIE — le « A » du modèle de Huff.
//
// Toutes les laveries ne se valent pas : une enseigne notée 4,3/5 avec des
// machines récentes capte bien plus qu'une adresse notée 1,9/5 dont la moitié
// du parc est en panne. Trois facteurs, tous issus des données Google :
//
//   qualité — la note, pondérée par le nombre d'avis (une note parfaite sur
//             3 avis ne prouve rien : on la ramène vers la moyenne) ;
//   taille  — le nombre de machines EN SERVICE rapporté au parc type du secteur ;
//   accès   — les laveries de résidence (CROUS) ne captent qu'une fraction de
//             la demande de ville, leur usage étant réservé aux résidents.
const NOTE_NEUTRE = 3.5;      // note supposée quand on ne sait pas
const AVIS_CONFIANCE = 20;    // au-delà, la note est jugée représentative

function attractivite(l) {
  // Qualité : lissage bayésien vers la note neutre selon le volume d'avis.
  let qualite = 0.7;
  if (l.note_google != null) {
    const n = l.nb_avis || 0;
    const noteLissee = (l.note_google * n + NOTE_NEUTRE * AVIS_CONFIANCE)
                     / (n + AVIS_CONFIANCE);
    // 1★ → 0,40 ; 3,5★ → 0,77 ; 5★ → 1,00
    qualite = 0.4 + 0.6 * Math.max(0, Math.min(1, (noteLissee - 1) / 4));
  }

  // Taille : machines réellement disponibles / parc type (11 machines).
  let taille = 1.0;
  if (l.nb_lave_linge != null) {
    const enService = l.nb_lave_linge - (l.nb_lave_linge_hs || 0);
    taille = Math.max(0.25, enService / 11);
  }

  const acces = l.type === 'captif' ? state.hyp.poidsCaptif : 1.0;
  return qualite * taille * acces;
}

// Laverie vulnérable : mal notée sur un volume d'avis crédible, et grand public.
// C'est la cible d'une implantation concurrente ou d'une reprise.
function estVulnerable(l) {
  return l.type !== 'captif'
      && l.note_google != null && l.note_google < 3
      && (l.nb_avis || 0) >= 10;
}

// Noyau de couverture : 1 sur place, ~0 au-delà du rayon (décroissance gaussienne).
// Approximation en attendant de vrais isochrones piétons.
function couverture(d, rayon) {
  return Math.exp(-((d / rayon) ** 2));
}

// ---------- chargement ----------

async function charger() {
  // La version autonome (fichier HTML unique) injecte les données dans window.__DATA__ ;
  // la version modulaire les charge depuis data/*.json via un serveur local.
  const [lav, qua, bench, gen, car] = window.__DATA__
    ? [window.__DATA__.laveries, window.__DATA__.quartiers,
       window.__DATA__.benchmarks, window.__DATA__.generateurs,
       window.__DATA__.carreaux]
    : await Promise.all([
      fetch('data/laveries.json').then(r => r.json()),
      fetch('data/quartiers.json').then(r => r.json()),
      fetch('data/benchmarks.json').then(r => r.json()),
      fetch('data/generateurs.json').then(r => r.json()),
      // Facultatif : absent tant que le carroyage INSEE n'a pas été importé.
      fetch('data/carreaux.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
  state.laveries = lav.laveries;
  state.meta = lav.meta;            // conservé pour réécrire un fichier complet à l'export
  state.candidats = lav.candidats || [];
  state.quartiers = qua.quartiers;
  state.benchmarks = bench;
  state.generateurs = (gen && gen.generateurs) || [];
  state.profilsGenerateurs = (gen && gen.meta && gen.meta.profils) || {};
  state.carreaux = (car && car.carreaux) || null;
  state.metaCarreaux = (car && car.meta) || null;
  initCarte();
  initUI();
  rafraichir();
}

// ---------- carte ----------

function initCarte() {
  map = L.map('map').setView([44.798, -0.640], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  state.layers.marqueurs = L.layerGroup().addTo(map);
  state.layers.couverture = L.layerGroup().addTo(map);
  state.layers.tension = L.layerGroup().addTo(map);
  state.layers.simulation = L.layerGroup().addTo(map);
  state.layers.candidats = L.layerGroup().addTo(map);
  state.layers.demande = L.layerGroup().addTo(map);
  state.layers.heat = null;

  map.on('click', (e) => {
    if (state.simulation) simuler(e.latlng.lat, e.latlng.lng);
  });
}

function typesActifs() {
  const actifs = [];
  if (document.getElementById('f-chaine').checked) actifs.push('chaine');
  if (document.getElementById('f-independant').checked) actifs.push('independant');
  if (document.getElementById('f-captif').checked) actifs.push('captif');
  return actifs;
}

// Laveries du périmètre étudié. Les laveries des communes voisines comptent
// comme concurrentes dans le modèle, mais fausseraient les statistiques et le
// contrôle de fiabilité de Pessac : on les en écarte.
function laveriesCommune() {
  return state.laveries.filter(l => !l.hors_commune && l.statut === 'actif');
}

function laveriesVisibles() {
  const types = typesActifs();
  const voisines = document.getElementById('f-voisines')?.checked;
  return state.laveries.filter(l => types.includes(l.type) && l.statut === 'actif'
                                 && (voisines || !l.hors_commune));
}

function rafraichir() {
  state._coefCal = null;   // le calibrage dépend des hypothèses courantes
  state._indexDemande = null;
  dessinerMarqueurs();
  dessinerListe();
  dessinerCouverture();
  dessinerTension();
  dessinerHeat();
  dessinerHeatPotentiel();
  dessinerDemandeCaptive();
  dessinerFiabilite();
  dessinerClassement();
  dessinerCandidats();
  majStats();
  majBarreExport();
}

function dessinerMarqueurs() {
  state.layers.marqueurs.clearLayers();
  state.marqueurs = {};
  for (const l of laveriesVisibles()) {
    // Une laverie mal notée dans une zone qui a de la demande est une cible :
    // on la cercle en orange pour qu'elle saute aux yeux sur la carte.
    const vulnerable = estVulnerable(l);
    if (vulnerable) {
      L.circleMarker([l.lat, l.lon], {
        radius: 17, color: '#f97316', weight: 3, fill: false, interactive: false,
      }).addTo(state.layers.marqueurs);
    }
    const m = L.circleMarker([l.lat, l.lon], {
      radius: 9,
      color: '#fff',
      weight: 2,
      fillColor: COULEURS[l.type],
      fillOpacity: 0.95,
    }).addTo(state.layers.marqueurs);
    // Un clic sur le marqueur ouvre la fiche complète, comme sur Google Maps.
    m.on('click', () => { ouvrirFiche(l.id); surlignerListe(l.id); });
    m.bindTooltip(`${l.nom}${l.note_google != null ? ` — ${l.note_google}★` : ''}`);
    state.marqueurs[l.id] = m;
  }
}

// ---------- fiche détaillée façon Google Maps ----------

function etoiles(note) {
  if (note == null) return '';
  const pleines = Math.floor(note);
  const demi = note - pleines >= 0.25 && note - pleines < 0.75;
  const bonus = note - pleines >= 0.75 ? 1 : 0;
  return '★'.repeat(pleines + bonus) + (demi ? '⯨' : '') +
         '☆'.repeat(5 - pleines - bonus - (demi ? 1 : 0));
}

// TENDANCE DES AVIS
//
// La note moyenne masque l'évolution : une laverie à 4,3 dont tous les avis
// récents sont à 1★ est une laverie en train de se dégrader — donc une
// opportunité que la note seule ne montre pas.
//
// Attention : Google ne renvoie que 5 avis par établissement, sélectionnés par
// ses soins. L'échantillon est petit et non aléatoire : c'est un signal à
// vérifier en lisant les avis complets, pas une mesure.
function ancienneteAnnees(date) {
  if (!date) return null;
  const t = date.toLowerCase();
  const n = parseInt((t.match(/(\d+)/) || [null, '1'])[1], 10);
  if (t.includes('jour')) return n / 365;
  if (t.includes('semaine')) return n / 52;
  if (t.includes('mois')) return n / 12;
  if (t.includes('an')) return n;
  return null;
}

function tendanceAvis(l) {
  const pts = (l.avis || [])
    .map(a => ({ note: a.note, age: ancienneteAnnees(a.date) }))
    .filter(p => p.note != null && p.age != null);
  const recents = pts.filter(p => p.age <= 2).map(p => p.note);
  const anciens = pts.filter(p => p.age > 2).map(p => p.note);
  if (recents.length < 2 || anciens.length < 1) return null;
  const moy = (t) => t.reduce((s, x) => s + x, 0) / t.length;
  const mRec = moy(recents), mAnc = moy(anciens);
  const delta = mRec - mAnc;
  return {
    mRec, mAnc, delta, nRec: recents.length, nAnc: anciens.length,
    sens: delta <= -1 ? 'degradation' : delta < -0.3 ? 'baisse'
        : delta > 0.3 ? 'amelioration' : 'stable',
  };
}

const LIBELLE_TENDANCE = {
  degradation: ['⬇ Se dégrade nettement', '#dc2626'],
  baisse: ['⬊ En baisse', '#eab308'],
  stable: ['→ Stable', '#64748b'],
  amelioration: ['⬈ S\'améliore', '#16a34a'],
};

const LIBELLE_FIABILITE = {
  officielle: 'Google officiel',
  bonne: 'source fiable',
  moyenne: 'annuaire tiers',
  faible: 'à confirmer',
};

function galerie(l) {
  if (l.photos && l.photos.length) {
    const principale = l.photos[0];
    const minis = l.photos.length > 1
      ? `<div class="galerie-miniatures">${l.photos.map((p, i) =>
          `<img src="${p.fichier}" alt="Photo ${i + 1}" data-i="${i}">`).join('')}</div>`
      : '';
    // L'attribution des photos Google est obligatoire.
    const attribs = [...new Set(l.photos.flatMap(p => p.attributions || []))];
    const credit = attribs.length
      ? `<p class="galerie-attrib">Photos : ${attribs.join(', ')} — via Google</p>` : '';
    return `<div class="galerie">
      <img id="photo-principale" src="${principale.fichier}" alt="${l.nom}">
      ${minis}</div>${credit}`;
  }
  return `<div class="galerie"><div class="galerie-vide">
    <span class="ico">📷</span>
    <span>Aucune photo pour l'instant</span>
    <span style="font-size:0.7rem">Les photos Google se récupèrent avec
    <code>scripts/enrich_google_places.py</code> et votre clé API.</span>
  </div></div>`;
}

// Google renvoie les horaires jour par jour ; on condense quand la semaine est
// uniforme, sinon on affiche une ligne par jour.
function formaterHoraires(h) {
  if (!h) return null;
  if (!h.includes(' ; ')) return h;
  const jours = h.split(' ; ').map(j => j.trim());
  const plages = jours.map(j => j.split(': ').slice(1).join(': ').trim());
  if (new Set(plages).size === 1) return `Tous les jours ${plages[0]}`;
  return jours.map(j => `<span style="display:block">${j}</span>`).join('');
}

function ligneInfo(icone, valeur, manquantTexte) {
  const contenu = valeur
    ? `<span class="val">${valeur}</span>`
    : `<span class="val manquant">${manquantTexte}</span>`;
  return `<div class="ligne"><span class="ic">${icone}</span>${contenu}</div>`;
}

function ficheLaverie(l) {
  const rechercheGoogle = encodeURIComponent(`${l.nom} ${l.adresse}`);
  const urlMaps = l.google_maps_url
    || `https://www.google.com/maps/search/?api=1&query=${rechercheGoogle}`;
  const urlStreet = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${l.lat},${l.lon}`;

  const noteBloc = l.note_google != null
    ? `<div class="note-ligne">
         <span class="note-chiffre">${l.note_google.toFixed(1)}</span>
         <span class="etoiles">${etoiles(l.note_google)}</span>
         <span class="note-nb">${l.nb_avis != null ? l.nb_avis + ' avis' : 'nombre d\'avis inconnu'}</span>
         <span class="fiabilite fia-${l.note_fiabilite || 'faible'}">${LIBELLE_FIABILITE[l.note_fiabilite] || 'à confirmer'}</span>
       </div>`
    : `<div class="note-ligne"><span class="note-abs">Aucune note trouvée pour cet établissement</span></div>`;

  const avisBloc = (l.avis && l.avis.length)
    ? `<h3 style="font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--accent);margin:16px 0 6px">
         Avis (${l.avis.length})</h3>
       <div class="avis-liste">${l.avis.map(a => `
         <div class="avis-item">
           <div class="avis-tete">
             <span class="avis-auteur">${a.auteur || 'Anonyme'}</span>
             ${a.note != null ? `<span class="etoiles">${etoiles(a.note)}</span>` : ''}
             ${a.date ? `<span class="avis-date">${a.date}</span>` : ''}
           </div>
           <div class="avis-texte">« ${a.texte} »</div>
           ${a.source ? `<div class="avis-src">${a.source}</div>` : ''}
         </div>`).join('')}</div>`
    : `<div class="encart">Aucun avis détaillé en base. Lancez
       <code>scripts/enrich_google_places.py</code> pour récupérer les avis Google
       officiels de cette laverie.</div>`;

  const hs = l.nb_lave_linge_hs || 0;
  const machines = l.nb_lave_linge != null
    ? `${l.nb_lave_linge} lave-linge / ${l.nb_seche_linge ?? '?'} sèche-linge`
      + (hs ? ` <span style="color:#fca5a5">— dont ${hs} en panne</span>` : '')
    : null;

  // Décomposition de l'attractivité : le lecteur doit pouvoir contester le chiffre.
  const a = attractivite(l);
  const forceBloc = `
    <div class="encart" style="border-left-color:${a >= 0.7 ? '#16a34a' : a >= 0.4 ? '#eab308' : '#dc2626'}">
      <b>Force concurrentielle : ${(a * 100).toFixed(0)} / 100</b><br>
      ${l.note_google != null
        ? `Note ${l.note_google}/5 sur ${l.nb_avis ?? '?'} avis`
        : 'Note inconnue (valeur moyenne retenue)'}
      ${l.nb_lave_linge != null
        ? ` · ${l.nb_lave_linge - hs} machine${l.nb_lave_linge - hs > 1 ? 's' : ''} en service`
        : ' · parc inconnu'}
      ${l.type === 'captif' ? ' · accès réservé aux résidents' : ''}
      <br><span style="font-size:0.72rem">C'est ce poids qui détermine la part de marché
      qu'elle retire à une nouvelle implantation voisine.</span>
    </div>`;

  return `
    ${galerie(l)}
    <div class="fiche-corps">
      <span class="tag tag-${l.type}">${LIBELLES[l.type]}${l.enseigne ? ' · ' + l.enseigne : ''}</span>
      <h2>${l.nom}</h2>
      ${noteBloc}
      <div class="fiche-actions">
        <a href="${urlMaps}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        <a href="${urlStreet}" target="_blank" rel="noopener">👁️ Street View</a>
        <a href="#" id="lien-editer">✏️ Compléter</a>
      </div>
      <div class="fiche-infos">
        ${ligneInfo('📍', l.adresse)}
        ${ligneInfo('🏘️', l.quartier, 'quartier à définir')}
        ${ligneInfo('🕐', formaterHoraires(l.horaires), 'horaires à relever')}
        ${ligneInfo('📞', l.telephone, 'téléphone inconnu')}
        ${ligneInfo('🧺', machines, 'nombre de machines à relever sur place')}
        ${ligneInfo('📐', l.surface_m2 ? l.surface_m2 + ' m²' : null, 'surface à relever sur place')}
        ${ligneInfo('💶', l.prix_cycle_8kg ? l.prix_cycle_8kg + ' € le cycle 8 kg' : null, 'prix à relever sur place')}
        ${l.site_web ? ligneInfo('🌐', `<a href="${l.site_web}" target="_blank" rel="noopener" style="color:var(--accent)">site web</a>`) : ''}
      </div>
      ${forceBloc}
      ${(() => {
        const t = tendanceAvis(l);
        if (!t) return '';
        const [libelle, couleur] = LIBELLE_TENDANCE[t.sens];
        return `<div class="encart" style="border-left-color:${couleur}">
          <b style="color:${couleur}">${libelle}</b><br>
          Avis de moins de 2 ans : <b>${t.mRec.toFixed(1)}★</b> (${t.nRec}) ·
          plus anciens : <b>${t.mAnc.toFixed(1)}★</b> (${t.nAnc})
          <br><span style="font-size:0.72rem">Sur les 5 avis que Google communique,
          choisis par lui : à confirmer en lisant les avis complets.</span>
        </div>`;
      })()}
      ${l.notes_terrain ? `<div class="encart"><b>Note d'analyse</b><br>${l.notes_terrain}</div>` : ''}
      ${avisBloc}
      <div class="encart" style="border-left-color:#64748b">
        <b>Sources</b><br>${(l.sources || []).join(' · ')}
        ${l.note_source ? `<br><br><b>Origine de la note</b><br>${l.note_source}` : ''}
        <br><br>Position ${l.coord_precision === 'google' ? 'issue de Google (exacte)'
          : l.coord_precision === 'osm' ? 'issue d\'OpenStreetMap' : 'estimée depuis l\'adresse (±50-300 m)'}.
      </div>
    </div>`;
}

// ---------- saisie manuelle depuis une fiche Google ----------
//
// Permet de recopier ce qu'on lit sur Google Maps sans clé API : note, avis,
// horaires, téléphone, et photos (redimensionnées puis stockées en base64 dans
// le JSON, ce qui garde l'application autonome et hors ligne).

const PHOTO_LARGEUR_MAX = 900;
const PHOTO_QUALITE = 0.72;

function redimensionner(fichier) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onerror = () => reject(new Error('lecture impossible'));
    lecteur.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image illisible'));
      img.onload = () => {
        const ratio = Math.min(1, PHOTO_LARGEUR_MAX / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * ratio);
        c.height = Math.round(img.height * ratio);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ fichier: c.toDataURL('image/jpeg', PHOTO_QUALITE),
                  largeur: c.width, hauteur: c.height, attributions: [] });
      };
      img.src = lecteur.result;
    };
    lecteur.readAsDataURL(fichier);
  });
}

function formulaireGoogle(l) {
  const v = (x) => (x == null ? '' : String(x).replace(/"/g, '&quot;'));
  return `<div class="form-google" id="form-google">
    <div class="duo">
      <div class="rangee"><label>Note Google (sur 5)</label>
        <input type="number" id="fg-note" step="0.1" min="0" max="5" value="${v(l.note_google)}" placeholder="4.3"></div>
      <div class="rangee"><label>Nombre d'avis</label>
        <input type="number" id="fg-avis" min="0" value="${v(l.nb_avis)}" placeholder="59"></div>
    </div>
    <div class="rangee"><label>Téléphone</label>
      <input type="text" id="fg-tel" value="${v(l.telephone)}" placeholder="07 83 28 67 93"></div>
    <div class="rangee"><label>Horaires</label>
      <input type="text" id="fg-horaires" value="${v(l.horaires)}" placeholder="Lun-Dim 6h-21h"></div>
    <div class="duo">
      <div class="rangee"><label>Machines (lave-linge)</label>
        <input type="number" id="fg-ll" min="0" value="${v(l.nb_lave_linge)}" placeholder="8"></div>
      <div class="rangee"><label>Sèche-linge</label>
        <input type="number" id="fg-sl" min="0" value="${v(l.nb_seche_linge)}" placeholder="4"></div>
    </div>
    <div class="duo">
      <div class="rangee"><label>Surface (m²)</label>
        <input type="number" id="fg-surface" min="0" value="${v(l.surface_m2)}" placeholder="60"></div>
      <div class="rangee"><label>Prix cycle 8 kg (€)</label>
        <input type="number" id="fg-prix" step="0.1" min="0" value="${v(l.prix_cycle_8kg)}" placeholder="4.5"></div>
    </div>
    <div class="rangee"><label>Lien Google Maps (facultatif)</label>
      <input type="text" id="fg-url" value="${v(l.google_maps_url)}" placeholder="https://maps.app.goo.gl/..."></div>
    <div class="rangee"><label>Un avis marquant (facultatif)</label>
      <textarea id="fg-avis-texte" placeholder="Collez ici le texte d'un avis Google"></textarea></div>
    <div class="rangee"><label>Photos — glissez-déposez ou cliquez</label>
      <div class="zone-photo" id="fg-zone">📷 Déposez les captures de la fiche Google<br>
        <span style="font-size:0.68rem">redimensionnées automatiquement, stockées dans vos données</span></div>
      <input type="file" id="fg-fichiers" accept="image/*" multiple hidden>
      <div class="apercus" id="fg-apercus"></div>
    </div>
    <div class="form-boutons">
      <button id="fg-enregistrer">✓ Enregistrer</button>
      <button id="fg-annuler" class="btn-second">Annuler</button>
    </div>
  </div>`;
}

// Photos en cours d'édition (validées seulement à l'enregistrement)
let photosEnCours = [];

function rendreApercus() {
  document.getElementById('fg-apercus').innerHTML = photosEnCours.map((p, i) =>
    `<span class="vignette"><img src="${p.fichier}" alt="photo ${i + 1}">
     <button data-i="${i}" title="Retirer">✕</button></span>`).join('');
  for (const b of document.querySelectorAll('#fg-apercus button')) {
    b.addEventListener('click', () => {
      photosEnCours.splice(Number(b.dataset.i), 1);
      rendreApercus();
    });
  }
}

async function ajouterPhotos(fichiers) {
  for (const f of fichiers) {
    if (!f.type.startsWith('image/')) continue;
    try {
      photosEnCours.push(await redimensionner(f));
    } catch (e) {
      console.warn('photo ignorée', f.name, e);
    }
  }
  rendreApercus();
}

function brancherFormulaire(l) {
  photosEnCours = [...(l.photos || [])];
  rendreApercus();

  const zone = document.getElementById('fg-zone');
  const input = document.getElementById('fg-fichiers');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => ajouterPhotos([...input.files]));
  for (const ev of ['dragenter', 'dragover']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('survol'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('survol'); });
  }
  zone.addEventListener('drop', (e) => ajouterPhotos([...e.dataTransfer.files]));

  document.getElementById('fg-annuler').addEventListener('click', () => ouvrirFiche(l.id));
  document.getElementById('fg-enregistrer').addEventListener('click', () => {
    const nombre = (id) => {
      const val = document.getElementById(id).value.trim();
      return val === '' ? null : Number(val);
    };
    const texte = (id) => document.getElementById(id).value.trim() || null;

    l.note_google = nombre('fg-note');
    l.nb_avis = nombre('fg-avis');
    l.telephone = texte('fg-tel');
    l.horaires = texte('fg-horaires');
    l.nb_lave_linge = nombre('fg-ll');
    l.nb_seche_linge = nombre('fg-sl');
    l.surface_m2 = nombre('fg-surface');
    l.prix_cycle_8kg = nombre('fg-prix');
    l.google_maps_url = texte('fg-url');
    l.photos = photosEnCours;

    if (l.note_google != null) {
      l.note_source = 'Fiche Google Maps relevée à la main';
      l.note_fiabilite = 'bonne';
    }
    const nouvelAvis = texte('fg-avis-texte');
    if (nouvelAvis) {
      l.avis = [...(l.avis || []), {
        auteur: 'relevé sur Google', note: null, texte: nouvelAvis,
        date: null, source: 'Google Maps (saisie manuelle)',
      }];
    }
    l.a_verifier = l.surface_m2 == null || l.nb_lave_linge == null;

    state.modifie = true;
    rafraichir();
    ouvrirFiche(l.id);
  });
}

function ouvrirEdition(id) {
  const l = state.laveries.find(x => x.id === id);
  if (!l) return;
  document.getElementById('fiche-contenu').innerHTML = `
    <div class="fiche-corps">
      <h2>Compléter « ${l.nom} »</h2>
      <p class="hint">Recopiez ce que vous lisez sur la fiche Google Maps.
      Les champs vides restent inchangés côté affichage.</p>
      ${formulaireGoogle(l)}
    </div>`;
  document.getElementById('fiche').scrollTop = 0;
  brancherFormulaire(l);
}

// ---------- export des données modifiées ----------

function exporterDonnees() {
  const contenu = {
    meta: { ...(state.meta || {}), derniere_maj: new Date().toISOString().slice(0, 10) },
    laveries: state.laveries,
    // Les emplacements étudiés font partie du travail : on les conserve.
    candidats: state.candidats,
    generateurs: state.generateurs,
  };
  const blob = new Blob([JSON.stringify(contenu, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'laveries.json';
  a.click();
  URL.revokeObjectURL(a.href);
  state.modifie = false;
  majBarreExport();
}

// La barre n'apparaît qu'en présence de modifications non exportées.
function majBarreExport() {
  const barre = document.getElementById('barre-export');
  if (!barre) return;
  barre.classList.toggle('hidden', !state.modifie);
  document.getElementById('modifs-info').textContent =
    state.modifie ? '⚠ Modifications non enregistrées' : '';
}

function ouvrirFiche(id) {
  const l = state.laveries.find(x => x.id === id);
  if (!l) return;
  document.getElementById('fiche-contenu').innerHTML = ficheLaverie(l);
  document.getElementById('fiche').classList.remove('hidden');
  document.getElementById('fiche').scrollTop = 0;

  // Miniatures cliquables : remplacent la photo principale
  const principale = document.getElementById('photo-principale');
  for (const mini of document.querySelectorAll('.galerie-miniatures img')) {
    mini.addEventListener('click', () => { principale.src = mini.src; });
  }
  document.getElementById('lien-editer').addEventListener('click', (e) => {
    e.preventDefault();
    ouvrirEdition(id);
  });
  surlignerListe(id);
}

function fermerFiche() {
  document.getElementById('fiche').classList.add('hidden');
}

// ---------- liste des laveries (contrôle de l'inventaire) ----------

// Champs qui doivent être relevés sur le terrain pour qu'une fiche soit exploitable.
const CHAMPS_TERRAIN = ['surface_m2', 'nb_lave_linge', 'nb_seche_linge', 'prix_cycle_8kg', 'horaires'];

function classeNote(n) {
  if (n == null) return 'note-inconnue';
  if (n >= 4) return 'note-bonne';
  if (n >= 3) return 'note-moyenne';
  return 'note-mauvaise';
}

function surlignerListe(id) {
  for (const li of document.querySelectorAll('#liste-laveries li')) {
    li.classList.toggle('actif', li.dataset.id === id);
  }
}

function dessinerListe() {
  const ul = document.getElementById('liste-laveries');
  const visibles = laveriesVisibles().filter(l => !l.hors_commune);
  ul.innerHTML = visibles.map(l => {
    const note = l.note_google != null
      ? `${l.note_google}★${l.nb_avis != null ? `<br><span style="font-weight:400;font-size:0.62rem">${l.nb_avis} avis</span>` : ''}`
      : 'n.c.';
    const voisine = l.hors_commune
      ? '<span class="meta" style="color:#94a3b8">hors Pessac — concurrente</span>' : '';
    const cible = estVulnerable(l)
      ? '<span class="meta" style="color:#f97316">🎯 cible : mal notée, zone à reprendre</span>' : '';
    return `<li data-id="${l.id}">
      <span class="dot dot-${l.type}"></span>
      <span class="nom">${l.nom}<span class="meta">${l.quartier ?? 'quartier à définir'}</span>${voisine}${cible}</span>
      <span class="note ${classeNote(l.note_google)}">${note}</span>
    </li>`;
  }).join('');

  document.getElementById('liste-count').textContent = visibles.length;

  for (const li of ul.querySelectorAll('li')) {
    li.addEventListener('click', () => {
      const l = state.laveries.find(x => x.id === li.dataset.id);
      map.flyTo([l.lat, l.lon], 16, { duration: 0.8 });
      ouvrirFiche(l.id);
    });
  }

  // Complétude : part des champs terrain effectivement renseignés
  const total = state.laveries.length * CHAMPS_TERRAIN.length;
  let remplis = 0;
  for (const l of state.laveries) {
    for (const c of CHAMPS_TERRAIN) if (l[c] != null) remplis++;
  }
  const pct = Math.round(100 * remplis / total);
  document.getElementById('completude-bar').style.width = pct + '%';
  document.getElementById('completude-txt').textContent = pct + ' %';
}

function dessinerCouverture() {
  state.layers.couverture.clearLayers();
  if (!document.getElementById('l-couverture').checked) return;
  for (const l of laveriesVisibles()) {
    L.circle([l.lat, l.lon], {
      radius: state.rayon,
      color: COULEURS[l.type],
      weight: 1,
      fillColor: COULEURS[l.type],
      fillOpacity: 0.10,
      interactive: false,
    }).addTo(state.layers.couverture);
  }
}

function dessinerHeat() {
  if (state.layers.heat) { map.removeLayer(state.layers.heat); state.layers.heat = null; }
  if (!document.getElementById('l-heat-offre').checked) return;
  const points = laveriesVisibles().map(l => [l.lat, l.lon, attractivite(l)]);
  state.layers.heat = L.heatLayer(points, { radius: 45, blur: 30, maxZoom: 15, max: 1.5 }).addTo(map);
}

// Part de ménages sans lave-linge dans un quartier : elle croît avec la part de
// petits logements (studios et T1 sont rarement équipés).
function partClienteleReguliere(q) {
  const c = state.benchmarks.demande.clientele_reguliere;
  const [pMin, pMax] = c.part_menages_pct;
  const facteur = Math.min(1, q.part_petits_logements_est / c.seuil_petits_logements_borne_haute);
  return (pMin + (pMax - pMin) * facteur) / 100 * state.hyp.facteurDemande;
}

// Fourchette de dépense de la clientèle régulière, recentrée sur la médiane
// choisie par l'utilisateur (l'amplitude relative du secteur est conservée).
function depenseReguliere() {
  const [min, max] = state.benchmarks.demande.clientele_reguliere.depense_annuelle_eur;
  if (state.hyp.depenseMediane == null) return [min, max];
  const ratio = state.hyp.depenseMediane / ((min + max) / 2);
  return [min * ratio, max * ratio];
}

// CA médian d'une laverie du secteur : référence à laquelle on compare une zone.
// CA maximal encaissable par une laverie de grand format, déduit du parc type et
// du rendement par machine (benchmarks secteur).
function plafondCapacite() {
  // Borne haute observée toutes zones confondues (Wash'N Dry) : c'est le CA
  // maximal qu'un très bon emplacement peut produire, machines comprises.
  return state.benchmarks.exploitation.ca_annuel_fourchette_large_eur[1];
}

function caReference() {
  if (state.hyp.caReference != null) return state.hyp.caReference;
  const [min, max] = state.benchmarks.exploitation.ca_annuel_laverie_eur;
  return (min + max) / 2;
}

// ÉTALEMENT DE LA POPULATION
//
// Concentrer les habitants d'un quartier en un point crée de faux points chauds :
// deux centroïdes voisins se cumulent et le modèle voit une densité qui n'existe
// pas. On répartit donc chaque quartier sur un disque — un point central et une
// couronne — ce qui lisse la surface de demande.
//
// Ce n'est qu'un pis-aller : le vrai correctif est le carroyage INSEE 200 m, qui
// donne la population réellement observée maille par maille.
const RAYON_ETALEMENT = 450;      // m
const POIDS_CENTRE = 0.4;
const POINTS_COURONNE = 6;

// Occupation moyenne d'un logement selon le type de bâtiment. Une chambre
// étudiante loge une personne, un logement social une famille.
const OCCUPANTS = { residence_etudiante: 1.1, logement_social: 2.4, hebergement_tourisme: 2.0 };

// Demande portée par un générateur, exprimée directement en ménages : un
// logement = un ménage. Pas de division par la taille des ménages ici.
function menagesGenerateur(g) {
  return {
    reguliers: g.logements * g.part_sans_lave_linge,
    ponctuels: g.logements * (1 - g.part_sans_lave_linge) * 0.20,
    habitants: g.logements * (OCCUPANTS[g.type] || 2),
  };
}

// Part de ménages sans lave-linge d'un carreau INSEE, déduite de la part de
// ménages d'une seule personne — qui vivent très majoritairement en petit
// logement. C'est la donnée MESURÉE qui remplace mes estimations à la main.
function partSansLaveLingeCarreau(c) {
  const cb = state.benchmarks.demande.clientele_reguliere;
  const [pMin, pMax] = cb.part_menages_pct;
  const menages = c.menages || c.ind / TAILLE_MENAGE;
  if (!menages) return pMin / 100;
  const partSeuls = (c.men_1ind || 0) / menages;
  const facteur = Math.min(1, partSeuls / cb.seuil_petits_logements_borne_haute);
  return (pMin + (pMax - pMin) * facteur) / 100 * state.hyp.facteurDemande;
}

function pointsDemande() {
  if (state._pointsDemande) return state._pointsDemande;
  const pts = [];

  // Quand le carroyage INSEE est disponible, il REMPLACE les centroïdes de
  // quartiers : population observée maille par maille au lieu d'estimations.
  if (state.carreaux && state.carreaux.length) {
    const [ppMin, ppMax] = state.benchmarks.demande.clientele_ponctuelle.part_menages_concernes_pct;
    const partPonctuelle = ((ppMin + ppMax) / 2) / 100;
    for (const c of state.carreaux) {
      const menages = c.menages || c.ind / TAILLE_MENAGE;
      const reg = menages * partSansLaveLingeCarreau(c);
      pts.push({ carreau: c, lat: c.lat, lon: c.lon, part: 1,
                 habitants: c.ind, menagesReguliers: reg,
                 menagesPonctuels: (menages - reg) * partPonctuelle });
    }
    // Les résidences repérées sont déjà comptées dans les carreaux : on ne les
    // ajoute pas une seconde fois, on garde seulement leur affichage.
    state._pointsDemande = pts;
    return pts;
  }

  // Les habitants des résidences repérées sont DÉJÀ comptés dans la population
  // de leur quartier. On les en retire avant de les replacer à leur position
  // exacte, sinon la demande est comptée deux fois là où elle est la plus forte.
  const retrait = {};
  for (const g of state.generateurs || []) {
    const q = state.quartiers.reduce((meilleur, x) =>
      distanceM(g.lat, g.lon, x.lat, x.lon) < distanceM(g.lat, g.lon, meilleur.lat, meilleur.lon)
        ? x : meilleur, state.quartiers[0]);
    retrait[q.id] = (retrait[q.id] || 0) + menagesGenerateur(g).habitants;
  }

  for (const g of state.generateurs || []) {
    const m = menagesGenerateur(g);
    pts.push({ generateur: g, lat: g.lat, lon: g.lon, part: 1,
               menagesReguliers: m.reguliers, menagesPonctuels: m.ponctuels,
               habitants: m.habitants });
  }

  for (const q of state.quartiers) {
    // Population résiduelle : on ne descend jamais sous 20 % pour absorber une
    // éventuelle surestimation du nombre de logements des générateurs.
    const restante = Math.max(q.population * 0.2, q.population - (retrait[q.id] || 0));
    const qEff = { ...q, population: restante };
    pts.push({ q: qEff, lat: q.lat, lon: q.lon, part: POIDS_CENTRE });
    const partAnneau = (1 - POIDS_CENTRE) / POINTS_COURONNE;
    // 1° de latitude ≈ 111 320 m ; la longitude se resserre avec la latitude.
    const dLat = RAYON_ETALEMENT / 111320;
    const dLon = RAYON_ETALEMENT / (111320 * Math.cos(q.lat * Math.PI / 180));
    for (let i = 0; i < POINTS_COURONNE; i++) {
      const a = (2 * Math.PI * i) / POINTS_COURONNE;
      pts.push({ q: qEff, lat: q.lat + dLat * Math.sin(a),
                 lon: q.lon + dLon * Math.cos(a), part: partAnneau });
    }
  }
  state._pointsDemande = pts;
  return pts;
}

// INDEX SPATIAL des points de demande.
//
// Avec le carroyage INSEE, la demande passe de ~120 points à plusieurs milliers.
// Sans index, repeindre la heatmap devient une opération à plusieurs millions de
// distances : on range donc les points dans des cases et on ne visite que les
// cases utiles. Le résultat est strictement identique, seul le temps change.
const TAILLE_CASE_M = 500;

function indexDemande() {
  if (state._indexDemande) return state._indexDemande;
  const pts = pointsDemande();
  const cases = new Map();
  const dLat = TAILLE_CASE_M / 111320;
  for (const p of pts) {
    const dLon = TAILLE_CASE_M / (111320 * Math.cos(p.lat * Math.PI / 180));
    const cle = Math.round(p.lat / dLat) + ':' + Math.round(p.lon / dLon);
    (cases.get(cle) || cases.set(cle, []).get(cle)).push(p);
  }
  state._indexDemande = { cases, dLat };
  return state._indexDemande;
}

function pointsProches(lat, lon, R) {
  const { cases, dLat } = indexDemande();
  const dLon = TAILLE_CASE_M / (111320 * Math.cos(lat * Math.PI / 180));
  // Au-delà de 1,8 R le noyau gaussien vaut moins de 4 % : inutile d'aller plus loin.
  const portee = Math.ceil((R * 1.8) / TAILLE_CASE_M);
  const ci = Math.round(lat / dLat), cj = Math.round(lon / dLon);
  const proches = [];
  for (let i = ci - portee; i <= ci + portee; i++) {
    for (let j = cj - portee; j <= cj + portee; j++) {
      const b = cases.get(i + ':' + j);
      if (b) proches.push(...b);
    }
  }
  return proches;
}

// Demande accessible depuis un point : agrège les points de demande voisins
// pondérés par la distance. La demande ne s'arrête pas à la frontière d'un
// quartier — un habitant du quartier d'à côté à 300 m est un client tout aussi
// probable.
function demandeAccessible(lat, lon, R) {
  const [ppMin, ppMax] = state.benchmarks.demande.clientele_ponctuelle.part_menages_concernes_pct;
  const partPonctuelle = ((ppMin + ppMax) / 2) / 100;
  let pop = 0, reguliers = 0, ponctuels = 0;
  for (const p of pointsProches(lat, lon, R)) {
    const w = couverture(distanceM(lat, lon, p.lat, p.lon), R);
    if (w < 0.05) continue;
    if (p.generateur || p.carreau) {
      // Bâtiment identifié : la demande est connue en logements, pas en habitants.
      pop += p.habitants * w;
      reguliers += p.menagesReguliers * w * state.hyp.facteurDemande;
      ponctuels += p.menagesPonctuels * w;
    } else {
      const habitants = p.q.population * p.part * w;
      pop += habitants;
      const menages = habitants / TAILLE_MENAGE;
      const reg = menages * partClienteleReguliere(p.q);
      reguliers += reg;
      ponctuels += (menages - reg) * partPonctuelle;
    }
  }
  return { pop, reguliers, ponctuels };
}

// Pression concurrentielle exercée sur un point par les laveries existantes.
function offreAccessible(lat, lon, R) {
  let pression = 0;
  const concurrents = [];
  // Toutes les laveries actives, communes voisines comprises : la demande
  // déborde de Pessac, la concurrence doit couvrir la même zone.
  for (const l of state.laveries.filter(x => x.statut === 'actif')) {
    const d = distanceM(lat, lon, l.lat, l.lon);
    const p = attractivite(l) * couverture(d, R);
    if (p < 0.01) continue;
    pression += p;
    if (p > 0.05) concurrents.push({ nom: l.nom, d: Math.round(d), type: l.type });
  }
  return { pression, concurrents };
}

// CALIBRAGE SUR LE MARCHÉ LOCAL
//
// La demande est reconstituée à partir de populations de quartiers estimées : en
// valeur absolue, elle n'a aucune raison d'être juste. On cale donc l'échelle sur
// ce qu'on observe : les laveries grand public de Pessac doivent totaliser, selon
// le modèle, le CA que les benchmarks prêtent à ce nombre d'établissements.
//
// Conséquence importante et voulue : l'indice devient le rapport entre ce que
// ferait une nouvelle laverie et ce que fait une laverie moyenne de Pessac.
// Indice 1,3 = « 30 % de mieux que la moyenne locale ». Une erreur uniforme sur
// mes estimations de population s'annule donc au numérateur et au dénominateur —
// seuls les écarts RELATIFS entre zones subsistent, et ce sont les seuls dont on
// ait besoin pour choisir un emplacement.
// OPTION EXTÉRIEURE du modèle de Huff.
//
// Sans ce terme, les parts de marché somment toujours à 1 : une laverie isolée
// capte l'intégralité de sa zone, même notée 1,9/5 avec la moitié du parc en
// panne. C'est faux — devant une laverie sale, le client renonce, va dans une
// autre commune, ou lave chez un proche. Ce poids représente ce non-recours.
const ATTRACTIVITE_EXTERIEURE = 0.5;

function caBrut(lat, lon, R, laverieExistante) {
  const b = state.benchmarks;
  const dem = demandeAccessible(lat, lon, R);
  const { pression } = offreAccessible(lat, lon, R);

  // Une laverie existante se partage le marché avec les autres selon son propre
  // poids ; un nouvel entrant arrive avec une attractivité de référence de 1.
  const partMarche = laverieExistante
    ? attractivite(laverieExistante) / (pression + ATTRACTIVITE_EXTERIEURE)
    : 1 / (1 + pression + ATTRACTIVITE_EXTERIEURE);

  const [regMin, regMax] = depenseReguliere();
  const [ponMin, ponMax] = b.demande.clientele_ponctuelle.depense_annuelle_eur;
  const reg = dem.reguliers * partMarche;
  const pon = dem.ponctuels * partMarche;
  return {
    ...dem, pression, partMarche, regCaptes: reg, ponCaptes: pon,
    caMin: reg * regMin + pon * ponMin,
    caMax: reg * regMax + pon * ponMax,
  };
}

function coefficientCalibrage() {
  if (state._coefCal != null) return state._coefCal;
  const publiques = laveriesCommune().filter(l => l.type !== 'captif');
  if (!publiques.length) return (state._coefCal = 1);
  let predit = 0;
  for (const l of publiques) {
    const e = caBrut(l.lat, l.lon, RAYON_TENSION, l);
    predit += (e.caMin + e.caMax) / 2;
  }
  const attendu = publiques.length * caReference();
  state._coefCal = predit > 0 ? attendu / predit : 1;
  return state._coefCal;
}

// CŒUR DU MODÈLE : estime ce que réaliserait une laverie implantée en (lat, lon).
//
// Une seule fonction alimente à la fois le diagnostic par quartier et le
// simulateur — c'est ce qui garantit que les deux lectures de la carte racontent
// toujours la même histoire. Elle combine :
//   1. la demande accessible, séparée en clientèle régulière et ponctuelle ;
//   2. la part de marché face aux laveries existantes (Huff simplifié) ;
//   3. les dépenses annuelles par type de clientèle, en fourchette.
function estimerCA(lat, lon, R) {
  const { concurrents } = offreAccessible(lat, lon, R);
  const brut = caBrut(lat, lon, R, null);
  const { pression, partMarche, regCaptes, ponCaptes } = brut;

  // Mise à l'échelle sur le marché local observé (voir coefficientCalibrage).
  const coef = coefficientCalibrage();
  const caBrutMin = brut.caMin * coef;
  const caBrutMax = brut.caMax * coef;
  const dem = { pop: brut.pop, reguliers: brut.reguliers, ponctuels: brut.ponctuels };

  // PLAFOND DE CAPACITÉ — une laverie ne peut pas encaisser plus que ce que ses
  // machines produisent. Sans ce plafond, une zone très demandeuse affiche un CA
  // physiquement impossible, et un plan de financement bâti dessus est faux.
  // Quand la demande dépasse ce plafond, ce n'est pas un CA plus élevé : c'est le
  // signe que la zone peut porter un grand format ou deux implantations.
  const plafond = plafondCapacite();
  const caMin = Math.min(caBrutMin, plafond);
  const caMax = Math.min(caBrutMax, plafond);
  const caMed = (caMin + caMax) / 2;

  return {
    ...dem, pression, concurrents, partMarche, regCaptes, ponCaptes,
    caMin, caMax, caMed, caBrutMax, plafond,
    depasseCapacite: caBrutMax > plafond,
    // Combien de laveries de taille normale la demande pourrait porter.
    laveriesPortables: caBrutMax / plafond,
    // indice > 1 : la zone dégagerait plus que le CA médian du secteur
    indice: caMed / caReference(),
  };
}

// Diagnostic d'un quartier : une NOUVELLE laverie implantée ici serait-elle viable ?
// On évite volontairement un ratio offre/demande brut, qui explose vers l'infini
// dès que l'offre locale tend vers zéro et ferait passer un hameau de 300
// habitants pour une opportunité majeure.
function tensionQuartier(q) {
  return estimerCA(q.lat, q.lon, RAYON_TENSION);
}

function couleurTension(i) {
  if (i < 0.6) return '#15803d';   // pas de place : marché déjà servi ou demande trop faible
  if (i < 1.0) return '#eab308';   // limite
  return '#dc2626';                // une nouvelle laverie atteindrait le seuil de viabilité
}

function dessinerTension() {
  state.layers.tension.clearLayers();
  if (!document.getElementById('l-tension').checked) return;
  for (const q of state.quartiers) {
    const t = tensionQuartier(q);
    const label = t.indice < 0.6 ? 'Pas de place pour une laverie'
      : (t.indice < 1.0 ? 'Zone limite' : 'Place pour une laverie');
    L.circleMarker([q.lat, q.lon], {
      radius: Math.max(10, Math.sqrt(q.population) / 5),
      color: couleurTension(t.indice),
      weight: 2,
      fillColor: couleurTension(t.indice),
      fillOpacity: 0.30,
    }).bindPopup(`<div class="popup"><h3>${q.nom}</h3>
      <table>
      <tr><td>Population (est.)</td><td>${fmtInt(q.population)}</td></tr>
      <tr><td>Clientèle régulière accessible</td><td>~${fmtInt(t.reguliers)} ménages</td></tr>
      <tr><td>Concurrence en place</td><td>${t.pression.toFixed(2)} équiv. laverie → part de marché ${Math.round(t.partMarche * 100)} %</td></tr>
      <tr><td>CA d'une nouvelle laverie</td><td>${fmtEur(t.caMin)} – ${fmtEur(t.caMax)}<br>(référence secteur : ${fmtEur(caReference())})</td></tr>
      <tr><td>Diagnostic</td><td><strong>${label}</strong> (indice ${t.indice.toFixed(2)})</td></tr>
      </table>
      <p class="warn">${q.commentaire ?? ''}</p></div>`, { maxWidth: 320 })
      .addTo(state.layers.tension);
  }
}

// ---------- classement des zones d'implantation ----------

function dessinerClassement() {
  const ol = document.getElementById('classement');
  const zones = state.quartiers
    .map(q => ({ q, t: tensionQuartier(q) }))
    .sort((a, b) => b.t.indice - a.t.indice)
    .slice(0, 6);

  ol.innerHTML = zones.map(({ q, t }) => {
    const cls = t.indice >= 1 ? 'verdict bon' : (t.indice >= 0.6 ? 'verdict moyen' : 'verdict faible');
    return `<li data-id="${q.id}" style="border-left-color:${couleurTension(t.indice)}">
      <span class="z-nom">${q.nom}
        <span class="z-ca">CA potentiel ${fmtEur(t.caMin)} – ${fmtEur(t.caMax)}</span></span>
      <span class="z-ind ${cls}">${t.indice.toFixed(2)}</span>
    </li>`;
  }).join('');

  for (const li of ol.querySelectorAll('li')) {
    li.addEventListener('click', () => {
      const q = state.quartiers.find(x => x.id === li.dataset.id);
      map.flyTo([q.lat, q.lon], 15, { duration: 0.8 });
      // On lance directement la simulation sur la zone pour éviter un aller-retour.
      state.simulation = true;
      const btn = document.getElementById('btn-simu');
      btn.classList.add('active');
      btn.textContent = '🎯 Cliquez sur la carte… (cliquer ici pour quitter)';
      simuler(q.lat, q.lon);
    });
  }
}

// ---------- statistiques ----------

function majStats() {
  const visibles = laveriesVisibles().filter(l => !l.hors_commune);
  const grandPublic = laveriesCommune().filter(l => l.type !== 'captif');
  const pop = state.quartiers.reduce((s, q) => s + q.population, 0);
  document.getElementById('stat-count').textContent = visibles.length;
  document.getElementById('stat-open').textContent = grandPublic.length;
  document.getElementById('stat-pop').textContent = fmtInt(pop);
  const ratio = Math.round(pop / grandPublic.length);
  document.getElementById('stat-ratio').textContent = fmtInt(ratio);

  const [bMin, bMax] = state.benchmarks.demande.habitants_par_laverie_zone_urbaine;
  let verdict;
  if (ratio > bMax) verdict = `⚠ ${fmtInt(ratio)} hab./laverie grand public : au-dessus de la fourchette benchmark (${fmtInt(bMin)}–${fmtInt(bMax)}). Le marché semble globalement SOUS-ÉQUIPÉ — regardez les quartiers rouges.`;
  else if (ratio < bMin) verdict = `${fmtInt(ratio)} hab./laverie : marché dense, cherchez les poches mal couvertes plutôt qu'une implantation frontale.`;
  else verdict = `${fmtInt(ratio)} hab./laverie : dans la fourchette benchmark (${fmtInt(bMin)}–${fmtInt(bMax)}). L'opportunité se joue quartier par quartier.`;
  document.getElementById('stat-verdict').textContent = verdict;
}

// ---------- simulateur ----------

function simuler(lat, lon) {
  state.layers.simulation.clearLayers();
  const R = state.rayon;
  const b = state.benchmarks;

  L.circleMarker([lat, lon], { radius: 10, color: '#fff', weight: 2, fillColor: '#f97316', fillOpacity: 1 })
    .addTo(state.layers.simulation);
  L.circle([lat, lon], { radius: R, color: '#f97316', weight: 2, dashArray: '6 6', fillColor: '#f97316', fillOpacity: 0.08 })
    .addTo(state.layers.simulation);

  // Même fonction d'estimation que le diagnostic par quartier : les deux
  // lectures de la carte ne peuvent donc pas se contredire.
  const e = estimerCA(lat, lon, R);
  const { pop: popCouverte, reguliers: menagesReguliers, ponctuels: menagesPonctuels,
          concurrents, partMarche, regCaptes, ponCaptes, caMin, caMax } = e;

  const [viabMin] = b.exploitation.ca_annuel_laverie_eur;
  let verdictCls, verdictTxt;
  if (caMin >= viabMin) { verdictCls = 'bon'; verdictTxt = '✅ Zone prometteuse : même l\'hypothèse basse dépasse le seuil de viabilité du secteur (' + fmtEur(viabMin) + '/an).'; }
  else if (caMax >= viabMin) { verdictCls = 'moyen'; verdictTxt = '🟡 Zone à étudier : viable seulement en hypothèse haute. À valider par comptage terrain et vraies données INSEE.'; }
  else { verdictCls = 'faible'; verdictTxt = '❌ Zone insuffisante : la demande captée ne couvre pas le seuil de viabilité (' + fmtEur(viabMin) + '/an).'; }

  const [margeMin, margeMax] = b.exploitation.marge_nette_pct;
  const listeConc = concurrents.length
    ? concurrents.sort((a, c) => a.d - c.d).map(c => `• ${c.nom} (${c.d} m)`).join('<br>')
    : 'Aucun concurrent significatif dans la zone.';

  // Mémorisé pour pouvoir enregistrer l'emplacement comme candidat.
  state.derniereSimulation = {
    lat, lon, rayon: R, caMin, caMax, pop: popCouverte,
    partMarche, indice: e.indice,
  };
  document.getElementById('btn-garder').classList.remove('hidden');

  const el = document.getElementById('simu-result');
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3>Résultat de la simulation</h3>
    Population dans la zone (pondérée) : <b>~${fmtInt(popCouverte)} hab.</b><br>
    Clientèle régulière (sans lave-linge) : <b>~${fmtInt(menagesReguliers)} ménages</b><br>
    Clientèle ponctuelle (gros volumes) : <b>~${fmtInt(menagesPonctuels)} ménages</b><br>
    Part de marché estimée : <b>${Math.round(partMarche * 100)} %</b>
    → <b>${fmtInt(regCaptes)}</b> réguliers + <b>${fmtInt(ponCaptes)}</b> ponctuels captés<br>
    <br><b>Concurrence dans la zone :</b><br>${listeConc}<br><br>
    CA potentiel annuel : <span class="ca">${fmtEur(caMin)} – ${fmtEur(caMax)}</span><br>
    ${e.depasseCapacite ? `<span style="color:#38bdf8;font-size:0.76rem">
      ⓘ Plafonné à la capacité d'une laverie de grand format
      (${e.plafond.toLocaleString('fr-FR')} €). La demande de la zone en supporterait
      <b>${e.laveriesPortables.toFixed(1)}</b> — un très grand local ou deux
      implantations sont envisageables.</span><br>` : ''}
    Résultat net indicatif (${margeMin}–${margeMax} % du CA) : ${fmtEur(caMin * margeMin / 100)} – ${fmtEur(caMax * margeMax / 100)}
    <div class="verdict ${verdictCls}">${verdictTxt}</div>
    ${blocExploitation((caMin + caMax) / 2)}
    <p class="hint">Modèle de Huff pondéré par l'attractivité, rayon ${R} m, demande étalée par quartier. Les hypothèses sont dans data/benchmarks.json.</p>`;
}

// ---------- COMPTE D'EXPLOITATION PRÉVISIONNEL ----------
//
// Le CA seul ne dit pas si un emplacement est finançable. On déroule donc le
// P&L complet du dossier de marché : cycles impliqués, coûts variables, charges
// fixes poste par poste, résultat net, point mort et retour sur investissement.
//
// Le loyer est isolé des autres charges : c'est le seul poste qui dépend
// fortement de l'emplacement (300 € en rural, 1 800 € en centre-ville), donc
// celui que l'utilisateur doit pouvoir renseigner pour un local réel.
function compteExploitation(caAnnuel, opts = {}) {
  const b = state.benchmarks;
  const c = b.couts;
  const f = b.financement;

  const prixMoyenCycle = (b.prix.lavage_eur[0] + b.prix.lavage_eur[1]) / 2;
  const cycles = caAnnuel / prixMoyenCycle;
  const coutVariable = cycles * c.cout_variable_par_cycle_eur;
  const margeBrute = caAnnuel - coutVariable;

  // Charges fixes hors loyer : milieu de fourchette de chaque poste, avec
  // stress énergie optionnel (point de vigilance n°6 du dossier).
  const mid = ([a, z]) => (a + z) / 2;
  const cf = c.charges_fixes_mensuelles_eur;
  const stress = opts.stressEnergie ? 1.3 : 1;
  const postes = {
    'Électricité / gaz': mid(cf.electricite_gaz) * stress,
    'Eau': mid(cf.eau) * stress,
    'Maintenance': mid(cf.maintenance),
    'Produits lessiviels': mid(cf.produits_lessiviels),
    'Assurance': mid(cf.assurance),
  };
  const loyerMensuel = opts.loyer != null ? opts.loyer : mid(cf.loyer);
  const autresMensuel = Object.values(postes).reduce((s, x) => s + x, 0);
  const chargesFixesAnnuelles = (loyerMensuel + autresMensuel) * 12;

  const resultatNet = margeBrute - chargesFixesAnnuelles;
  const margeNettePct = caAnnuel > 0 ? (resultatNet / caAnnuel) * 100 : 0;

  // Point mort : charges fixes ÷ marge unitaire réelle (et non les 1,75 €
  // du dossier, incohérents avec ses propres 78-85 % de marge brute).
  const margeParCycle = prixMoyenCycle - c.cout_variable_par_cycle_eur;
  const cyclesPointMort = (loyerMensuel + autresMensuel) / margeParCycle;

  const investissement = mid(f.investissement_initial_eur);
  const roiAnnees = resultatNet > 0 ? investissement / resultatNet : null;

  return {
    caAnnuel, cycles, cyclesMois: cycles / 12, prixMoyenCycle,
    coutVariable, margeBrute, postes, loyerMensuel,
    chargesFixesMensuelles: loyerMensuel + autresMensuel,
    chargesFixesAnnuelles, resultatNet, margeNettePct,
    margeParCycle, cyclesPointMort, cyclesPointMortJour: cyclesPointMort / 30,
    investissement, roiAnnees,
    // Repères du dossier pour situer le résultat
    margeNetteAttendue: b.exploitation.marge_nette_pct,
    roiAttendu: f.roi_annees,
  };
}

function blocExploitation(ca) {
  const x = compteExploitation(ca, {
    loyer: state.hyp.loyer,
    stressEnergie: state.hyp.stressEnergie,
  });
  const [mnMin, mnMax] = x.margeNetteAttendue;
  const [roiMin, roiMax] = x.roiAttendu;

  // Trois cas distincts : sous les repères, dedans, ou AU-DESSUS. Un résultat
  // meilleur que le secteur n'est pas une bonne nouvelle à ce stade — c'est le
  // signe que le CA modélisé est probablement surestimé.
  const dedansMarge = x.margeNettePct >= mnMin && x.margeNettePct <= mnMax;
  const dedansRoi = x.roiAnnees != null && x.roiAnnees >= roiMin && x.roiAnnees <= roiMax;
  const auDessus = x.margeNettePct > mnMax || (x.roiAnnees != null && x.roiAnnees < roiMin);

  let couleur, verdict;
  if (x.resultatNet <= 0) {
    couleur = '#dc2626';
    verdict = '❌ Exploitation déficitaire à ce niveau de CA';
  } else if (dedansMarge && dedansRoi) {
    couleur = '#16a34a';
    verdict = `✅ Conforme aux repères du secteur (marge ${mnMin}–${mnMax} %, retour ${roiMin}–${roiMax} ans)`;
  } else if (auDessus) {
    couleur = '#eab308';
    verdict = `⚠ Meilleur que les repères du secteur (marge ${x.margeNettePct.toFixed(0)} % contre `
      + `${mnMin}–${mnMax} % attendus). À ce stade c'est un signal d'alerte, pas une bonne nouvelle : `
      + `le CA modélisé est probablement surestimé — voir le contrôle de fiabilité.`;
  } else {
    couleur = '#eab308';
    verdict = `🟡 Sous les repères du secteur (marge attendue ${mnMin}–${mnMax} %, `
      + `retour ${roiMin}–${roiMax} ans)`;
  }

  const lignesPostes = Object.entries(x.postes)
    .map(([n, v]) => `<tr><td>− ${n}</td><td class="ca">−${fmtEur(v * 12)}</td></tr>`).join('');

  return `
    <details class="expl">
      <summary>📊 Compte d'exploitation prévisionnel</summary>
      <table class="tab-pl">
        <tr><td>Chiffre d'affaires</td><td class="ca"><b>${fmtEur(x.caAnnuel)}</b></td></tr>
        <tr class="sous"><td>soit ~${fmtInt(x.cyclesMois)} cycles/mois à ${x.prixMoyenCycle.toFixed(2)} €</td><td></td></tr>
        <tr><td>− Coûts variables (${state.benchmarks.couts.cout_variable_par_cycle_eur} €/cycle)</td>
            <td class="ca">−${fmtEur(x.coutVariable)}</td></tr>
        <tr class="total"><td>= Marge brute</td><td class="ca">${fmtEur(x.margeBrute)}</td></tr>
        <tr><td>− Loyer</td><td class="ca">−${fmtEur(x.loyerMensuel * 12)}</td></tr>
        ${lignesPostes}
        <tr class="total"><td>= Résultat net</td>
            <td class="ca" style="color:${couleur}"><b>${fmtEur(x.resultatNet)}</b></td></tr>
        <tr class="sous"><td>marge nette</td><td>${x.margeNettePct.toFixed(0)} %</td></tr>
      </table>
      <table class="tab-pl" style="margin-top:8px">
        <tr><td>Point mort</td><td class="ca">${fmtInt(x.cyclesPointMort)} cycles/mois
            (${x.cyclesPointMortJour.toFixed(0)}/jour)</td></tr>
        <tr><td>Investissement retenu</td><td class="ca">${fmtEur(x.investissement)}</td></tr>
        <tr><td>Retour sur investissement</td><td class="ca">${
          x.roiAnnees != null ? x.roiAnnees.toFixed(1) + ' ans' : '—'}</td></tr>
      </table>
      <div class="verdict-pl" style="border-left-color:${couleur}">${verdict}</div>
      <p class="hint">${state.benchmarks.financement.point_mort_reference.bfr_demarrage}</p>
    </details>`;
}

// ---------- CONTRÔLE DE FIABILITÉ DU MODÈLE ----------
//
// Un modèle qui ne sait pas expliquer les laveries DÉJÀ là n'a aucune raison de
// bien prédire les emplacements futurs. On le confronte donc à la seule mesure
// de fréquentation dont on dispose : le nombre d'avis Google, proxy imparfait
// mais indépendant du modèle.
//
// La comparaison se fait en rangs (Spearman) et non en valeurs : on ne cherche
// pas à prédire un CA, seulement à vérifier que le classement va dans le bon sens.
function correlationRangs(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const rangs = (v) => {
    const ordre = v.map((x, i) => i).sort((i, j) => v[i] - v[j]);
    const r = new Array(n);
    ordre.forEach((i, k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rangs(a), rb = rangs(b);
  const d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function controleFiabilite() {
  const publiques = laveriesCommune().filter(l => l.type !== 'captif' && l.nb_avis != null);
  if (publiques.length < 3) return null;
  const coef = coefficientCalibrage();
  const lignes = publiques.map(l => {
    const e = caBrut(l.lat, l.lon, RAYON_TENSION, l);
    return { nom: l.nom, ca: ((e.caMin + e.caMax) / 2) * coef, avis: l.nb_avis };
  });
  const rho = correlationRangs(lignes.map(x => x.ca), lignes.map(x => x.avis));
  return {
    lignes: lignes.sort((a, b) => b.ca - a.ca),
    rho,
    verdict: rho >= 0.6 ? 'bon' : rho >= 0.2 ? 'faible' : 'nul',
  };
}

const VERDICT_FIABILITE = {
  bon: ['✅ Le modèle suit la fréquentation observée',
        'Les zones proposées reposent sur une mécanique qui explique déjà l\'existant.', '#16a34a'],
  faible: ['🟡 Lien ténu avec la fréquentation observée',
           'Le classement des zones est à prendre comme une piste, pas comme un résultat.', '#eab308'],
  nul: ['❌ Le modèle ne reproduit PAS la fréquentation observée',
        'Il ne parvient pas à expliquer les laveries déjà en place. Le classement des zones et la '
        + 'heatmap sont à considérer comme des hypothèses de travail, non comme une aide à la '
        + 'décision. Cause la plus probable : les populations par quartier sont estimées et mal '
        + 'localisées. Correctif : import du carroyage INSEE 200 m.', '#dc2626'],
};

function dessinerFiabilite() {
  const zone = document.getElementById('fiabilite');
  if (!zone) return;
  const f = controleFiabilite();
  if (!f) { zone.innerHTML = '<p class="hint">Pas assez de laveries notées pour tester.</p>'; return; }
  const [titre, texte, couleur] = VERDICT_FIABILITE[f.verdict];
  zone.innerHTML = `
    <div class="encart" style="border-left-color:${couleur};margin-top:0">
      <b style="color:${couleur}">${titre}</b><br>
      Corrélation de rang entre CA modélisé et nombre d'avis :
      <b>${f.rho >= 0 ? '+' : ''}${f.rho.toFixed(2)}</b><br>${texte}
    </div>
    <table class="tab-fiabilite" style="margin-top:8px">
      <thead><tr><th>Laverie existante</th><th>CA modélisé</th><th>Avis</th></tr></thead>
      <tbody>${f.lignes.map(l => `<tr><td>${l.nom}</td>
        <td class="ca">${fmtEur(l.ca)}</td><td>${l.avis}</td></tr>`).join('')}</tbody>
    </table>
    <p class="hint">Le nombre d'avis est un proxy imparfait de la fréquentation, mais il a
    l'avantage d'être indépendant du modèle. Si les deux colonnes ne vont pas dans le
    même sens, le modèle décrit mal le terrain.</p>`;
}

// ---------- HEATMAP DU POTENTIEL ----------
//
// Une surface continue plutôt que 15 pastilles de quartier : on évalue le modèle
// sur une grille et on peint chaque maille. C'est la lecture qu'attend un
// investisseur — où sont les zones chaudes, sans se soucier des frontières
// administratives.
//
// Échelle DIVERGENTE et non séquentielle : la valeur a un point de bascule
// significatif (indice 1 = aussi bien qu'une laverie moyenne de Pessac). Bleu en
// dessous, gris au seuil, rouge au-dessus. Jamais d'arc-en-ciel : les teintes
// n'auraient plus d'ordre lisible.
const PALETTE_POTENTIEL = [
  { seuil: 0.60, couleur: [28, 92, 171],  libelle: 'Très en dessous' },
  { seuil: 0.85, couleur: [85, 152, 231], libelle: 'En dessous' },
  { seuil: 1.05, couleur: [110, 110, 105], libelle: 'Au niveau du marché local' },
  { seuil: 1.40, couleur: [230, 103, 103], libelle: 'Au-dessus' },
  { seuil: Infinity, couleur: [208, 59, 59], libelle: 'Nettement au-dessus' },
];

function couleurPotentiel(indice) {
  for (const p of PALETTE_POTENTIEL) if (indice < p.seuil) return p.couleur;
  return PALETTE_POTENTIEL[PALETTE_POTENTIEL.length - 1].couleur;
}

const GRILLE_PAS_M = 140;   // résolution de la maille

function dessinerHeatPotentiel() {
  if (state.layers.potentiel) {
    map.removeLayer(state.layers.potentiel);
    state.layers.potentiel = null;
  }
  if (!document.getElementById('l-heat-potentiel')?.checked) return;

  // Emprise : les quartiers connus, élargis d'une marge.
  const lats = state.quartiers.map(q => q.lat);
  const lons = state.quartiers.map(q => q.lon);
  const marge = 0.012;
  const sud = Math.min(...lats) - marge, nord = Math.max(...lats) + marge;
  const ouest = Math.min(...lons) - marge, est = Math.max(...lons) + marge;

  const pasLat = GRILLE_PAS_M / 111320;
  const pasLon = GRILLE_PAS_M / (111320 * Math.cos(((sud + nord) / 2) * Math.PI / 180));
  const nY = Math.ceil((nord - sud) / pasLat);
  const nX = Math.ceil((est - ouest) / pasLon);

  const canvas = document.createElement('canvas');
  canvas.width = nX; canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(nX, nY);
  const R = state.rayon;

  for (let y = 0; y < nY; y++) {
    // L'image se dessine du haut (nord) vers le bas.
    const lat = nord - y * pasLat;
    for (let x = 0; x < nX; x++) {
      const lon = ouest + x * pasLon;
      const e = estimerCA(lat, lon, R);
      const i = (y * nX + x) * 4;
      // Hors de toute demande, on laisse transparent plutôt que d'afficher
      // un « très en dessous » qui n'aurait aucun sens (forêt, vignes).
      if (e.pop < 150) { img.data[i + 3] = 0; continue; }
      const [r, g, b] = couleurPotentiel(e.indice);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
      img.data[i + 3] = 190;
    }
  }
  ctx.putImageData(img, 0, 0);

  state.layers.potentiel = L.imageOverlay(canvas.toDataURL(),
    [[sud, ouest], [nord, est]], { opacity: 0.75, interactive: false, zIndex: 250 });
  state.layers.potentiel.addTo(map);
  state.layers.potentiel.bringToFront?.();
}

// ---------- HEATMAP DE LA DEMANDE CAPTIVE ----------
//
// Là où la heatmap du potentiel répond « où implanter ? », celle-ci répond
// « d'où vient la demande ? ». Elle rend visibles les résidences étudiantes et
// les ensembles de logement social — les concentrations de ménages sans
// lave-linge, invisibles sur un fond de carte ordinaire.
const COULEUR_GENERATEUR = {
  residence_etudiante: '#eda100',
  logement_social: '#e87ba4',
  hebergement_tourisme: '#1baf7a',
};

// Rayon d'influence d'un bâtiment : au-delà, ses habitants ne sont plus « sur
// place ». Volontairement court — c'est la densité bâtie qu'on veut voir.
const RAYON_DENSITE_M = 320;
const GRILLE_DENSITE_M = 60;

// Densité de ménages sans lave-linge en un point, tous bâtiments confondus.
// C'est l'agrégation qui compte : cinq immeubles voisins doivent former UNE
// zone chaude, pas cinq pastilles côte à côte.
function densiteDemande(lat, lon) {
  let d = 0;
  for (const g of state.generateurs || []) {
    if (g.exclu) continue;
    const w = couverture(distanceM(lat, lon, g.lat, g.lon), RAYON_DENSITE_M);
    if (w < 0.03) continue;
    d += menagesGenerateur(g).reguliers * w;
  }
  return d;
}

// Échelle SÉQUENTIELLE (une seule teinte, intensité croissante) : la densité est
// une magnitude sans point de bascule. L'orange la distingue de la heatmap du
// potentiel, qui est divergente bleu-rouge.
const PALIERS_DENSITE = [15, 40, 90, 180, 320];

function dessinerDemandeCaptive() {
  state.layers.demande.clearLayers();
  if (state.layers.demandeSurface) {
    map.removeLayer(state.layers.demandeSurface);
    state.layers.demandeSurface = null;
  }
  if (!document.getElementById('l-heat-demande')?.checked) return;

  const gens = (state.generateurs || []).filter(g => !g.exclu);
  if (!gens.length) return;

  const marge = 0.006;
  const sud = Math.min(...gens.map(g => g.lat)) - marge;
  const nord = Math.max(...gens.map(g => g.lat)) + marge;
  const ouest = Math.min(...gens.map(g => g.lon)) - marge;
  const est = Math.max(...gens.map(g => g.lon)) + marge;

  const pasLat = GRILLE_DENSITE_M / 111320;
  const pasLon = GRILLE_DENSITE_M / (111320 * Math.cos(((sud + nord) / 2) * Math.PI / 180));
  const nY = Math.ceil((nord - sud) / pasLat);
  const nX = Math.ceil((est - ouest) / pasLon);

  const canvas = document.createElement('canvas');
  canvas.width = nX; canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(nX, nY);

  for (let y = 0; y < nY; y++) {
    const lat = nord - y * pasLat;
    for (let x = 0; x < nX; x++) {
      const d = densiteDemande(lat, ouest + x * pasLon);
      const i = (y * nX + x) * 4;
      if (d < PALIERS_DENSITE[0]) { img.data[i + 3] = 0; continue; }
      let niveau = 0;
      while (niveau < PALIERS_DENSITE.length - 1 && d >= PALIERS_DENSITE[niveau + 1]) niveau++;
      const t = niveau / (PALIERS_DENSITE.length - 1);
      // Orange qui s'intensifie : clair et transparent en périphérie, saturé au cœur.
      img.data[i] = 245 - t * 30;
      img.data[i + 1] = 190 - t * 110;
      img.data[i + 2] = 90 - t * 60;
      img.data[i + 3] = 60 + t * 145;
    }
  }
  ctx.putImageData(img, 0, 0);
  state.layers.demandeSurface = L.imageOverlay(canvas.toDataURL(),
    [[sud, ouest], [nord, est]], { opacity: 0.8, interactive: false, zIndex: 240 }).addTo(map);

  // Repères cliquables par-dessus la surface, pour accéder au détail bâtiment.
  for (const g of gens) {
    const m = menagesGenerateur(g);
    L.circleMarker([g.lat, g.lon], {
      radius: 4, color: '#fff', weight: 1,
      fillColor: COULEUR_GENERATEUR[g.type] || '#94a3b8', fillOpacity: 1,
    }).bindPopup(popupGenerateur(g, m), { maxWidth: 300 })
      .on('popupopen', (e) => brancherEditionGenerateur(e.popup))
      .addTo(state.layers.demande);
  }
}

// Les popups Leaflet sont recréés à chaque ouverture : on branche les champs
// d'édition à l'ouverture plutôt qu'à la construction.
function brancherEditionGenerateur(popup) {
  const el = popup.getElement?.();
  if (!el) return;
  const champ = el.querySelector('input[data-gen]');
  if (champ) {
    champ.addEventListener('change', () => {
      const g = state.generateurs.find(x => x.id === champ.dataset.gen);
      if (!g) return;
      g.logements = Math.max(0, Number(champ.value) || 0);
      g.logements_source = 'saisi à la main';
      state._pointsDemande = null; state._indexDemande = null;    // la demande doit être recalculée
      state.modifie = true;
      map.closePopup();
      rafraichir();
    });
  }
  const btn = el.querySelector('button[data-excl]');
  if (btn) {
    btn.addEventListener('click', () => {
      const g = state.generateurs.find(x => x.id === btn.dataset.excl);
      if (!g) return;
      g.exclu = true;
      state._pointsDemande = null; state._indexDemande = null;
      state.modifie = true;
      map.closePopup();
      rafraichir();
    });
  }
}

function popupGenerateur(g, m) {
  const couleur = COULEUR_GENERATEUR[g.type] || '#94a3b8';
  return `<div class="popup">
      <span class="tag" style="background:${couleur}">${
        state.profilsGenerateurs?.[g.type]?.libelle || g.type}</span>
      <h3>${g.nom}</h3>
      <table>
        <tr><td>Adresse</td><td>${g.adresse}</td></tr>
        <tr><td>Ménages sans lave-linge</td><td><b>~${fmtInt(m.reguliers)}</b>
          (${Math.round(g.part_sans_lave_linge * 100)} % de ${fmtInt(g.logements)} logements)</td></tr>
      </table>
      <div class="edit-gen">
        <label>Nombre réel de logements</label>
        <input type="number" min="0" value="${g.logements}" data-gen="${g.id}">
        <button data-excl="${g.id}">Ce n'est pas un logement — retirer</button>
      </div>
      <p class="warn">Le nombre de logements n'est pas fourni par Google : c'est une
      valeur par défaut selon le type. Corrigez-la ici (CROUS, bailleur, comptage
      des balcons sur Street View) — la position, elle, est exacte.</p>
    </div>`;
}

// ---------- localiser un local précis ----------

// Extrait des coordonnées d'un lien Google Maps ou d'une saisie « lat, lon ».
// On évite volontairement d'appeler un géocodeur : cela imposerait d'embarquer
// une clé API dans le fichier HTML distribué, donc de l'exposer.
function extraireCoordonnees(texte) {
  const t = (texte || '').trim();
  if (!t) return null;

  // Liens Google Maps : .../@44.7911,-0.6325,17z  ou  !3d44.7911!4d-0.6325
  const motifs = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /[?&]query=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /^(-?\d+[.,]?\d*)\s*[,;]\s*(-?\d+[.,]?\d*)$/,
  ];
  for (const m of motifs) {
    const r = t.match(m);
    if (r) {
      const lat = parseFloat(r[1].replace(',', '.'));
      const lon = parseFloat(r[2].replace(',', '.'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  }
  return null;
}

function allerAAdresse() {
  const champ = document.getElementById('adresse-input');
  const err = document.getElementById('adresse-erreur');
  const c = extraireCoordonnees(champ.value);
  if (!c) {
    err.textContent = "Format non reconnu. Sur Google Maps, faites un clic droit sur le "
      + "local puis « Copier les coordonnées », ou collez l'URL de la page.";
    return;
  }
  if (c.lat < 44.6 || c.lat > 45.0 || c.lon < -0.9 || c.lon > -0.4) {
    err.textContent = "Ce point est hors de la zone d'étude (Bordeaux Métropole).";
    return;
  }
  err.textContent = '';
  map.flyTo([c.lat, c.lon], 16, { duration: 0.8 });
  simuler(c.lat, c.lon);
}

// ---------- emplacements candidats ----------

function garderCandidat() {
  const d = state.derniereSimulation;
  if (!d) return;
  const nom = prompt('Nom de cet emplacement :',
    `Candidat ${state.candidats.length + 1}`);
  if (nom === null) return;
  state.candidats.push({
    nom: nom.trim() || `Candidat ${state.candidats.length + 1}`,
    lat: d.lat, lon: d.lon, rayon: d.rayon,
    caMin: d.caMin, caMax: d.caMax, pop: d.pop,
    partMarche: d.partMarche, indice: d.indice,
  });
  state.modifie = true;
  dessinerCandidats();
  majBarreExport();
}

function couleurIndice(i) {
  return i >= 1 ? '#16a34a' : i >= 0.6 ? '#eab308' : '#dc2626';
}

function dessinerCandidats() {
  const zone = document.getElementById('candidats-tableau');
  const vide = document.getElementById('candidats-vide');
  document.getElementById('candidats-count').textContent =
    state.candidats.length || '';
  state.layers.candidats.clearLayers();

  if (!state.candidats.length) {
    zone.innerHTML = '';
    vide.classList.remove('hidden');
    return;
  }
  vide.classList.add('hidden');

  // Classés par CA médian décroissant : le meilleur en haut.
  const tries = [...state.candidats]
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => (b.caMin + b.caMax) - (a.caMin + a.caMax));

  zone.innerHTML = `<table class="tab-candidats">
    <thead><tr><th>Emplacement</th><th>CA potentiel</th><th>Part</th><th></th></tr></thead>
    <tbody>${tries.map(c => `
      <tr data-i="${c.i}">
        <td><span class="pastille" style="background:${couleurIndice(c.indice)}"></span>
          <span class="nom-cand">${c.nom}</span>
          <span class="sous">${fmtInt(c.pop)} hab. · indice ${c.indice.toFixed(2)}</span></td>
        <td class="ca">${fmtEur(c.caMin)}<span class="sous">à ${fmtEur(c.caMax)}</span></td>
        <td>${Math.round(c.partMarche * 100)} %</td>
        <td><button class="sup" data-sup="${c.i}" title="Retirer">✕</button></td>
      </tr>`).join('')}</tbody></table>`;

  for (const tr of zone.querySelectorAll('tr[data-i]')) {
    tr.addEventListener('click', (e) => {
      if (e.target.dataset.sup !== undefined) return;
      const c = state.candidats[Number(tr.dataset.i)];
      map.flyTo([c.lat, c.lon], 16, { duration: 0.8 });
      simuler(c.lat, c.lon);
    });
  }
  for (const b of zone.querySelectorAll('[data-sup]')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.candidats.splice(Number(b.dataset.sup), 1);
      state.modifie = true;
      dessinerCandidats();
    });
  }

  // Repères permanents sur la carte
  for (const c of state.candidats) {
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:${couleurIndice(c.indice)};color:#fff;border:2px solid #fff;
               border-radius:4px;padding:2px 6px;font-size:0.68rem;font-weight:700;
               white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)">${c.nom}</div>`,
        iconAnchor: [0, 28],
      }),
    }).addTo(state.layers.candidats);
  }
}

// ---------- UI ----------

function initUI() {
  document.getElementById('fiche-fermer').addEventListener('click', fermerFiche);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerFiche(); });
  document.getElementById('btn-export').addEventListener('click', exporterDonnees);
  window.addEventListener('beforeunload', (e) => {
    if (state.modifie) { e.preventDefault(); e.returnValue = ''; }
  });

  for (const id of ['f-chaine', 'f-independant', 'f-captif', 'f-voisines', 'l-couverture',
                    'l-heat-offre', 'l-heat-potentiel',
                    'l-heat-demande', 'l-tension']) {
    document.getElementById(id).addEventListener('change', rafraichir);
  }
  const slider = document.getElementById('rayon');
  slider.addEventListener('input', () => {
    state.rayon = parseInt(slider.value, 10);
    document.getElementById('rayon-val').textContent = state.rayon;
    dessinerCouverture();
    dessinerHeatPotentiel();
  dessinerDemandeCaptive();
  });

  // Localiser un local précis
  document.getElementById('btn-aller').addEventListener('click', allerAAdresse);
  document.getElementById('adresse-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') allerAAdresse();
  });
  document.getElementById('btn-garder').addEventListener('click', garderCandidat);

  // Hypothèses ajustables : tout recalculer à chaque mouvement
  const hyps = [
    ['h-depense', 'h-depense-val', v => { state.hyp.depenseMediane = v; return fmtInt(v); }],
    ['h-demande', 'h-demande-val', v => { state.hyp.facteurDemande = v / 100; return v; }],
    ['h-caref', 'h-caref-val', v => { state.hyp.caReference = v; return fmtInt(v); }],
    ['h-loyer', 'h-loyer-val', v => { state.hyp.loyer = v; return fmtInt(v); }],
  ];
  for (const [id, idVal, appliquer] of hyps) {
    const s = document.getElementById(id);
    s.addEventListener('input', () => {
      document.getElementById(idVal).textContent = appliquer(Number(s.value));
      document.getElementById('btn-reset-hyp').classList.remove('hidden');
      rafraichir();
      if (state.derniereSimulation) {
        const d = state.derniereSimulation;
        simuler(d.lat, d.lon);
      }
    });
  }
  document.getElementById('h-energie').addEventListener('change', (e) => {
    state.hyp.stressEnergie = e.target.checked;
    document.getElementById('btn-reset-hyp').classList.remove('hidden');
    if (state.derniereSimulation) simuler(state.derniereSimulation.lat, state.derniereSimulation.lon);
  });

  document.getElementById('btn-reset-hyp').addEventListener('click', () => {
    state.hyp = { depenseMediane: null, facteurDemande: 1, caReference: null, poidsCaptif: 0.4, loyer: null, stressEnergie: false };
    const [dMin, dMax] = state.benchmarks.demande.clientele_reguliere.depense_annuelle_eur;
    const [cMin, cMax] = state.benchmarks.exploitation.ca_annuel_laverie_eur;
    document.getElementById('h-depense').value = (dMin + dMax) / 2;
    document.getElementById('h-depense-val').textContent = fmtInt((dMin + dMax) / 2);
    document.getElementById('h-demande').value = 100;
    document.getElementById('h-demande-val').textContent = 100;
    document.getElementById('h-caref').value = (cMin + cMax) / 2;
    document.getElementById('h-caref-val').textContent = fmtInt((cMin + cMax) / 2);
    document.getElementById('h-loyer').value = 1050;
    document.getElementById('h-loyer-val').textContent = fmtInt(1050);
    document.getElementById('h-energie').checked = false;
    document.getElementById('btn-reset-hyp').classList.add('hidden');
    rafraichir();
    if (state.derniereSimulation) simuler(state.derniereSimulation.lat, state.derniereSimulation.lon);
  });

  const btn = document.getElementById('btn-simu');
  btn.addEventListener('click', () => {
    state.simulation = !state.simulation;
    btn.classList.toggle('active', state.simulation);
    btn.textContent = state.simulation ? '🎯 Cliquez sur la carte… (cliquer ici pour quitter)' : '📍 Activer le mode simulation';
    if (!state.simulation) {
      state.layers.simulation.clearLayers();
      document.getElementById('simu-result').classList.add('hidden');
    }
  });

  const b = state.benchmarks;
  document.getElementById('benchmarks').innerHTML = `
    Lavage : <b>${b.prix.lavage_eur[0]}–${b.prix.lavage_eur[1]} €</b> ·
    séchage : <b>${b.prix.sechage_eur[0]}–${b.prix.sechage_eur[1]} €</b><br>
    CA annuel type : <b>${fmtEur(b.exploitation.ca_annuel_laverie_eur[0])} – ${fmtEur(b.exploitation.ca_annuel_laverie_eur[1])}</b>
    (jusqu'à ${fmtEur(b.exploitation.ca_annuel_fourchette_large_eur[1])} en très bon emplacement)<br>
    Marge nette : <b>${b.exploitation.marge_nette_pct[0]}–${b.exploitation.marge_nette_pct[1]} %</b> ·
    Invest. : <b>${fmtEur(b.exploitation.investissement_initial_eur[0])} – ${fmtEur(b.exploitation.investissement_initial_eur[1])}</b><br>
    Machines : <b>${b.exploitation.nb_machines_typique[0]}–${b.exploitation.nb_machines_typique[1]}</b> ·
    Surface : <b>${b.exploitation.surface_typique_m2[0]}–${b.exploitation.surface_typique_m2[1]} m²</b><br>
    <span style="color:#fbbf24">${b.exploitation.besoin_electrique}</span>`;
}

charger().catch(err => {
  document.getElementById('map').innerHTML =
    '<p style="padding:2rem">Erreur de chargement des données : ' + err.message +
    '.<br>Lancez l\'app via un serveur local : <code>python3 -m http.server</code> puis http://localhost:8000</p>';
});
