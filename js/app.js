/* Laverie Mapper — Bordeaux Métropole
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
  // Périmètre d'étude : 'pessac' (analyse fine, quartier par quartier)
  // ou 'metropole' (les 28 communes — calibrage plus solide, maille plus
  // grossière). Tout le modèle suit : demande, concurrence, calibrage,
  // fiabilité, classement.
  // Le périmètre par défaut s'adapte à l'inventaire : tant que le balayage
  // métropole n'a pas été lancé, afficher les 28 communes donnerait une carte
  // creuse où les zones sans données paraîtraient attractives.
  perimetre: 'metropole',
  // Une seule surface d'analyse à la fois. Superposer une heatmap divergente,
  // une heatmap séquentielle et des pastilles colorées ne se lit pas : on force
  // le choix plutôt que de laisser l'utilisateur fabriquer une carte illisible.
  vue: 'potentiel',
  // Filtres d'AFFICHAGE des générateurs de demande. Ils ne touchent jamais le
  // modèle : masquer les résidences étudiantes ne fait pas disparaître leur
  // demande du calcul, seulement de la carte.
  genTypes: { residence_etudiante: true, logement_social: true, hebergement_tourisme: true },
  simulation: false,
  layers: {},
  candidats: [],
  // Hypothèses ajustables par l'utilisateur. null = valeur du secteur
  // (data/benchmarks.json). Les bouger permet de vérifier si le classement
  // résiste à l'incertitude, qui est ici la principale limite.
  hyp: { depenseMediane: null, facteurDemande: 1, caReference: null, poidsCaptif: 0.4, loyer: null, stressEnergie: false, porteeParking: 2.0 },
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

// PORTÉE D'UNE LAVERIE
//
// Le rayon piéton de 400-800 m ne vaut que pour une laverie de rue. Une laverie
// de centre commercial avec parking draine une clientèle motorisée, dont le
// dossier de marché situe le rayon à 5-10 minutes de voiture. Leur appliquer le
// même rayon revient à sous-estimer massivement les secondes.
//
// Réglable : c'est une hypothèse de mécanisme, pas une constante mesurée.
function rayonEffectif(l, R) {
  return l.acces && l.acces.parking ? R * state.hyp.porteeParking : R;
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
  const facultatif = (chemin) =>
    fetch(chemin).then(r => r.ok ? r.json() : null).catch(() => null);
  const [lav, qua, bench, gen, car, ent, bod, com] = window.__DATA__
    ? [window.__DATA__.laveries, window.__DATA__.quartiers,
       window.__DATA__.benchmarks, window.__DATA__.generateurs,
       window.__DATA__.carreaux, window.__DATA__.entreprises,
       window.__DATA__.bodacc, window.__DATA__.communes]
    : await Promise.all([
      fetch('data/laveries.json').then(r => r.json()),
      fetch('data/quartiers.json').then(r => r.json()),
      fetch('data/benchmarks.json').then(r => r.json()),
      fetch('data/generateurs.json').then(r => r.json()),
      // Facultatifs : absents tant que les imports n'ont pas été lancés.
      facultatif('data/carreaux.json'),
      facultatif('data/entreprises.json'),
      facultatif('data/bodacc.json'),
      fetch('data/communes.json').then(r => r.json()),
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
  state.communes = (com && com.communes) || [];
  state.entreprises = (ent && ent.etablissements) || null;
  state.metaEntreprises = (ent && ent.meta) || null;
  state.bodacc = bod || null;
  indexerEntreprises();
  // Le mode métropole n'a de sens qu'avec un inventaire qui couvre les 28
  // communes. Tant que le balayage n'a pas été lancé, on retombe sur Pessac
  // plutôt que d'afficher une carte creuse où le vide passerait pour une
  // opportunité.
  if (laveriesEtude().length < 40) state.perimetre = 'pessac';
  // 158 cercles de chalandise superposés ne montrent plus rien : à l'échelle
  // métropole, on ouvre sans, l'utilisateur les rallume quand il zoome.
  if (state.perimetre === 'metropole') {
    const c = document.getElementById('l-couverture');
    if (c) c.checked = false;
  }
  for (const b of document.querySelectorAll('[data-perimetre]')) {
    b.classList.toggle('actif', b.dataset.perimetre === state.perimetre);
  }
  initCarte();
  initUI();
  rafraichir();
}

// ---------- carte ----------

// Cadrage de départ par périmètre. Déclaré avant initCarte : un `const` n'est
// pas hissé, et la carte s'initialise bien avant la bascule de périmètre.
const VUES_CARTE = {
  pessac: { centre: [44.798, -0.640], zoom: 13 },
  metropole: { centre: [44.855, -0.590], zoom: 11 },
};

function initCarte() {
  const cadre = VUES_CARTE[state.perimetre] || VUES_CARTE.pessac;
  map = L.map('map').setView(cadre.centre, cadre.zoom);
  const tuiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  // Le fond de plan peut être injoignable : hors ligne, réseau d'entreprise, ou
  // page publiée qui interdit les requêtes externes. Sans explication, on croit
  // que l'application est cassée alors qu'elle fonctionne — seules les rues
  // manquent. On le dit, une fois, après quelques échecs.
  let echecsTuiles = 0;
  tuiles.on('tileerror', () => {
    if (++echecsTuiles !== 4) return;
    const el = document.getElementById('avis-fond');
    if (el) el.classList.remove('hidden');
  });

  state.layers.marqueurs = L.layerGroup().addTo(map);
  state.layers.couverture = L.layerGroup().addTo(map);
  state.layers.tension = L.layerGroup().addTo(map);
  state.layers.simulation = L.layerGroup().addTo(map);
  state.layers.candidats = L.layerGroup().addTo(map);
  state.layers.demande = L.layerGroup().addTo(map);
  state.layers.libelles = L.layerGroup().addTo(map);
  state.layers.heat = null;

  // Le résultat d'une simulation s'affiche dans l'onglet Analyse : on y bascule,
  // sinon un clic sur la carte semble ne rien produire.
  map.on('click', (e) => {
    if (!state.simulation) return;
    simuler(e.latlng.lat, e.latlng.lng);
    montrerSimulation();
  });

  // Les pins de bâtiments apparaissent en zoomant : on ne redessine que les
  // repères, pas la surface de densité, qui coûte 300 000 pixels à repeindre.
  let zoomPrecedent = map.getZoom();
  map.on('zoomend', () => {
    const z = map.getZoom();
    const franchi = (z < ZOOM_PINS) !== (zoomPrecedent < ZOOM_PINS);
    zoomPrecedent = z;
    if (franchi && state.vue === 'demande') { dessinerReperesDemande(); majLegendeZones(); }
  });
}

function typesActifs() {
  const actifs = [];
  if (document.getElementById('f-chaine').checked) actifs.push('chaine');
  if (document.getElementById('f-independant').checked) actifs.push('independant');
  if (document.getElementById('f-captif').checked) actifs.push('captif');
  return actifs;
}

// Laveries du périmètre étudié.
//
// En périmètre Pessac, les laveries des communes voisines comptent comme
// concurrentes dans le modèle mais sont écartées des statistiques, du calibrage
// et du contrôle de fiabilité. En périmètre métropole, elles font partie de
// l'étude à part entière — c'est tout l'intérêt du changement d'échelle : le
// calibrage passe d'une poignée d'établissements à quelques dizaines.
function laveriesEtude() {
  return state.laveries.filter(l => l.statut === 'actif'
    && (state.perimetre === 'metropole' || !l.hors_commune));
}

// Le sous-titre doit dire le périmètre RÉELLEMENT actif : afficher « 28
// communes » alors que l'analyse porte sur Pessac serait un contresens.
function majSousTitre() {
  const el = document.querySelector('.marque-txt span');
  if (!el) return;
  el.textContent = state.perimetre === 'metropole'
    ? 'Bordeaux Métropole · 28 communes'
    : 'Pessac (33600) · 15 quartiers';
}

function nomPerimetre() {
  return state.perimetre === 'metropole' ? 'la métropole' : 'Pessac';
}

// Zones d'analyse : les 15 quartiers de Pessac, ou les 28 communes.
// Une commune est une maille grossière — le diagnostic dit où regarder,
// pas où signer.
function zonesEtude() {
  if (state.perimetre !== 'metropole') return state.quartiers;
  return state.communes.map(c => ({
    ...c,
    commentaire: 'Maille communale : diagnostic indicatif, à affiner par quartier.',
  }));
}

function laveriesVisibles() {
  const types = typesActifs();
  const voisines = state.perimetre === 'metropole'
    || document.getElementById('f-voisines')?.checked;
  return state.laveries.filter(l => types.includes(l.type) && l.statut === 'actif'
                                 && (voisines || !l.hors_commune));
}

// Les zones de besoin sont recalculées à chaque rafraîchissement : leur verdict
// dépend de l'offre, donc des laveries et des hypothèses. La GRILLE de densité,
// elle, ne dépend que des bâtiments — coûteuse à construire, elle survit et
// n'est jetée que par invaliderGenerateurs().
function invaliderGenerateurs() {
  state._pointsDemande = null;
  state._indexDemande = null;
  state._grille = undefined;
  state._zones = undefined;
}

function rafraichir() {
  state._coefCal = null;   // le calibrage dépend des hypothèses courantes
  state._indexDemande = null;
  state._indexOffre = null;
  state._zones = undefined;
  dessinerMarqueurs();
  dessinerLibelles();
  dessinerListe();
  dessinerCouverture();
  dessinerTension();
  dessinerHeat();
  dessinerHeatPotentiel();
  dessinerDemandeCaptive();
  dessinerZonesBesoin();
  majSousTitre();
  dessinerFiabilite();
  dessinerMarcheReel();
  dessinerClassement();
  dessinerCandidats();
  majStats();
  majBarreExport();
}

// NOMS DE COMMUNES
//
// À l'échelle métropole, un point sur fond de carte ne dit pas dans quelle
// commune il se trouve — et si les tuiles ne se chargent pas (hors ligne, page
// publiée sans accès réseau), la carte devient totalement muette. Ces libellés
// la rendent lisible dans tous les cas.
function dessinerLibelles() {
  if (!state.layers.libelles) return;
  state.layers.libelles.clearLayers();
  if (state.perimetre !== 'metropole' || !state.communes) return;
  for (const c of state.communes) {
    L.marker([c.lat, c.lon], {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0],
        html: `<span class="etiquette-commune">${c.nom}</span>` }),
    }).addTo(state.layers.libelles);
  }
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

// IDENTITÉ D'ENTREPRISE
//
// Une laverie n'est pas qu'un point sur une carte : c'est une société, avec une
// date de création, un effectif et — quand elle dépose ses comptes — un chiffre
// d'affaires. C'est la seule information de cette fiche qui ne doive rien à un
// modèle ni à une estimation.
function blocEntreprise(l) {
  if (!state.entreprises) return '';
  const e = entrepriseDe(l);
  if (!e) {
    return `<div class="encart" style="border-left-color:#64748b">
      <b>Aucune société rapprochée</b><br>
      Aucun établissement SIRENE de laverie n'a été trouvé à cette adresse. Soit
      l'exploitation est portée par une société domiciliée ailleurs, soit le code
      d'activité déclaré n'est pas le 96.01B.</div>`;
  }

  const annee = (d) => (d ? Number(String(d).slice(0, 4)) : null);
  const naissance = annee(e.date_creation);
  const age = naissance ? new Date().getFullYear() - naissance : null;
  const effectif = e.effectif_min == null ? null
    : (e.effectif_min === 0 ? 'aucun salarié'
       : `${e.effectif_min}–${e.effectif_max ?? '+'} salariés`);

  let finances;
  if (!(e.finances || []).length) {
    finances = `<span style="color:#fbbf24">Comptes non publiés.</span> Depuis 2016 les
      petites sociétés peuvent demander la confidentialité de leur compte de résultat,
      et les entreprises individuelles ne déposent rien. L'absence de chiffre n'est
      pas un signal sur la santé de l'affaire.`;
  } else if (!e.ca_attribuable) {
    finances = `<span style="color:#fbbf24">CA publié mais non imputable à cette
      adresse :</span> la société exploite ${e.nb_etablissements_ouverts} établissements,
      le chiffre déposé est un cumul. Il n'est pas utilisé pour caler le modèle.`;
  } else {
    finances = `<table class="tab-pl" style="margin-top:4px">
      <tr><td>Exercice</td><td class="ca">CA</td><td class="ca">Résultat net</td></tr>
      ${e.finances.slice(0, 3).map(f => `<tr>
        <td>${f.annee}</td>
        <td class="ca"><b>${f.ca != null ? fmtEur(f.ca) : '—'}</b></td>
        <td class="ca" style="color:${(f.resultat_net ?? 0) >= 0 ? '#86efac' : '#fca5a5'}">${
          f.resultat_net != null ? fmtEur(f.resultat_net) : '—'}</td></tr>`).join('')}
    </table>`;
  }

  return `<div class="encart" style="border-left-color:#38bdf8">
      <b>${e.nom}</b>
      ${e.actif ? '' : ' <span style="color:#fca5a5">— radiée</span>'}<br>
      <span style="font-size:0.72rem">
        SIREN <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${e.siren}"
          target="_blank" rel="noopener" style="color:var(--accent)">${e.siren}</a>
        ${naissance ? ` · créée en ${naissance}${age ? ` (${age} ans)` : ''}` : ''}
        ${effectif ? ` · ${effectif}` : ''}
        ${e.rapprochement ? ` · rapproché par ${e.rapprochement}` : ''}
      </span>
      <div style="margin-top:6px">${finances}</div>
    </div>`;
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
      ${blocEntreprise(l)}
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
      <p class="note">Recopiez ce que vous lisez sur la fiche Google Maps.
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
  // L'inventaire liste TOUTES les laveries de la commune, indépendamment des
  // cases de l'onglet Carte : celles-ci ne pilotent que l'affichage sur la
  // carte. Une ligne grisée signale simplement « masquée sur la carte ».
  const toutes = state.laveries.filter(l => !l.hors_commune && l.statut === 'actif');
  const surCarte = new Set(laveriesVisibles().map(l => l.id));
  ul.innerHTML = toutes.map(l => {
    const note = l.note_google != null
      ? `${l.note_google}★${l.nb_avis != null ? `<br><span style="font-weight:400;font-size:0.62rem">${l.nb_avis} avis</span>` : ''}`
      : 'n.c.';
    const cible = estVulnerable(l)
      ? '<span class="meta" style="color:#f97316">🎯 cible : mal notée, zone à reprendre</span>' : '';
    return `<li data-id="${l.id}" class="${surCarte.has(l.id) ? '' : 'masquee'}">
      <span class="dot dot-${l.type}"></span>
      <span class="nom">${l.nom}<span class="meta">${l.quartier ?? 'quartier à définir'}</span>${cible}</span>
      <span class="note-pastille ${classeNote(l.note_google)}">${note}</span>
    </li>`;
  }).join('');

  document.getElementById('liste-count').textContent = toutes.length;

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
  if (state.vue !== 'offre') return;
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

// ANCRE DU MODÈLE. Par ordre de préséance :
//   1. la valeur choisie à la main dans l'onglet Modèle ;
//   2. le CA médian RÉELLEMENT PUBLIÉ par les laveries du secteur ;
//   3. à défaut, le milieu de la fourchette du dossier de marché.
// Le passage de 3 à 2 est ce qui fait basculer l'outil d'une convention à une
// mesure : tous les euros affichés en découlent.
function caReference() {
  if (state.hyp.caReference != null) return state.hyp.caReference;
  const obs = caObserve();
  if (obs) return obs.mediane;
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
  // Pas de facteurDemande ici : il est appliqué une seule fois, dans
  // demandeAccessible(). L'appliquer aussi à ce niveau le compterait deux fois —
  // et cette part est mise en cache dans pointsDemande(), donc figée.
  return (pMin + (pMax - pMin) * facteur) / 100;
}

// Étalement d'une commune entière (mode métropole sans carroyage).
//
// Une commune n'est pas un quartier : Bordeaux fait 49 km². Verser 40 % de ses
// 260 000 habitants sur le centroïde créerait une densité absurde (100 000
// habitants « à 800 m » d'un point). Le rayon suit donc la taille de la
// commune, et la population se répartit sur deux couronnes avec un centre
// léger.
function rayonCommune(c) {
  return Math.max(900, Math.min(3200, 700 * Math.sqrt(c.population / 10000)));
}

const CENTRE_COMMUNE = 0.12;

function etalerCommune(pts, c) {
  const rayon = rayonCommune(c);
  pts.push({ q: c, lat: c.lat, lon: c.lon, part: CENTRE_COMMUNE });
  const anneaux = [[rayon * 0.45, 8, 0.42], [rayon * 0.95, 12, 0.46]];
  for (const [r, n, poids] of anneaux) {
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.cos(c.lat * Math.PI / 180));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + r;     // décalage angulaire entre anneaux
      pts.push({ q: c, lat: c.lat + dLat * Math.sin(a),
                 lon: c.lon + dLon * Math.cos(a), part: poids / n });
    }
  }
}

// Communes hors de la couverture du carroyage importé : un ancien import limité
// à Pessac ne doit pas faire croire que le reste de la métropole est désert.
function communesHorsCarroyage() {
  if (!state.carreaux || !state.carreaux.length) return state.communes;
  const lats = state.carreaux.map(c => c.lat), lons = state.carreaux.map(c => c.lon);
  const boite = { sud: Math.min(...lats), nord: Math.max(...lats),
                  ouest: Math.min(...lons), est: Math.max(...lons) };
  return state.communes.filter(c =>
    c.lat < boite.sud || c.lat > boite.nord || c.lon < boite.ouest || c.lon > boite.est);
}

function pointsDemande() {
  if (state._pointsDemande) return state._pointsDemande;
  const pts = [];

  const metropole = state.perimetre === 'metropole';

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

    // Carroyage partiel (ex. importé du temps où l'emprise s'arrêtait à
    // Pessac) : les communes hors de sa boîte reçoivent le repli par centroïde,
    // avec un avertissement dans l'onglet Modèle plutôt qu'un désert silencieux.
    if (metropole) {
      const manquantes = communesHorsCarroyage();
      state.carroyagePartiel = manquantes.length > 0;
      for (const c of manquantes) etalerCommune(pts, c);
    }
    state._pointsDemande = pts;
    return pts;
  }

  // Sans carroyage, en mode métropole : quartiers fins pour Pessac, centroïdes
  // étalés pour les 27 autres communes. Pessac est exclue de la liste des
  // communes pour ne pas compter ses habitants deux fois.
  if (metropole) {
    state.carroyagePartiel = true;      // tout est estimé : à dire clairement
    for (const c of state.communes.filter(x => x.id !== 'pessac')) etalerCommune(pts, c);
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

// INDEX SPATIAL DE L'OFFRE.
//
// À l'échelle métropole, la heatmap évalue ~20 000 mailles et chacune parcourait
// les 153 laveries : trois millions de distances par repeinte. On range donc les
// laveries dans des cases d'un kilomètre et on ne visite que les cases utiles.
// Le résultat est strictement identique — seul le temps change.
const TAILLE_CASE_OFFRE_M = 1000;

// Au-delà de cette distance, le noyau gaussien passe sous le seuil de 0,01
// retenu par offreAccessible, même pour la laverie la plus attractive.
// exp(-(d/R)²) < 0,01/A avec A ≤ 2,5 donne d/R < 2,4 ; on prend 2,6 de marge.
const PORTEE_UTILE = 2.6;

function indexOffre() {
  if (state._indexOffre) return state._indexOffre;
  const cases = new Map();
  const dLat = TAILLE_CASE_OFFRE_M / 111320;
  let porteeMax = 1;
  for (const l of state.laveries) {
    if (l.statut !== 'actif') continue;
    if (l.acces && l.acces.parking) porteeMax = Math.max(porteeMax, state.hyp.porteeParking);
    const dLon = TAILLE_CASE_OFFRE_M / (111320 * Math.cos(l.lat * Math.PI / 180));
    const cle = Math.round(l.lat / dLat) + ':' + Math.round(l.lon / dLon);
    (cases.get(cle) || cases.set(cle, []).get(cle)).push(l);
  }
  state._indexOffre = { cases, dLat, porteeMax };
  return state._indexOffre;
}

function laveriesProches(lat, lon, R) {
  const { cases, dLat, porteeMax } = indexOffre();
  const dLon = TAILLE_CASE_OFFRE_M / (111320 * Math.cos(lat * Math.PI / 180));
  const portee = Math.ceil((R * porteeMax * PORTEE_UTILE) / TAILLE_CASE_OFFRE_M);
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

// Pression concurrentielle exercée sur un point par les laveries existantes.
function offreAccessible(lat, lon, R) {
  let pression = 0;
  const concurrents = [];
  // Toutes les laveries actives, communes voisines comprises : la demande
  // déborde de Pessac, la concurrence doit couvrir la même zone.
  for (const l of laveriesProches(lat, lon, R)) {
    const d = distanceM(lat, lon, l.lat, l.lon);
    const p = attractivite(l) * couverture(d, rayonEffectif(l, R));
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
  // Une laverie existante draine sur sa propre portée, pas sur le rayon d'affichage.
  const portee = laverieExistante ? rayonEffectif(laverieExistante, R) : R;
  const dem = demandeAccessible(lat, lon, portee);
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
  const publiques = laveriesEtude().filter(l => l.type !== 'captif');
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

// GARDE-FOU DU MODE MÉTROPOLE — inventaire incomplet.
//
// Une commune sans laverie recensée ressort mécaniquement rouge vif : pression
// concurrentielle nulle, indice au plafond. Or « aucune laverie dans nos
// données » ne veut pas dire « aucune laverie sur le terrain » tant que le
// balayage Google de la métropole n'a pas été lancé. Bordeaux affichait 2,40
// avec une pression de zéro en plein centre-ville — évidemment faux.
//
// Règle : d'après les benchmarks, une commune porte environ un établissement
// pour 8 000 à 15 000 habitants. Si l'inventaire en contient nettement moins,
// le diagnostic de la zone est déclaré NON ÉVALUABLE plutôt qu'attractif.
function inventaireInsuffisant(zone) {
  if (state.perimetre !== 'metropole') return false;
  const rayon = rayonCommune(zone) * 1.25;
  const recensees = state.laveries.filter(l => l.statut === 'actif'
    && l.type !== 'captif'
    && distanceM(zone.lat, zone.lon, l.lat, l.lon) <= rayon).length;
  // Attendu : un établissement pour ~10 000 habitants (milieu de fourchette).
  // On exige au moins 60 % de ce compte dans l'inventaire pour juger la zone :
  // en deçà, la « faible concurrence » est un artefact de données. Bordeaux
  // recensée à 8 laveries pour 260 000 habitants en attendrait ~26 : non
  // évaluable tant que le balayage métropole n'a pas tourné.
  const attendues = zone.population / 10000;
  return recensees < Math.max(1, Math.round(attendues * 0.6));
}

function couleurTension(i) {
  if (i < 0.6) return '#15803d';   // pas de place : marché déjà servi ou demande trop faible
  if (i < 1.0) return '#eab308';   // limite
  return '#dc2626';                // une nouvelle laverie atteindrait le seuil de viabilité
}

function dessinerTension() {
  state.layers.tension.clearLayers();
  if (state.vue !== 'quartiers') return;
  for (const q of zonesEtude()) {
    const t = tensionQuartier(q);
    const incomplet = inventaireInsuffisant(q);
    const label = incomplet ? 'Non évaluable : inventaire incomplet'
      : t.indice < 0.6 ? 'Pas de place pour une laverie'
      : (t.indice < 1.0 ? 'Zone limite' : 'Place pour une laverie');
    const couleur = incomplet ? '#64748b' : couleurTension(t.indice);
    L.circleMarker([q.lat, q.lon], {
      // Rayon borné : Bordeaux (260 000 hab.) ne doit pas manger la carte.
      radius: Math.min(28, Math.max(10, Math.sqrt(q.population) / 5)),
      color: couleur,
      weight: 2,
      dashArray: incomplet ? '5 6' : null,
      fillColor: couleur,
      fillOpacity: incomplet ? 0.12 : 0.30,
    }).bindPopup(`<div class="popup"><h3>${q.nom}</h3>
      <table>
      <tr><td>Population (est.)</td><td>${fmtInt(q.population)}</td></tr>
      <tr><td>Clientèle régulière accessible</td><td>~${fmtInt(t.reguliers)} ménages</td></tr>
      <tr><td>Concurrence en place</td><td>${t.pression.toFixed(2)} équiv. laverie → part de marché ${Math.round(t.partMarche * 100)} %</td></tr>
      <tr><td>CA d'une nouvelle laverie</td><td>${fmtEur(t.caMin)} – ${fmtEur(t.caMax)}<br>(référence secteur : ${fmtEur(caReference())})</td></tr>
      <tr><td>Diagnostic</td><td><strong>${label}</strong>${incomplet ? '' : ` (indice ${t.indice.toFixed(2)})`}</td></tr>
      </table>
      ${incomplet ? `<p class="warn">Cette commune n'a pas assez de laveries recensées
        pour son gabarit (${fmtInt(q.population)} hab.) : l'indice élevé mesure
        l'absence de données, pas une opportunité. Lancez
        <code>scripts/find_laveries_metropole.py</code> pour recenser l'offre réelle.</p>`
        : `<p class="warn">${q.commentaire ?? ''}</p>`}</div>`, { maxWidth: 320 })
      .addTo(state.layers.tension);
  }
}

// ---------- classement des zones d'implantation ----------

function dessinerClassement() {
  const ol = document.getElementById('classement');
  const evaluees = [], nonEvaluables = [];
  for (const q of zonesEtude()) {
    (inventaireInsuffisant(q) ? nonEvaluables : evaluees).push(q);
  }
  const toutes = evaluees
    .map(q => ({ q, t: tensionQuartier(q) }))
    .sort((a, b) => b.t.indice - a.t.indice);
  state._nonEvaluables = nonEvaluables;

  // Empreinte du classement complet : sert à mesurer l'effet réel d'un réglage
  // (voir afficherImpact). On la prend AVANT de tronquer à 6.
  state._empreinteAvant = state._empreinte;
  state._empreinte = {
    ordre: toutes.map(z => z.q.id),
    noms: Object.fromEntries(toutes.map(z => [z.q.id, z.q.nom])),
    ca: Object.fromEntries(toutes.map(z => [z.q.id, z.t.caMed])),
  };

  const zones = toutes.slice(0, 6);

  ol.innerHTML = zones.map(({ q, t }) => {
    const cls = t.indice >= 1 ? 'verdict bon' : (t.indice >= 0.6 ? 'verdict moyen' : 'verdict faible');
    return `<li data-id="${q.id}" style="border-left-color:${couleurTension(t.indice)}">
      <span class="z-nom">${q.nom}
        <span class="z-ca">CA potentiel ${fmtEur(t.caMin)} – ${fmtEur(t.caMax)}</span></span>
      <span class="z-ind ${cls}">${t.indice.toFixed(2)}</span>
    </li>`;
  }).join('')
  + (nonEvaluables.length ? `<li class="non-evaluable">⚠ ${nonEvaluables.length} commune${
      nonEvaluables.length > 1 ? 's' : ''} hors classement, inventaire trop incomplet pour
      juger : ${nonEvaluables.slice(0, 5).map(z => z.nom).join(', ')}${
      nonEvaluables.length > 5 ? '…' : ''}. Un indice élevé y mesurerait l'absence de
      données, pas une opportunité — lancez <code>find_laveries_metropole.py</code>.</li>` : '');

  for (const li of ol.querySelectorAll('li')) {
    li.addEventListener('click', () => {
      const q = zonesEtude().find(x => x.id === li.dataset.id);
      map.flyTo([q.lat, q.lon], 15, { duration: 0.8 });
      // On lance directement la simulation sur la zone pour éviter un aller-retour.
      state.simulation = true;
      const btn = document.getElementById('btn-simu');
      btn.classList.add('active');
      btn.textContent = '🎯 Cliquez sur la carte… (cliquer ici pour quitter)';
      simuler(q.lat, q.lon);
      montrerSimulation();
    });
  }
}

// ---------- statistiques ----------

function majStats() {
  // Les statistiques décrivent le marché, pas l'affichage : elles ne suivent
  // donc pas les cases de filtrage de la carte.
  const visibles = laveriesEtude();
  const grandPublic = visibles.filter(l => l.type !== 'captif');
  // Population du périmètre : mesurée (carroyage complet) quand on l'a,
  // sinon la somme des zones estimées.
  const pop = (state.perimetre === 'metropole' && state.metaCarreaux
               && !state.carroyagePartiel)
    ? state.metaCarreaux.population_totale
    : zonesEtude().reduce((s, q) => s + q.population, 0);
  document.getElementById('stat-count').textContent = visibles.length;
  document.getElementById('stat-open').textContent = grandPublic.length;
  document.getElementById('stat-pop').textContent = fmtInt(pop);
  const ratio = Math.round(pop / grandPublic.length);
  document.getElementById('stat-ratio').textContent = fmtInt(ratio);

  const titre = document.getElementById('marche-titre');
  if (titre) {
    titre.textContent = state.perimetre === 'metropole'
      ? 'Le marché de la métropole' : 'Le marché de Pessac';
  }

  const [bMin, bMax] = state.benchmarks.demande.habitants_par_laverie_zone_urbaine;
  let verdict;
  if (ratio > bMax) verdict = `⚠ ${fmtInt(ratio)} hab./laverie grand public : au-dessus de la fourchette benchmark (${fmtInt(bMin)}–${fmtInt(bMax)}). Le marché semble globalement SOUS-ÉQUIPÉ — regardez les quartiers rouges.`;
  else if (ratio < bMin) verdict = `${fmtInt(ratio)} hab./laverie : marché dense, cherchez les poches mal couvertes plutôt qu'une implantation frontale.`;
  else verdict = `${fmtInt(ratio)} hab./laverie : dans la fourchette benchmark (${fmtInt(bMin)}–${fmtInt(bMax)}). L'opportunité se joue quartier par quartier.`;
  if (state.perimetre === 'metropole' && state.carroyagePartiel) {
    verdict += ' ⚠ Population partiellement estimée : le carroyage INSEE importé ne '
      + 'couvre pas toute la métropole — relancez import_insee_carreaux.py '
      + '(la nouvelle emprise couvre les 28 communes).';
  }
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
    <p class="note">Modèle de Huff pondéré par l'attractivité, rayon ${R} m, demande étalée par quartier. Les hypothèses sont dans data/benchmarks.json.</p>`;
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
      <p class="note">${state.benchmarks.financement.point_mort_reference.bfr_demarrage}</p>
    </details>`;
}

// ---------- DONNÉES D'ENTREPRISE : SIRENE, COMPTES ANNUELS, BODACC ----------
//
// Jusqu'ici le modèle prédisait un chiffre d'affaires sans jamais en observer
// un seul : il était calé sur une hypothèse. Ces trois sources publiques
// remplacent l'hypothèse par des mesures.
//
//   SIRENE   dates de création et de fermeture, effectifs → durée de vie réelle
//   Comptes  CA et résultat net des sociétés qui déposent au greffe
//   BODACC   radiations et prix de cession des fonds de commerce
//
// Tout est facultatif : sans les fichiers, l'application fonctionne comme avant
// sur les repères du secteur.

const CP_COMMUNE = '33600';

function indexerEntreprises() {
  state._entrepriseParLaverie = {};
  if (!state.entreprises) return;
  for (const e of state.entreprises) {
    if (!e.laverie_id || !e.est_laverie) continue;
    const actuel = state._entrepriseParLaverie[e.laverie_id];
    // À rapprochements égaux, on préfère la ligne qui porte des comptes.
    const mieux = !actuel
      || ((e.finances || []).length && !(actuel.finances || []).length);
    if (mieux) state._entrepriseParLaverie[e.laverie_id] = e;
  }
}

function entrepriseDe(l) {
  return (state._entrepriseParLaverie || {})[l.id] || null;
}

// CA réellement publié, et imputable à CETTE adresse. Une société qui exploite
// plusieurs laveries publie un CA cumulé : l'utiliser pour caler une adresse
// serait une faute de méthode, le script d'import l'a donc marqué.
function caReelDe(l) {
  const e = entrepriseDe(l);
  if (!e || !e.ca_attribuable) return null;
  const f = (e.finances || []).find(x => x.ca != null);
  return f ? { ...f, siren: e.siren } : null;
}

function mediane(valeurs) {
  if (!valeurs.length) return null;
  const t = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
}

// CA observé sur le terrain, par ordre de pertinence : la commune d'abord,
// la métropole ensuite si la commune ne fournit rien.
function caObserve() {
  if (state._caObserve !== undefined) return state._caObserve;
  const eligibles = (state.entreprises || []).filter(
    e => e.est_laverie && e.actif && e.ca_attribuable
         && (e.finances || []).some(f => f.ca != null));
  const ca = (e) => e.finances.find(f => f.ca != null).ca;

  const paliers = state.perimetre === 'metropole'
    ? [['métropole', () => true]]
    : [['commune', e => e.code_postal === CP_COMMUNE], ['métropole', () => true]];
  for (const [perimetre, filtre] of paliers) {
    const lot = eligibles.filter(filtre);
    if (lot.length) {
      const valeurs = lot.map(ca);
      state._caObserve = {
        // Arrondi à 500 € : une médiane sur quelques sociétés n'a pas la
        // précision de l'euro, et le curseur doit pouvoir afficher exactement
        // la valeur qui cale le modèle.
        n: lot.length, perimetre, mediane: Math.round(mediane(valeurs) / 500) * 500,
        min: Math.min(...valeurs), max: Math.max(...valeurs),
        annee: Math.max(...lot.map(e => e.finances.find(f => f.ca != null).annee)),
      };
      return state._caObserve;
    }
  }
  state._caObserve = null;
  return null;
}

// SURVIE DES LAVERIES
//
// Un quartier où trois laveries ont fermé en cinq ans n'est pas une
// opportunité. Le taux de survie exclut les établissements trop récents pour
// être jugés : les compter comme « survivants » gonflerait artificiellement le
// résultat (c'est le biais de censure à droite).
function statsSurvie() {
  if (!state.entreprises) return null;
  const lav = state.entreprises.filter(e => e.est_laverie && e.date_creation);
  if (lav.length < 3) return null;
  const an = (d) => (d ? Number(String(d).slice(0, 4)) : null);
  const anneeCourante = new Date().getFullYear();

  const fermees = lav.filter(e => !e.actif);
  const durees = fermees
    .map(e => an(e.date_fermeture) - an(e.date_creation))
    .filter(d => Number.isFinite(d) && d >= 0);

  const jugeables = lav.filter(e => anneeCourante - an(e.date_creation) >= 5);
  const survivantes = jugeables.filter(
    e => e.actif || an(e.date_fermeture) - an(e.date_creation) >= 5);

  const radiations = state.bodacc
    ? Object.values(state.bodacc.par_siren || {}).flat()
        .filter(a => /radiation/i.test(String(a.famille || ''))).length
    : null;

  return {
    total: lav.length,
    ouvertes: lav.filter(e => e.actif).length,
    fermees: fermees.length,
    dureeMediane: mediane(durees),
    ageMedian: mediane(lav.filter(e => e.actif)
      .map(e => anneeCourante - an(e.date_creation)).filter(Number.isFinite)),
    survie5ans: jugeables.length >= 5
      ? survivantes.length / jugeables.length : null,
    nJugeables: jugeables.length,
    radiations,
  };
}

function prixCession() {
  const p = state.bodacc && state.bodacc.meta && state.bodacc.meta.prix_cession_eur;
  return p && p.n ? p : null;
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

// CONCORDANCE DES PAIRES — la même information, mais énonçable.
//
// « Corrélation de rang +0,60 » ne dit rien à personne, pas même à qui l'a
// calculée. La même information se formule en une phrase vérifiable : sur deux
// laveries prises au hasard, dans quelle proportion des cas le modèle
// désigne-t-il correctement la plus performante ?
//
// On compte donc les paires bien ordonnées, ce qui donne un pourcentage lisible :
//    50 %  = pile ou face, le modèle n'apporte rien
//   100 %  = ordre parfait
// C'est l'indicateur que l'interface met en avant ; la corrélation reste
// affichée en second, pour qui veut le chiffre technique.
function concordance(predit, observe) {
  let bonnes = 0, mauvaises = 0, exaequo = 0;
  for (let i = 0; i < predit.length; i++) {
    for (let j = i + 1; j < predit.length; j++) {
      const dPredit = predit[i] - predit[j];
      const dObserve = observe[i] - observe[j];
      // Une égalité ne départage rien : la paire ne compte ni pour ni contre.
      if (dPredit === 0 || dObserve === 0) { exaequo++; continue; }
      if (Math.sign(dPredit) === Math.sign(dObserve)) bonnes++;
      else mauvaises++;
    }
  }
  const total = bonnes + mauvaises;
  if (!total) return null;
  return { taux: bonnes / total, bonnes, mauvaises, total, exaequo };
}

// Deux références possibles, par ordre de qualité décroissante :
//
//   1. le CA RÉELLEMENT PUBLIÉ au greffe — la vraie variable à prédire ;
//   2. à défaut, le nombre d'avis Google, proxy grossier de fréquentation.
//
// Passer de 2 à 1 change la nature de l'exercice : on ne vérifie plus que le
// modèle « va dans le bon sens », on mesure de combien il se trompe.
function controleFiabilite() {
  const publiques = laveriesEtude().filter(l => l.type !== 'captif');
  const coef = coefficientCalibrage();
  const toutes = publiques.map(l => {
    const e = caBrut(l.lat, l.lon, RAYON_TENSION, l);
    const reel = caReelDe(l);
    return {
      nom: l.nom, ca: ((e.caMin + e.caMax) / 2) * coef,
      avis: l.nb_avis, caReel: reel ? reel.ca : null,
      anneeReel: reel ? reel.annee : null,
    };
  });

  const avecReel = toutes.filter(x => x.caReel != null);
  const avecAvis = toutes.filter(x => x.avis != null);
  const surReel = avecReel.length >= 3;
  const lignes = surReel ? avecReel : avecAvis;
  if (lignes.length < 3) return null;

  const observe = (x) => (surReel ? x.caReel : x.avis);
  const rho = correlationRangs(lignes.map(x => x.ca), lignes.map(observe));
  const conc = concordance(lignes.map(x => x.ca), lignes.map(observe));

  // Erreur relative médiane : n'a de sens que face à un vrai CA.
  const erreurMediane = surReel
    ? mediane(lignes.map(x => Math.abs(x.ca - x.caReel) / x.caReel)) : null;

  return {
    lignes: lignes.sort((a, b) => b.ca - a.ca),
    rho, conc, erreurMediane, surReel,
    n: lignes.length, nReel: avecReel.length, nTotal: publiques.length,
    // Seuils exprimés en concordance, pas en corrélation : 70 % correspond à
    // l'ancien seuil rho = 0,6 et 57 % à rho = 0,2, mais se justifient seuls.
    verdict: !conc ? 'nul'
      : conc.taux >= 0.70 ? 'bon' : conc.taux >= 0.57 ? 'faible' : 'nul',
  };
}

const VERDICT_FIABILITE = {
  bon: ['✅ Le modèle sait classer les laveries', '#16a34a',
        'Le classement des zones repose sur une mécanique qui explique déjà '
        + "l'existant. Vous pouvez le présenter."],
  faible: ['🟡 Le modèle fait à peine mieux que le hasard', '#eab308',
           'Le classement des zones est une piste de travail, pas un résultat. '
           + 'À consolider avant de le montrer à un financeur.'],
  nul: ['❌ Le modèle ne sait pas classer les laveries', '#dc2626',
        "Il n'explique pas les établissements déjà en place : rien ne dit qu'il "
        + 'prédise mieux les futurs. Traitez la carte comme une hypothèse.'],
};

// Pastille permanente en tête de colonne : l'état de santé du modèle doit être
// visible en continu, pas seulement quand on pense à ouvrir le bon onglet.
function majChipFiabilite(f) {
  const chip = document.getElementById('chip-fiabilite');
  if (!chip) return;
  if (!f || !f.conc) { chip.textContent = 'fiabilité n.d.'; chip.className = 'chip'; return; }
  chip.textContent = `fiabilité ${Math.round(f.conc.taux * 100)} %`;
  chip.className = 'chip ' + f.verdict;
}

function dessinerFiabilite() {
  const zone = document.getElementById('fiabilite');
  if (!zone) return;
  const f = controleFiabilite();
  majChipFiabilite(f);
  if (!f || !f.conc) {
    zone.innerHTML = `<p class="note">Pas encore assez de laveries mesurables pour
      tester le modèle. Il en faut au moins trois dont on connaisse la performance
      réelle.</p>`;
    return;
  }

  const [titre, couleur, consequence] = VERDICT_FIABILITE[f.verdict];
  const pct = Math.round(f.conc.taux * 100);
  const reference = f.surReel
    ? `le <b>chiffre d'affaires réellement déposé au greffe</b>`
    : `le <b>nombre d'avis Google</b>, faute de chiffre d'affaires publié`;

  // Le chiffre mis en avant est une phrase, pas un coefficient : c'est la seule
  // forme sous laquelle un non-statisticien peut le contester ou s'en servir.
  const enTete = `
    <div class="jauge" style="--c:${couleur}">
      <div class="jauge-val">${pct} %</div>
      <div class="jauge-lib">des paires de laveries correctement classées</div>
      <div class="jauge-barre"><i style="width:${Math.max(2, pct)}%"></i>
        <span class="jauge-hasard" title="50 % = pile ou face"></span></div>
      <div class="jauge-txt">
        Prenez <b>deux laveries au hasard</b> parmi les ${f.n} que l'on sait mesurer.
        Le modèle désigne correctement la plus performante dans <b>${pct} %</b> des cas
        (${f.conc.bonnes} paires sur ${f.conc.total}).<br>
        <b>50 %</b> serait un tirage à pile ou face. <b>100 %</b>, un classement parfait.
      </div>
    </div>
    <div class="encart" style="border-left-color:${couleur};margin-top:10px">
      <b style="color:${couleur}">${titre}</b><br>${consequence}
    </div>`;

  const erreur = f.erreurMediane != null
    ? `<div class="fait" style="margin-top:10px">
         <span class="fait-val">${(f.erreurMediane * 100).toFixed(0)} %</span>
         <span class="fait-lib">d'écart médian entre CA modélisé et CA réel</span>
         <span class="fait-detail">Le classement dit <i>quel</i> emplacement est
           meilleur ; cet écart dit à quel point les <i>euros</i> annoncés sont
           fiables. Sous 25 % c'est bon pour ce type de modèle, au-delà de 50 %
           ne vous servez que du classement.</span></div>` : '';

  const entete = f.surReel ? `<th>CA réel</th><th>Écart</th>` : `<th>Avis</th>`;
  const cellules = (l) => f.surReel
    ? `<td class="ca">${fmtEur(l.caReel)}<span class="sous">${l.anneeReel}</span></td>
       <td class="ca" style="color:${Math.abs(l.ca - l.caReel) / l.caReel > 0.4
          ? '#fca5a5' : '#86efac'}">${l.ca >= l.caReel ? '+' : '−'}${
          Math.abs(Math.round(100 * (l.ca - l.caReel) / l.caReel))} %</td>`
    : `<td>${l.avis}</td>`;

  const aide = `
    <details class="aide">
      <summary>D'où vient ce pourcentage&nbsp;?</summary>
      <div class="aide-corps">
        <p><b>Ce qu'on compare</b> — pour chaque laverie qui existe déjà, le modèle
        calcule ce qu'elle devrait faire. On confronte ce calcul à ${reference}.</p>
        <p><b>Comment on compte</b> — on forme toutes les paires possibles de
        laveries (${f.n} laveries donnent ${f.conc.total} paires exploitables). Pour
        chaque paire, on regarde si le modèle a mis dans le bon ordre celle qui
        marche le mieux. Le pourcentage affiché est la part de paires bien ordonnées.</p>
        <p><b>Pourquoi des paires et pas les euros</b> — pour choisir un emplacement,
        vous avez besoin de savoir <i>lequel est meilleur</i>, pas de prédire un
        chiffre au millier près. Un modèle qui se trompe de 30 % sur tous les
        montants mais ne se trompe jamais d'ordre reste parfaitement utile.</p>
        <p><b>Comment le faire monter</b> — trois leviers, du plus efficace au moins :
        élargir le nombre de laveries mesurées (plus de comptes annuels récupérés),
        corriger les nombres de logements des résidences et HLM, et relever sur
        place les machines et horaires des laveries existantes.</p>
        ${f.surReel ? '' : `<p><b>Limite actuelle</b> — la référence est le nombre
        d'avis Google, un proxy grossier : une laverie récente peut être excellente
        avec peu d'avis. Lancez <code>python3 scripts/import_entreprises.py</code>
        pour comparer à de vrais chiffres d'affaires.</p>`}
      </div>
    </details>`;

  zone.innerHTML = enTete + erreur + `
    <table class="tab-fiabilite" style="margin-top:10px">
      <thead><tr><th>Laverie existante</th><th>CA modélisé</th>${entete}</tr></thead>
      <tbody>${f.lignes.map(l => `<tr><td>${l.nom}</td>
        <td class="ca">${fmtEur(l.ca)}</td>${cellules(l)}</tr>`).join('')}</tbody>
    </table>
    <p class="note">Mesuré sur ${f.n} laverie${f.n > 1 ? 's' : ''} sur
      ${f.nTotal} du périmètre${f.surReel
        ? ' — celles dont les comptes sont publiés et imputables à une seule adresse'
        : ''}. Corrélation de rang (Spearman) : ${f.rho >= 0 ? '+' : ''}${f.rho.toFixed(2)}.</p>
    ${aide}`;
}

// ---------- CE QUE DIT LE MARCHÉ RÉEL ----------
//
// Panneau alimenté uniquement par des chiffres publiés : aucun modèle, aucune
// hypothèse. C'est la contrepartie factuelle du reste de l'outil.

function dessinerMarcheReel() {
  const zone = document.getElementById('marche-reel');
  if (!zone) return;
  const obs = caObserve();
  const survie = statsSurvie();
  const prix = prixCession();

  if (!obs && !survie && !prix) {
    zone.innerHTML = `<p class="note">Aucune donnée d'entreprise importée. Ces trois
      sources publiques et gratuites remplacent les hypothèses par des mesures :</p>
      <p class="note"><code>python3 scripts/import_entreprises.py</code><br>
      SIRENE et comptes annuels déposés au greffe → le CA réel des laveries.</p>
      <p class="note"><code>python3 scripts/import_bodacc.py</code><br>
      BODACC → radiations et prix de cession des fonds de commerce.</p>`;
    return;
  }

  const blocs = [];

  if (obs) {
    blocs.push(`<div class="fait">
      <span class="fait-val">${fmtEur(obs.mediane)}</span>
      <span class="fait-lib">CA médian publié · ${obs.n} laverie${obs.n > 1 ? 's' : ''}
        (${obs.perimetre}, ${obs.annee})</span>
      <span class="fait-detail">Fourchette observée ${fmtEur(obs.min)} – ${fmtEur(obs.max)}.
        C'est ce chiffre qui cale désormais le modèle, à la place des 50 000 € du
        dossier de marché.</span></div>`);
  }

  if (survie) {
    const tx = survie.survie5ans != null
      ? `${Math.round(survie.survie5ans * 100)} %` : 'n.d.';
    blocs.push(`<div class="fait">
      <span class="fait-val">${tx}</span>
      <span class="fait-lib">encore ouvertes 5 ans après leur création</span>
      <span class="fait-detail">${survie.total} laveries suivies :
        ${survie.ouvertes} ouvertes, ${survie.fermees} fermées.
        ${survie.dureeMediane != null
          ? `Durée de vie médiane des fermées : <b>${survie.dureeMediane} ans</b>. ` : ''}
        ${survie.ageMedian != null
          ? `Âge médian de celles en activité : <b>${survie.ageMedian} ans</b>. ` : ''}
        ${survie.nJugeables < 10
          ? '<span style="color:#fbbf24">Échantillon faible : à lire comme un ordre de grandeur.</span>' : ''}
        </span></div>`);
  }

  if (prix) {
    blocs.push(`<div class="fait">
      <span class="fait-val">${fmtEur(prix.median)}</span>
      <span class="fait-lib">prix de cession médian d'un fonds · ${prix.n} vente${prix.n > 1 ? 's' : ''}</span>
      <span class="fait-detail">De ${fmtEur(prix.min)} à ${fmtEur(prix.max)}, relevés dans
        les annonces BODACC. À comparer à l'investissement de création
        (${fmtEur(state.benchmarks.exploitation.investissement_initial_eur[0])} –
        ${fmtEur(state.benchmarks.exploitation.investissement_initial_eur[1])}) :
        reprendre coûte-t-il moins cher que créer ?</span></div>`);
  }

  zone.innerHTML = blocs.join('')
    + `<p class="note">Chiffres publics, sans aucun modèle : SIRENE, comptes annuels
       déposés au greffe et annonces BODACC. Tout ce qui est absent l'est parce que les
       sociétés concernées n'ont rien publié — pas parce que le chiffre n'existe pas.</p>`;
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
  if (state.vue !== 'potentiel') return;

  // Emprise : les zones du périmètre courant, élargies d'une marge.
  const zones = zonesEtude();
  const lats = zones.map(q => q.lat);
  const lons = zones.map(q => q.lon);
  const marge = state.perimetre === 'metropole' ? 0.02 : 0.012;
  const sud = Math.min(...lats) - marge, nord = Math.max(...lats) + marge;
  const ouest = Math.min(...lons) - marge, est = Math.max(...lons) + marge;

  // Pas adaptatif : passer à la métropole multiplie la surface par ~15.
  // Peindre 70 000 mailles gèlerait le navigateur ; on relâche la résolution
  // juste assez pour rester sous ~20 000 mailles, et la légende l'affiche.
  let pas = GRILLE_PAS_M;
  {
    const largeurM = (est - ouest) * 111320 * Math.cos(((sud + nord) / 2) * Math.PI / 180);
    const hauteurM = (nord - sud) * 111320;
    const mailles = (largeurM / pas) * (hauteurM / pas);
    if (mailles > 20000) pas = Math.ceil(Math.sqrt(largeurM * hauteurM / 20000) / 10) * 10;
  }
  state.pasGrille = pas;

  const pasLat = pas / 111320;
  const pasLon = pas / (111320 * Math.cos(((sud + nord) / 2) * Math.PI / 180));
  const nY = Math.ceil((nord - sud) / pasLat);
  const nX = Math.ceil((est - ouest) / pasLon);

  const canvas = document.createElement('canvas');
  canvas.width = nX; canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(nX, nY);
  const R = state.rayon;

  // Même garde-fou que le diagnostic par commune : là où l'inventaire est trop
  // incomplet pour juger, la heatmap s'estompe en gris au lieu d'afficher un
  // rouge éclatant qui ne mesure que l'absence de données.
  const zonesAveugles = state.perimetre === 'metropole'
    ? zonesEtude().filter(inventaireInsuffisant)
        .map(z => ({ lat: z.lat, lon: z.lon, rayon: rayonCommune(z) * 1.15 }))
    : [];
  const estAveugle = (lat, lon) => zonesAveugles.some(
    z => distanceM(lat, lon, z.lat, z.lon) <= z.rayon);

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
      if (estAveugle(lat, lon)) {
        img.data[i] = 120; img.data[i + 1] = 122; img.data[i + 2] = 134;
        img.data[i + 3] = 80;
        continue;
      }
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
  majLegendeVue();     // le pas de grille affiché doit être celui qui a servi
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
const SYMBOLE_GENERATEUR = {
  residence_etudiante: '🎓',
  logement_social: '🏢',
  hebergement_tourisme: '🧳',
};

function iconeGenerateur(g) {
  const couleur = COULEUR_GENERATEUR[g.type] || '#94a3b8';
  const symbole = SYMBOLE_GENERATEUR[g.type] || '•';
  return L.divIcon({
    className: '',
    html: `<span class="pin-gen" style="--pc:${couleur}"><i>${symbole}</i></span>`,
    iconSize: [22, 28], iconAnchor: [11, 27], popupAnchor: [0, -24],
  });
}

const RAYON_DENSITE_M = 320;
const GRILLE_DENSITE_M = 60;

const FAMILLES = ['residence_etudiante', 'logement_social', 'hebergement_tourisme'];

const LIBELLE_FAMILLE = {
  residence_etudiante: 'étudiante',
  logement_social: 'HLM / logement social',
  hebergement_tourisme: 'touristique',
};

const RVB_FAMILLE = {
  residence_etudiante: [237, 161, 0],
  logement_social: [232, 123, 164],
  hebergement_tourisme: [27, 175, 122],
};

// Générateurs retenus pour l'AFFICHAGE (filtres de la légende). Le modèle, lui,
// continue de tous les compter : un filtre de carte ne change pas la demande.
function generateursAffiches() {
  return (state.generateurs || []).filter(
    g => !g.exclu && state.genTypes[g.type] !== false);
}

// Échelle SÉQUENTIELLE (intensité croissante) : la densité est une magnitude
// sans point de bascule. La TEINTE, elle, dit qui habite là — c'est la question
// « où sont les étudiants, où sont les HLM ».
const PALIERS_DENSITE = [15, 40, 90, 180, 320];

// En dessous, la maille reste transparente : c'est la limite du secteur habité
// captif, celle que le trait foncé souligne sur la carte.
const SEUIL_AFFICHAGE = PALIERS_DENSITE[0];

// ---------- GRILLE DE DENSITÉ CAPTIVE ----------
//
// Une grille de 60 m sur l'emprise des bâtiments, avec un compteur PAR FAMILLE
// en plus du total : c'est ce qui permet de colorer une zone selon qui l'occupe
// plutôt que de tout noyer dans un orange unique.
//
// Dépôt (scatter) et non balayage (gather) : chaque bâtiment n'éclaire qu'un
// carré de ~1,2 km de côté. Interroger les 290 000 mailles de la métropole pour
// chacun des 274 bâtiments coûtait 80 millions de distances ; ici, ~120 000.
function grilleDemande() {
  if (state._grille !== undefined) return state._grille;
  const gens = generateursAffiches();
  if (!gens.length) return (state._grille = null);

  const marge = 0.006;
  const sud = Math.min(...gens.map(g => g.lat)) - marge;
  const nord = Math.max(...gens.map(g => g.lat)) + marge;
  const ouest = Math.min(...gens.map(g => g.lon)) - marge;
  const est = Math.max(...gens.map(g => g.lon)) + marge;

  const pasLat = GRILLE_DENSITE_M / 111320;
  const pasLon = GRILLE_DENSITE_M / (111320 * Math.cos(((sud + nord) / 2) * Math.PI / 180));
  const nY = Math.ceil((nord - sud) / pasLat);
  const nX = Math.ceil((est - ouest) / pasLon);

  const tot = new Float32Array(nX * nY);
  const parFamille = {};
  for (const f of FAMILLES) parFamille[f] = new Float32Array(nX * nY);

  // Au-delà de 1,9 rayon, exp(-(d/R)²) < 0,03 : le seuil de coupure d'origine.
  const portee = Math.ceil((RAYON_DENSITE_M * 1.9) / GRILLE_DENSITE_M);

  for (const g of gens) {
    const poids = menagesGenerateur(g).reguliers;
    if (!(poids > 0)) continue;
    const cx = Math.round((g.lon - ouest) / pasLon);
    const cy = Math.round((nord - g.lat) / pasLat);
    const bac = parFamille[g.type] || null;
    for (let y = Math.max(0, cy - portee); y <= Math.min(nY - 1, cy + portee); y++) {
      const lat = nord - y * pasLat;
      for (let x = Math.max(0, cx - portee); x <= Math.min(nX - 1, cx + portee); x++) {
        const w = couverture(distanceM(lat, ouest + x * pasLon, g.lat, g.lon), RAYON_DENSITE_M);
        if (w < 0.03) continue;
        const i = y * nX + x;
        tot[i] += poids * w;
        if (bac) bac[i] += poids * w;
      }
    }
  }
  state._grille = { sud, nord, ouest, est, nX, nY, pasLat, pasLon, tot, parFamille };
  return state._grille;
}

// Densité de ménages sans lave-linge en un point, tous bâtiments confondus.
function densiteDemande(lat, lon) {
  let d = 0;
  for (const g of generateursAffiches()) {
    const w = couverture(distanceM(lat, lon, g.lat, g.lon), RAYON_DENSITE_M);
    if (w < 0.03) continue;
    d += menagesGenerateur(g).reguliers * w;
  }
  return d;
}

// ---------- ZONES DE BESOIN ----------
//
// PREMIÈRE TENTATIVE, ABANDONNÉE : étiqueter les composantes connexes de la
// grille au-dessus d'un seuil. En zone urbaine dense, tout se touche — le test a
// rendu UNE grappe de 11 000 ménages allant du campus de Talence au centre de
// Bordeaux. Vraie au sens topologique, inutilisable au sens commercial : aucune
// laverie ne dessert 6 km de long.
//
// CE QU'ON FAIT À LA PLACE : une zone n'est pas une tache contiguë, c'est UNE
// IMPLANTATION POSSIBLE. On cherche donc, itérativement, le point qui capterait
// le plus de ménages captifs dans un rayon de chalandise, on lui attribue ces
// bâtiments, on les retire, et on recommence. Chaque zone est ainsi, par
// construction, « ce qu'une laverie posée là ramasserait » — l'unité de décision
// réelle, et deux zones ne peuvent pas se revendiquer le même immeuble.
const RAYON_ZONE = RAYON_TENSION;      // 800 m, le rayon de référence de l'app

// En dessous, c'est un immeuble isolé, pas un quartier : une pastille numérotée
// y donnerait à un petit hôtel le même poids qu'à une cité universitaire.
const MIN_MENAGES_ZONE = 30;

function zonesBesoin() {
  if (state._zones !== undefined) return state._zones;

  const restants = generateursAffiches()
    .map(g => ({ g, m: menagesGenerateur(g).reguliers }))
    .filter(x => x.m > 0);
  if (!restants.length) return (state._zones = []);

  // Une seule fois pour toutes les zones : zonesEtude() reconstruit la liste des
  // communes à chaque appel en mode métropole.
  const secteurs = zonesEtude() || [];
  const zones = [];

  while (restants.length) {
    // Le meilleur emplacement est cherché SUR les bâtiments restants : le point
    // optimal d'un semis de points pondérés est toujours à côté de l'un d'eux, et
    // cela évite de balayer une grille pour un gain nul.
    let meilleur = null;
    for (const centre of restants) {
      let score = 0;
      for (const x of restants) {
        const d = distanceM(centre.g.lat, centre.g.lon, x.g.lat, x.g.lon);
        if (d > RAYON_ZONE) continue;
        score += x.m * couverture(d, RAYON_ZONE);
      }
      if (!meilleur || score > meilleur.score) meilleur = { centre, score };
    }
    if (!meilleur || meilleur.score < MIN_MENAGES_ZONE) break;

    // RECENTRAGE. Le point de départ est un bâtiment ; le centre d'une zone est
    // le barycentre de ses ménages. Les deux diffèrent, et sélectionner autour de
    // l'un puis mesurer depuis l'autre laissait des immeubles à 960 m du centre
    // d'une zone annoncée à 800 m — le test l'a relevé. On itère donc jusqu'à ce
    // que centre et sélection s'accordent : « tous les bâtiments à moins de
    // 800 m du centre » devient vrai par construction.
    let lat = meilleur.centre.g.lat, lon = meilleur.centre.g.lon;
    let dedans = [];
    for (let iter = 0; iter < 6; iter++) {
      dedans = restants.filter(x => distanceM(lat, lon, x.g.lat, x.g.lon) <= RAYON_ZONE);
      let poids = 0, sLat = 0, sLon = 0;
      for (const { g, m } of dedans) { poids += m; sLat += g.lat * m; sLon += g.lon * m; }
      if (!poids) break;
      const nLat = sLat / poids, nLon = sLon / poids;
      const bouge = distanceM(lat, lon, nLat, nLon);
      lat = nLat; lon = nLon;
      if (bouge < 20) break;      // 20 m : sous la précision d'une adresse
    }
    // Dernière sélection avec le centre définitif, pour que l'étendue mesurée
    // depuis ce centre respecte vraiment le rayon.
    dedans = restants.filter(x => distanceM(lat, lon, x.g.lat, x.g.lon) <= RAYON_ZONE);

    // Les bâtiments retenus sortent du jeu : sans ce retrait, les vingt
    // premières zones seraient vingt variantes du même campus, décalées de
    // cinquante mètres.
    const pris = new Set(dedans.map(x => x.g.id));
    const dehors = restants.filter(x => !pris.has(x.g.id));
    restants.length = 0;
    restants.push(...dehors);

    let menages = 0;
    const familles = {};
    for (const { g, m } of dedans) {
      menages += m;
      const f = familles[g.type] || (familles[g.type] = { batiments: 0, logements: 0, menages: 0 });
      f.batiments++; f.logements += g.logements; f.menages += m;
    }
    if (menages < MIN_MENAGES_ZONE) continue;
    const bats = dedans.map(x => x.g);

    // Offre accessible depuis ce centre, au rayon de référence du diagnostic.
    // Même fonction que le modèle : la vue ne peut pas raconter autre chose.
    const { pression, concurrents } = offreAccessible(lat, lon, RAYON_TENSION);
    let plusProche = null;
    for (const l of laveriesProches(lat, lon, RAYON_TENSION)) {
      const d = distanceM(lat, lon, l.lat, l.lon);
      if (!plusProche || d < plusProche.d) plusProche = { l, d };
    }

    // Ménages captifs par « laverie moyenne » réellement accessible. Le terme
    // d'option extérieure au dénominateur est celui du modèle de Huff : sans
    // lui, une zone sans aucune laverie afficherait un besoin infini.
    const parLaverie = menages / (pression + ATTRACTIVITE_EXTERIEURE);

    const dominante = Object.keys(familles)
      .sort((a, b) => familles[b].menages - familles[a].menages)[0];

    // Rayon réellement occupé par les bâtiments : une zone de trois immeubles
    // collés ne doit pas se présenter comme un secteur de 800 m.
    const etendue = Math.max(...bats.map(g => distanceM(lat, lon, g.lat, g.lon)));

    zones.push({
      id: zones.length, batiments: bats, lat, lon, etendue,
      menages, familles, dominante, pression, concurrents, parLaverie, plusProche,
      nom: nommerZone(lat, lon, bats, secteurs),
    });
  }

  // Référence RELATIVE, comme partout dans l'app : « par rapport à la zone
  // captive médiane du périmètre ». Un seuil absolu de ménages par laverie
  // n'existe pas — il dépendrait du panier moyen, du format des laveries et du
  // taux d'équipement, dont aucun n'est mesuré ici.
  const med = mediane(zones.map(z => z.parLaverie));
  for (const z of zones) z.besoin = med ? z.parLaverie / med : 1;
  zones.sort((a, b) => b.besoin - a.besoin);
  zones.forEach((z, i) => { z.rang = i + 1; });

  state._zones = zones;
  return zones;
}

// Nom lisible : la zone d'étude la plus proche (quartier à Pessac, commune en
// métropole), qualifiée par le plus gros bâtiment de la grappe. « Zone n°3 »
// tout court n'aide personne à retrouver l'endroit sur le terrain.
function nommerZone(lat, lon, bats, secteurs) {
  let secteur = null;
  for (const z of secteurs) {
    const d = distanceM(lat, lon, z.lat, z.lon);
    if (!secteur || d < secteur.d) secteur = { nom: z.nom, d };
  }
  const phare = bats.slice().sort((a, b) => b.logements - a.logements)[0];
  return { secteur: secteur ? secteur.nom : 'Secteur', phare: phare ? phare.nom : '' };
}

// Trois verdicts, mêmes couleurs que le diagnostic par quartier : rouge = de la
// place, vert = déjà servi. Cohérence des couleurs d'une vue à l'autre.
const VERDICTS_BESOIN = [
  { min: 1.5, cle: 'fort', libelle: 'Besoin fort', couleur: '#dc2626' },
  { min: 0.9, cle: 'modere', libelle: 'Besoin modéré', couleur: '#eab308' },
  { min: -Infinity, cle: 'servi', libelle: 'Déjà desservie', couleur: '#15803d' },
];

function verdictBesoin(besoin) {
  return VERDICTS_BESOIN.find(v => besoin >= v.min);
}

// Nombre de pastilles numérotées. Au-delà, la carte de la métropole devient un
// champ de chiffres illisible — mais le compte total est annoncé dans la
// légende : une troncature silencieuse se lirait comme « il n'y a que ça ».
const MAX_PASTILLES = 20;

function dessinerDemandeCaptive() {
  state.layers.demande.clearLayers();
  cercleZone(null);
  if (state.layers.demandeSurface) {
    map.removeLayer(state.layers.demandeSurface);
    state.layers.demandeSurface = null;
  }
  if (state.vue !== 'demande') return;

  const gr = grilleDemande();
  if (!gr) return;
  const { sud, nord, ouest, est, nX, nY, tot, parFamille } = gr;

  const canvas = document.createElement('canvas');
  canvas.width = nX; canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(nX, nY);
  const px = img.data;

  const dedans = (i) => tot[i] >= SEUIL_AFFICHAGE;

  for (let y = 0; y < nY; y++) {
    for (let x = 0; x < nX; x++) {
      const i = y * nX + x;
      const d = tot[i];
      const o = i * 4;
      if (d < SEUIL_AFFICHAGE) { px[o + 3] = 0; continue; }

      let niveau = 0;
      while (niveau < PALIERS_DENSITE.length - 1 && d >= PALIERS_DENSITE[niveau + 1]) niveau++;
      const t = niveau / (PALIERS_DENSITE.length - 1);

      // Mélange des teintes de famille, pondéré au CARRÉ. Une grappe 70/30 rend
      // une couleur à 84 % dominante — donc lisible comme « étudiante » — tandis
      // qu'un vrai 50/50 donne un mélange franc. Une bascule brutale au
      // gagnant-prend-tout ferait clignoter la carte au moindre pin décoché.
      let r = 0, v = 0, b = 0, somme = 0;
      for (const f of FAMILLES) {
        const w = parFamille[f][i];
        if (w <= 0) continue;
        const p = w * w;
        const c = RVB_FAMILLE[f];
        r += c[0] * p; v += c[1] * p; b += c[2] * p; somme += p;
      }
      if (!somme) { r = 148; v = 163; b = 184; somme = 1; }
      r /= somme; v /= somme; b /= somme;

      // Bord de grappe : opaque et assombri. C'est le tracé de la zone, celui
      // qu'on suit du doigt pour dire « le quartier va jusque-là ».
      const bord = (x === 0 || !dedans(i - 1)) || (x === nX - 1 || !dedans(i + 1))
                || (y === 0 || !dedans(i - nX)) || (y === nY - 1 || !dedans(i + nX));
      if (bord) {
        px[o] = r * 0.6; px[o + 1] = v * 0.6; px[o + 2] = b * 0.6; px[o + 3] = 205;
        continue;
      }

      // Vers le clair en périphérie, vers la teinte pure au cœur.
      const clair = 1 - t;
      px[o] = r + (255 - r) * clair * 0.55;
      px[o + 1] = v + (255 - v) * clair * 0.55;
      px[o + 2] = b + (255 - b) * clair * 0.55;
      px[o + 3] = 55 + t * 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  state.layers.demandeSurface = L.imageOverlay(canvas.toDataURL(),
    [[sud, ouest], [nord, est]], { opacity: 0.85, interactive: false, zIndex: 240 }).addTo(map);

  dessinerReperesDemande();
}

// En dessous de ce zoom, 274 pins recouvrent entièrement les aplats de couleur —
// on ne voit plus les zones, seulement une nuée de gouttes. À l'échelle
// métropole on veut d'abord lire les secteurs ; le détail bâtiment par bâtiment
// vient en zoomant.
const ZOOM_PINS = 13;

function dessinerReperesDemande() {
  state.layers.demande.clearLayers();
  if (state.vue !== 'demande') return;

  // Pastilles de zone : le rang répond à « où faut-il regarder en premier »,
  // le pin à « quel bâtiment exactement ».
  for (const z of zonesBesoin().slice(0, MAX_PASTILLES)) {
    L.marker([z.lat, z.lon], { icon: iconeZone(z), riseOnHover: true, zIndexOffset: 500 })
      .bindPopup(popupZone(z), { maxWidth: 330 })
      .bindTooltip(`Zone n°${z.rang} — ${verdictBesoin(z.besoin).libelle}`, { direction: 'top' })
      .on('popupopen', (e) => ouvrirZone(e.popup, z))
      .on('popupclose', () => cercleZone(null))
      .addTo(state.layers.demande);
  }

  if (map.getZoom() < ZOOM_PINS) return;

  // Repères cliquables par-dessus la surface. Une pastille de 4 px se perdait
  // dans l'aplat : on pose de vrais pins, reconnaissables au premier coup d'œil
  // et distincts par famille.
  for (const g of generateursAffiches()) {
    const m = menagesGenerateur(g);
    L.marker([g.lat, g.lon], { icon: iconeGenerateur(g), riseOnHover: true })
      .bindPopup(popupGenerateur(g, m), { maxWidth: 300 })
      .bindTooltip(`${SYMBOLE_GENERATEUR[g.type] || '•'} ${g.nom}`, { direction: 'top' })
      .on('popupopen', (e) => brancherEditionGenerateur(e.popup))
      .addTo(state.layers.demande);
  }
}

// La pastille flotte AU-DESSUS du point, pas dessus : sur une zone d'un seul
// bâtiment, elle recouvrait exactement son pin — le pin devenait incliquable, et
// le test l'a montré avant que ça n'atteigne la carte.
function iconeZone(z) {
  const v = verdictBesoin(z.besoin);
  return L.divIcon({
    className: '',
    html: `<span class="pastille-zone" style="--zc:${v.couleur}">${z.rang}</span>`,
    iconSize: [30, 38], iconAnchor: [15, 46], popupAnchor: [0, -44],
  });
}

function compositionZone(z) {
  return FAMILLES.filter(f => z.familles[f]).map(f => {
    const d = z.familles[f];
    return `<span class="compo"><span class="pin-gen pin-inline" style="--pc:${
      COULEUR_GENERATEUR[f]}"><i>${SYMBOLE_GENERATEUR[f]}</i></span>${
      d.batiments} bât. · ${fmtInt(d.logements)} log.</span>`;
  }).join('');
}

function popupZone(z) {
  const v = verdictBesoin(z.besoin);
  const proche = z.plusProche
    ? `${z.plusProche.l.nom} à ${fmtInt(z.plusProche.d)} m`
    : 'aucune laverie recensée à portée';
  const dansRayon = z.concurrents.length;
  return `<div class="popup">
      <span class="tag" style="background:${v.couleur}">n°${z.rang} · ${v.libelle}</span>
      <h3>Zone ${LIBELLE_FAMILLE[z.dominante] || ''} — ${z.nom.secteur}</h3>
      <p class="popup-sous">autour de ${z.nom.phare}</p>
      <div class="compo-ligne">${compositionZone(z)}</div>
      <table>
        <tr><td>Ménages sans lave-linge</td><td><b>~${fmtInt(z.menages)}</b>
          dans ${z.batiments.length} bâtiment${z.batiments.length > 1 ? 's' : ''}</td></tr>
        <tr><td>Le plus éloigné du centre</td><td>${fmtInt(z.etendue)} m</td></tr>
        <tr><td>Laverie la plus proche</td><td>${proche}</td></tr>
        <tr><td>Laveries dans les 800 m</td><td>${dansRayon}</td></tr>
        <tr><td>Ménages captifs par laverie accessible</td><td><b>${fmtInt(z.parLaverie)}</b>
          — ${z.besoin >= 1 ? `${z.besoin.toFixed(1)}×` : `${(1 / z.besoin).toFixed(1)}× moins que`}
          la zone médiane</td></tr>
      </table>
      <button class="btn-zone" data-zone-simu="${z.id}">📍 Simuler une laverie ici</button>
      <p class="warn">Le besoin ne compte QUE la demande captive de ces bâtiments, dans un
      rayon de 800 m. La population ordinaire du quartier s'y ajoute : pour le chiffre
      d'affaires complet, lancez la simulation.</p>
    </div>`;
}

// Le rayon de chalandise de la zone, matérialisé seulement quand on l'ouvre :
// vingt cercles de 800 m affichés en permanence rendraient la carte illisible,
// alors que la question « jusqu'où va cette zone ? » ne se pose qu'une à la fois.
function cercleZone(z) {
  if (state.layers.zoneCercle) {
    map.removeLayer(state.layers.zoneCercle);
    state.layers.zoneCercle = null;
  }
  if (!z) return;
  state.layers.zoneCercle = L.circle([z.lat, z.lon], {
    radius: RAYON_ZONE, color: verdictBesoin(z.besoin).couleur,
    weight: 2, dashArray: '6 5', fill: false, interactive: false,
  }).addTo(map);
}

function ouvrirZone(popup, z) {
  cercleZone(z);
  const el = popup.getElement?.();
  const btn = el && el.querySelector('button[data-zone-simu]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    map.closePopup();
    simuler(z.lat, z.lon);
    montrerSimulation();
  });
}

// ---------- CLASSEMENT DES ZONES DE BESOIN (onglet Analyse) ----------

function dessinerZonesBesoin() {
  const ol = document.getElementById('zones-besoin');
  if (!ol) return;
  const zones = zonesBesoin();
  const note = document.getElementById('zones-besoin-note');

  if (!zones.length) {
    ol.innerHTML = '';
    if (note) note.textContent = 'Aucune concentration de logements captifs détectée avec '
      + 'les familles actuellement cochées dans la légende de la carte.';
    return;
  }

  const forts = zones.filter(z => verdictBesoin(z.besoin).cle === 'fort').length;
  if (note) {
    note.innerHTML = `<b>${zones.length} zones</b> de logements captifs détectées, dont
      <b>${forts}</b> en besoin fort. Chacune est une implantation possible à 800 m de rayon,
      classée par ménages sans lave-linge rapportés aux laveries accessibles. Cliquez une
      ligne&nbsp;: la carte s'y rend et lance la simulation.`;
  }

  ol.innerHTML = zones.slice(0, 8).map(z => {
    const v = verdictBesoin(z.besoin);
    const compo = FAMILLES.filter(f => z.familles[f])
      .map(f => `${SYMBOLE_GENERATEUR[f]} ${z.familles[f].batiments}`).join(' ');
    return `<li data-zone="${z.id}" style="border-left-color:${v.couleur}">
      <span class="z-nom">${z.nom.secteur} · ${LIBELLE_FAMILLE[z.dominante] || ''}
        <span class="z-ca">${compo} — ~${fmtInt(z.menages)} ménages sans lave-linge ·
          ${z.plusProche ? `laverie à ${fmtInt(z.plusProche.d)} m` : 'aucune laverie à portée'}</span></span>
      <span class="z-ind" style="background:${v.couleur};color:#fff">${z.besoin.toFixed(1)}×</span>
    </li>`;
  }).join('') + (zones.length > 8
    ? `<li class="non-evaluable">${zones.length - 8} autres zones non listées ici — les
       ${MAX_PASTILLES} premières restent visibles sur la carte, en vue « Zones étudiantes,
       HLM… ».</li>` : '');

  for (const li of ol.querySelectorAll('li[data-zone]')) {
    li.addEventListener('click', () => {
      const z = zonesBesoin().find(x => String(x.id) === li.dataset.zone);
      if (!z) return;
      ouvrirOnglet('carte');
      const radio = document.querySelector('input[name="vue"][value="demande"]');
      if (radio && !radio.checked) { radio.checked = true; state.vue = 'demande'; rafraichir(); }
      map.flyTo([z.lat, z.lon], 15, { duration: 0.8 });
      simuler(z.lat, z.lon);
      montrerSimulation();
    });
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
      invaliderGenerateurs();          // la demande et les zones sont à refaire
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
      invaliderGenerateurs();
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
  if (c.lat < 44.6 || c.lat > 45.05 || c.lon < -0.9 || c.lon > -0.4) {
    err.textContent = "Ce point est hors de la zone d'étude (Bordeaux Métropole).";
    return;
  }
  err.textContent = '';
  map.flyTo([c.lat, c.lon], 16, { duration: 0.8 });
  simuler(c.lat, c.lon);
  montrerSimulation();
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

// ---------- NAVIGATION PAR ONGLETS ----------
//
// Dix panneaux empilés dans une colonne qui défile, c'est une liste de courses,
// pas une interface. On regroupe par intention : ce que la carte montre, ce
// qu'on en tire, l'inventaire, et les réglages du modèle.

function ouvrirOnglet(nom) {
  for (const b of document.querySelectorAll('.onglet')) {
    b.classList.toggle('actif', b.dataset.onglet === nom);
  }
  for (const v of document.querySelectorAll('.vue-onglet')) {
    v.classList.toggle('hidden', v.id !== 'tab-' + nom);
  }
  const corps = document.querySelector('.onglets-corps');
  if (corps) corps.scrollTop = 0;
}

// Le résultat d'une simulation vit en bas de l'onglet Analyse : sans ce défilement,
// une simulation lancée depuis la carte semble ne rien produire.
function montrerSimulation() {
  ouvrirOnglet('analyse');
  const el = document.getElementById('simu-result');
  if (el && !el.classList.contains('hidden')) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------- BASCULE DE PÉRIMÈTRE ----------
//
// Changer d'échelle invalide tout ce qui dépend du périmètre : la demande, le
// calibrage, l'ancre de CA et le classement. On repart proprement plutôt que de
// laisser des caches raconter l'ancienne échelle.

function changerPerimetre(nouveau) {
  if (nouveau === state.perimetre) return;
  state.perimetre = nouveau;
  state._pointsDemande = null;
  state._indexDemande = null;
  // Les zones changent de nom avec le périmètre (quartier de Pessac ou commune) :
  // la grille de densité, elle, ne dépend pas de l'échelle d'analyse.
  state._zones = undefined;
  state._coefCal = null;
  state._caObserve = undefined;
  state._empreinte = null;
  state._empreinteAvant = null;
  state.carroyagePartiel = false;

  for (const b of document.querySelectorAll('[data-perimetre]')) {
    b.classList.toggle('actif', b.dataset.perimetre === nouveau);
  }
  const v = VUES_CARTE[nouveau];
  map.flyTo(v.centre, v.zoom, { duration: 0.9 });

  calerCurseurCaRef();
  majLegendeVue();
  rafraichir();
  if (state.derniereSimulation) {
    const d = state.derniereSimulation;
    simuler(d.lat, d.lon);
  }

  const publiques = laveriesEtude().filter(l => l.type !== 'captif').length;
  afficherToast('Périmètre : ' + (nouveau === 'metropole' ? 'Bordeaux Métropole' : 'Pessac'),
    nouveau === 'metropole'
      ? `le modèle se recale sur <b>${publiques} laveries grand public</b> au lieu de 5 : `
        + `calibrage et contrôle de fiabilité deviennent bien plus solides. En échange, `
        + `le diagnostic passe à la maille communale — indicatif, pas contractuel.`
      : `retour à l'analyse fine de Pessac : 15 quartiers, générateurs de demande `
        + `bâtiment par bâtiment.`,
    false);
}

// ---------- LÉGENDE DE LA VUE ACTIVE ----------
//
// Une seule légende affichée, celle de la vue en cours. Afficher les quatre en
// permanence obligeait le lecteur à deviner laquelle s'applique.

const LEGENDES = {
  potentiel: () => `
    <span class="lg"><i style="background:#1c5cab"></i> Très en dessous</span>
    <span class="lg"><i style="background:#5598e7"></i> En dessous</span>
    <span class="lg"><i style="background:#6e6e69"></i> Au niveau</span>
    <span class="lg"><i style="background:#e66767"></i> Au-dessus</span>
    <span class="lg"><i style="background:#d03b3b"></i> Nettement au-dessus</span>
    <span class="texte">Chaque maille de ${state.pasGrille || 140} m est évaluée par le
    modèle. La référence, c'est le CA d'une <b>laverie moyenne de ${nomPerimetre()}</b> :
    rouge = une nouvelle laverie y ferait mieux. Les zones sans habitants restent
    transparentes.</span>${state.perimetre === 'metropole' ? `
    <span class="lg"><i style="background:#787a86;opacity:0.55"></i> Estompé : non évaluable</span>
    <span class="texte" style="color:#fbbf24">Les communes estompées n'ont pas assez de
    laveries recensées pour leur gabarit : un rouge y mesurerait l'absence de données,
    pas une opportunité. Lancez <code>scripts/find_laveries_metropole.py</code>.</span>` : ''}`,

  demande: () => {
    const gens = (state.generateurs || []).filter(g => !g.exclu);
    const compte = (t) => gens.filter(g => g.type === t).length;
    const ligne = (t, libelle) => `
      <label class="check check-gen"><input type="checkbox" data-gentype="${t}"
        ${state.genTypes[t] !== false ? 'checked' : ''}>
        <span class="pin-gen pin-inline" style="--pc:${COULEUR_GENERATEUR[t]}"><i>${
          SYMBOLE_GENERATEUR[t]}</i></span>
        <span>${libelle}</span><span class="badge">${compte(t)}</span></label>`;
    const pastille = (v) => `<span class="lg"><i class="rond"
      style="background:${v.couleur}"></i> ${v.libelle}</span>`;
    return `
      <span class="texte"><b>La couleur du fond dit QUI habite là</b> — chaque famille a sa
      teinte, la même que son pin ; un secteur mixte prend une teinte intermédiaire.
      L'intensité dit combien : pâle en lisière, saturé au cœur. Le <b>trait foncé</b>
      marque la limite du secteur habité captif.</span>
      ${ligne('residence_etudiante', 'Résidences étudiantes')}
      ${ligne('logement_social', 'Logements sociaux (HLM)')}
      ${ligne('hebergement_tourisme', 'Hébergements touristiques')}
      <span class="texte">Décocher masque les pins <b>et</b> le fond correspondant, sans
      rien changer au modèle : la demande de ces bâtiments reste comptée dans le
      potentiel.</span>
      <span class="texte"><b>Les pastilles numérotées</b> marquent les <b>implantations
      possibles</b> : chacune est le meilleur point d'un rayon de 800 m, et deux pastilles
      ne se disputent jamais les mêmes immeubles. Elles sont classées par <b>besoin</b> —
      ménages sans lave-linge rapportés aux laveries réellement accessibles, comparé à la
      zone médiane. Cliquez-en une : son rayon s'affiche.</span>
      ${VERDICTS_BESOIN.map(pastille).join('')}
      <span class="texte" id="legende-zones"></span>
      <span class="texte" style="color:#fbbf24">⚠ Le nombre de logements est une valeur par
      défaut, sauf là où vous l'avez corrigé : c'est aujourd'hui la principale source
      d'erreur de cette vue.</span>`;
  },

  quartiers: () => `
    <span class="lg"><i style="background:#dc2626"></i> Place pour une laverie</span>
    <span class="lg"><i style="background:#eab308"></i> Limite</span>
    <span class="lg"><i style="background:#15803d"></i> Pas de place</span>
    <span class="texte">Même calcul que la heatmap, résumé par ${
      state.perimetre === 'metropole' ? 'commune — une maille grossière qui dit où regarder, pas où signer' : 'quartier'
    }, à rayon fixe de 800 m. Cliquez une pastille : population, concurrence en place,
    part de marché et CA attendu.</span>`,

  offre: () => `
    <span class="texte">Chaleur = concentration des laveries existantes, pondérée par leur
    force concurrentielle (note Google lissée × machines en service). Cette vue ne montre
    <b>que l'offre</b> : une zone froide n'est pas forcément une opportunité, elle peut
    n'avoir aucun habitant.</span>`,

  aucune: () => `
    <span class="texte">Aucune surface d'analyse. Les laveries et leurs cercles de
    chalandise restent affichés — pratique pour repérer les rues et les locaux vacants.</span>`,
};

// Compte des grappes, mis à jour seul : régénérer toute la légende à chaque case
// cochée ferait perdre le focus du clavier sur la case qu'on vient d'utiliser.
function majLegendeZones() {
  const el = document.getElementById('legende-zones');
  if (!el) return;
  const zones = zonesBesoin();
  if (!zones.length) { el.textContent = 'Aucune zone détectée avec ces familles.'; return; }
  const affichees = Math.min(zones.length, MAX_PASTILLES);
  el.innerHTML = `<b>${zones.length} zones</b> détectées`
    + (affichees < zones.length
      ? ` — seules les <b>${affichees} premières</b> reçoivent une pastille, pour garder
         la carte lisible. Le classement est dans l'onglet <b>Analyse</b>.`
      : `, toutes numérotées.`)
    + ` Les regroupements de moins de ${MIN_MENAGES_ZONE} ménages restent colorés mais ne
       sont pas classés : c'est un immeuble isolé, pas un quartier.`
    + (map && map.getZoom() < ZOOM_PINS
      ? ` <b>Zoomez</b> pour faire apparaître le pin de chaque bâtiment — à cette échelle,
         ils recouvriraient entièrement les couleurs.`
      : '');
}

function majLegendeVue() {
  const el = document.getElementById('legende-vue');
  if (!el) return;
  el.innerHTML = LEGENDES[state.vue] ? LEGENDES[state.vue]() : '';
  majLegendeZones();
  // Les filtres de la vue « demande » vivent dans la légende : le HTML étant
  // régénéré à chaque rendu, on les rebranche ici.
  for (const c of el.querySelectorAll('[data-gentype]')) {
    c.addEventListener('change', () => {
      state.genTypes[c.dataset.gentype] = c.checked;
      // Masquer une famille change l'emprise et la teinte de la grille : elle est
      // à reconstruire, pas seulement à redessiner.
      invaliderGenerateurs();
      dessinerDemandeCaptive();
      dessinerZonesBesoin();
      majLegendeZones();
    });
  }
}

// ---------- MESURE DE L'EFFET D'UN RÉGLAGE ----------
//
// « Je ne comprends pas ce que ce curseur va impacter » est une critique juste :
// un modèle qui ne montre pas ses propres réactions demande un acte de foi. On
// affiche donc, après chaque mouvement, ce qui a RÉELLEMENT changé — le rang des
// zones et les euros —, y compris quand la réponse est « rien ».

function afficherToast(titre, corps, bouge) {
  const el = document.getElementById('toast-impact');
  if (!el) return;
  el.className = bouge ? 'bouge' : '';
  el.innerHTML = `<span class="titre">${titre}</span> — ${corps}`;
  clearTimeout(afficherToast._t);
  afficherToast._t = setTimeout(() => el.classList.add('hidden'), 9000);
}

function afficherImpact(libelle) {
  const av = state._empreinteAvant, ap = state._empreinte;
  if (!av || !ap) return;

  const tete = ap.ordre[0];
  const rangsChanges = ap.ordre.filter((id, i) => av.ordre[i] !== id).length;
  const teteChange = av.ordre[0] !== tete;
  const caAv = av.ca[tete], caAp = ap.ca[tete];
  const variation = caAv ? (caAp - caAv) / caAv : 0;
  const signe = variation >= 0 ? '+' : '−';

  if (!rangsChanges && Math.abs(variation) < 0.005) {
    afficherToast(`Impact de « ${libelle} »`,
      'aucun effet mesurable. Ni le classement des zones, ni les euros ne bougent — '
      + 'le résultat ne dépend donc pas de cette hypothèse.', false);
    return;
  }

  const bloc1 = teteChange
    ? `<b>la zone n°1 change : ${av.noms[av.ordre[0]]} → ${ap.noms[tete]}</b>`
    : `zone n°1 inchangée (<b>${ap.noms[tete]}</b>)`;
  const bloc2 = rangsChanges
    ? `${rangsChanges} zone${rangsChanges > 1 ? 's' : ''} sur ${ap.ordre.length} `
      + `${rangsChanges > 1 ? 'ont' : 'a'} changé de rang`
    : `aucune zone n'a changé de rang`;
  const bloc3 = Math.abs(variation) < 0.005
    ? 'son CA modélisé ne bouge pas'
    : `son CA modélisé : ${fmtEur(caAv)} → <b>${fmtEur(caAp)}</b> `
      + `(${signe}${Math.abs(variation * 100).toFixed(1)} %)`;

  afficherToast(`Impact de « ${libelle} »`, `${bloc1} · ${bloc2} · ${bloc3}`, teteChange);
}

// Les curseurs déclenchent un recalcul complet de la heatmap : on attend une
// courte pause avant de repeindre, sinon un glissement de souris déclenche
// cinquante recalculs et l'interface devient poisseuse.
function differer(cle, ms, fn) {
  differer._t = differer._t || {};
  clearTimeout(differer._t[cle]);
  differer._t[cle] = setTimeout(fn, ms);
}

// L'ancre du modèle doit refléter ce qu'on a MESURÉ, pas ce qu'on a supposé :
// quand les comptes annuels sont importés, le curseur se positionne tout seul
// sur la médiane observée et le dit.
function calerCurseurCaRef() {
  const s = document.getElementById('h-caref');
  const note = document.getElementById('caref-source');
  if (!s) return;
  const obs = caObserve();
  const val = caReference();
  // Le CA observé peut sortir des bornes prévues : on élargit plutôt que de
  // tronquer, sinon le curseur afficherait un chiffre faux.
  const arrondi = (x) => Math.round(x / 500) * 500;
  s.step = 500;
  s.min = Math.min(Number(s.min), arrondi(val * 0.5));
  s.max = Math.max(Number(s.max), arrondi(val * 1.6));
  s.value = arrondi(val);
  document.getElementById('h-caref-val').textContent = fmtInt(val);
  if (!note) return;
  note.innerHTML = obs
    ? `✅ Calé sur le <b>CA réellement publié par ${obs.n} laverie${obs.n > 1 ? 's' : ''}</b>
       (${obs.perimetre}, exercice ${obs.annee}) — médiane ${fmtEur(obs.mediane)},
       fourchette ${fmtEur(obs.min)} – ${fmtEur(obs.max)}. Ce n'est plus une hypothèse.`
    : `⚠ Aucun CA réel importé : cette valeur vient du dossier de marché, pas du terrain.
       Lancez <code>python3 scripts/import_entreprises.py</code> pour la remplacer par
       les comptes déposés au greffe.`;
}

// ---------- UI ----------

function initUI() {
  for (const b of document.querySelectorAll('.onglet')) {
    b.addEventListener('click', () => ouvrirOnglet(b.dataset.onglet));
  }
  document.getElementById('chip-fiabilite').addEventListener('click',
    () => ouvrirOnglet('modele'));
  for (const b of document.querySelectorAll('[data-perimetre]')) {
    b.addEventListener('click', () => changerPerimetre(b.dataset.perimetre));
  }

  document.getElementById('fiche-fermer').addEventListener('click', fermerFiche);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerFiche(); });
  document.getElementById('btn-export').addEventListener('click', exporterDonnees);
  window.addEventListener('beforeunload', (e) => {
    if (state.modifie) { e.preventDefault(); e.returnValue = ''; }
  });

  for (const id of ['f-chaine', 'f-independant', 'f-captif', 'f-voisines', 'l-couverture']) {
    document.getElementById(id).addEventListener('change', rafraichir);
  }

  // Choix de la vue : une surface d'analyse à la fois.
  for (const r of document.querySelectorAll('input[name="vue"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.vue = r.value;
      majLegendeVue();
      rafraichir();
    });
  }
  majLegendeVue();

  calerCurseurCaRef();

  const slider = document.getElementById('rayon');
  slider.addEventListener('input', () => {
    state.rayon = parseInt(slider.value, 10);
    document.getElementById('rayon-val').textContent = state.rayon;
    differer('rayon', 110, () => {
      const avant = state.derniereSimulation
        ? (state.derniereSimulation.caMin + state.derniereSimulation.caMax) / 2 : null;
      dessinerCouverture();
      dessinerHeatPotentiel();
      dessinerDemandeCaptive();
      if (state.derniereSimulation) {
        const d = state.derniereSimulation;
        simuler(d.lat, d.lon);
      }
      const apres = state.derniereSimulation
        ? (state.derniereSimulation.caMin + state.derniereSimulation.caMax) / 2 : null;
      // Le classement des quartiers est figé à 800 m par construction : le dire
      // explicitement évite de chercher un effet qui ne viendra pas.
      const simu = (avant && apres)
        ? ` Le local simulé passe de ${fmtEur(avant)} à <b>${fmtEur(apres)}</b>.`
        : '';
      afficherToast('Rayon de chalandise',
        `cercles, heatmap et simulateur recalculés à <b>${state.rayon} m</b>. `
        + `Le classement des zones, lui, ne bouge pas : il est volontairement figé `
        + `à ${RAYON_TENSION} m pour rester comparable d'une capture à l'autre.${simu}`,
        false);
    });
  });

  // Localiser un local précis
  document.getElementById('btn-aller').addEventListener('click', allerAAdresse);
  document.getElementById('adresse-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') allerAAdresse();
  });
  document.getElementById('btn-garder').addEventListener('click', garderCandidat);

  // Hypothèses ajustables : tout recalculer à chaque mouvement, puis annoncer ce
  // que le mouvement a réellement changé.
  //
  // `modele: false` marque les réglages qui ne touchent QUE le compte
  // d'exploitation. Leur appliquer la mesure d'impact ordinaire afficherait
  // « aucun effet », ce qui serait faux : ils changent le résultat net.
  const hyps = [
    { id: 'h-depense', val: 'h-depense-val', libelle: 'Dépense annuelle', modele: true,
      appliquer: v => { state.hyp.depenseMediane = v; return fmtInt(v); } },
    { id: 'h-demande', val: 'h-demande-val', libelle: 'Niveau de demande', modele: true,
      appliquer: v => { state.hyp.facteurDemande = v / 100; return v; } },
    { id: 'h-caref', val: 'h-caref-val', libelle: 'CA moyen du périmètre', modele: true,
      appliquer: v => { state.hyp.caReference = v; return fmtInt(v); } },
    { id: 'h-portee', val: 'h-portee-val', libelle: 'Portée avec parking', modele: true,
      appliquer: v => { state.hyp.porteeParking = v; return v.toFixed(1); } },
    { id: 'h-loyer', val: 'h-loyer-val', libelle: 'Loyer mensuel', modele: false,
      appliquer: v => { state.hyp.loyer = v; return fmtInt(v); } },
  ];
  for (const h of hyps) {
    const s = document.getElementById(h.id);
    s.addEventListener('input', () => {
      document.getElementById(h.val).textContent = h.appliquer(Number(s.value));
      document.getElementById('btn-reset-hyp').classList.remove('hidden');
      differer('hyp', 130, () => {
        rafraichir();
        if (state.derniereSimulation) {
          const d = state.derniereSimulation;
          simuler(d.lat, d.lon);
        }
        if (h.modele) {
          afficherImpact(h.libelle);
        } else {
          afficherToast(h.libelle,
            "ne change ni le chiffre d'affaires, ni la carte, ni le classement — "
            + 'seulement le résultat net, le point mort et le retour sur investissement '
            + 'du compte d\'exploitation.', false);
        }
      });
    });
  }
  document.getElementById('h-energie').addEventListener('change', (e) => {
    state.hyp.stressEnergie = e.target.checked;
    document.getElementById('btn-reset-hyp').classList.remove('hidden');
    if (state.derniereSimulation) simuler(state.derniereSimulation.lat, state.derniereSimulation.lon);
    afficherToast('Scénario stressé',
      e.target.checked
        ? "énergie et eau majorées de 30 % dans les charges. Le chiffre d'affaires et le "
          + 'classement sont inchangés : seul le résultat net se dégrade.'
        : 'charges revenues au niveau du secteur.', false);
  });

  document.getElementById('btn-reset-hyp').addEventListener('click', () => {
    state.hyp = { depenseMediane: null, facteurDemande: 1, caReference: null, poidsCaptif: 0.4, loyer: null, stressEnergie: false, porteeParking: 2.0 };
    const [dMin, dMax] = state.benchmarks.demande.clientele_reguliere.depense_annuelle_eur;
    document.getElementById('h-depense').value = (dMin + dMax) / 2;
    document.getElementById('h-depense-val').textContent = fmtInt((dMin + dMax) / 2);
    document.getElementById('h-demande').value = 100;
    document.getElementById('h-demande-val').textContent = 100;
    calerCurseurCaRef();
    document.getElementById('h-portee').value = 2;
    document.getElementById('h-portee-val').textContent = '2.0';
    document.getElementById('h-loyer').value = 1050;
    document.getElementById('h-loyer-val').textContent = fmtInt(1050);
    document.getElementById('h-energie').checked = false;
    document.getElementById('btn-reset-hyp').classList.add('hidden');
    rafraichir();
    if (state.derniereSimulation) simuler(state.derniereSimulation.lat, state.derniereSimulation.lon);
    afficherImpact('Retour aux valeurs du secteur');
  });

  const btn = document.getElementById('btn-simu');
  btn.addEventListener('click', () => {
    state.simulation = !state.simulation;
    btn.classList.toggle('active', state.simulation);
    btn.textContent = state.simulation ? '🎯 Cliquez sur la carte… (cliquer ici pour quitter)' : '📍 Activer le clic sur la carte';
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
