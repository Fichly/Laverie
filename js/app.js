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

// Poids concurrentiel d'une laverie : les laveries captives (CROUS) ne captent
// qu'une partie de la demande de leur zone, elles pèsent moins dans le modèle.
function poidsConcurrence(laverie) {
  return laverie.type === 'captif' ? 0.4 : 1.0;
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
  const [lav, qua, bench] = window.__DATA__
    ? [window.__DATA__.laveries, window.__DATA__.quartiers, window.__DATA__.benchmarks]
    : await Promise.all([
      fetch('data/laveries.json').then(r => r.json()),
      fetch('data/quartiers.json').then(r => r.json()),
      fetch('data/benchmarks.json').then(r => r.json()),
    ]);
  state.laveries = lav.laveries;
  state.quartiers = qua.quartiers;
  state.benchmarks = bench;
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

function laveriesVisibles() {
  const types = typesActifs();
  return state.laveries.filter(l => types.includes(l.type) && l.statut === 'actif');
}

function rafraichir() {
  dessinerMarqueurs();
  dessinerListe();
  dessinerCouverture();
  dessinerTension();
  dessinerHeat();
  dessinerClassement();
  majStats();
}

function dessinerMarqueurs() {
  state.layers.marqueurs.clearLayers();
  state.marqueurs = {};
  for (const l of laveriesVisibles()) {
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

  const machines = l.nb_lave_linge != null
    ? `${l.nb_lave_linge} lave-linge / ${l.nb_seche_linge ?? '?'} sèche-linge` : null;

  return `
    ${galerie(l)}
    <div class="fiche-corps">
      <span class="tag tag-${l.type}">${LIBELLES[l.type]}${l.enseigne ? ' · ' + l.enseigne : ''}</span>
      <h2>${l.nom}</h2>
      ${noteBloc}
      <div class="fiche-actions">
        <a href="${urlMaps}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        <a href="${urlStreet}" target="_blank" rel="noopener">👁️ Street View</a>
      </div>
      <div class="fiche-infos">
        ${ligneInfo('📍', l.adresse)}
        ${ligneInfo('🏘️', l.quartier, 'quartier à définir')}
        ${ligneInfo('🕐', l.horaires, 'horaires à relever')}
        ${ligneInfo('📞', l.telephone, 'téléphone inconnu')}
        ${ligneInfo('🧺', machines, 'nombre de machines à relever sur place')}
        ${ligneInfo('📐', l.surface_m2 ? l.surface_m2 + ' m²' : null, 'surface à relever sur place')}
        ${ligneInfo('💶', l.prix_cycle_8kg ? l.prix_cycle_8kg + ' € le cycle 8 kg' : null, 'prix à relever sur place')}
        ${l.site_web ? ligneInfo('🌐', `<a href="${l.site_web}" target="_blank" rel="noopener" style="color:var(--accent)">site web</a>`) : ''}
      </div>
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
  const visibles = laveriesVisibles();
  ul.innerHTML = visibles.map(l => {
    const note = l.note_google != null
      ? `${l.note_google}★${l.nb_avis != null ? `<br><span style="font-weight:400;font-size:0.62rem">${l.nb_avis} avis</span>` : ''}`
      : 'n.c.';
    return `<li data-id="${l.id}">
      <span class="dot dot-${l.type}"></span>
      <span class="nom">${l.nom}<span class="meta">${l.quartier ?? 'quartier à définir'}</span></span>
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
  const points = laveriesVisibles().map(l => [l.lat, l.lon, poidsConcurrence(l)]);
  state.layers.heat = L.heatLayer(points, { radius: 45, blur: 30, maxZoom: 15, max: 1.5 }).addTo(map);
}

// Part de ménages sans lave-linge dans un quartier : elle croît avec la part de
// petits logements (studios et T1 sont rarement équipés).
function partClienteleReguliere(q) {
  const c = state.benchmarks.demande.clientele_reguliere;
  const [pMin, pMax] = c.part_menages_pct;
  const facteur = Math.min(1, q.part_petits_logements_est / c.seuil_petits_logements_borne_haute);
  return (pMin + (pMax - pMin) * facteur) / 100;
}

// CA médian d'une laverie du secteur : référence à laquelle on compare une zone.
function caReference() {
  const [min, max] = state.benchmarks.exploitation.ca_annuel_laverie_eur;
  return (min + max) / 2;
}

// Demande accessible depuis un point : agrège les quartiers voisins pondérés par
// la distance. La demande ne s'arrête pas à la frontière d'un quartier, un
// habitant du quartier d'à côté à 300 m est un client tout aussi probable.
function demandeAccessible(lat, lon, R) {
  const [ppMin, ppMax] = state.benchmarks.demande.clientele_ponctuelle.part_menages_concernes_pct;
  const partPonctuelle = ((ppMin + ppMax) / 2) / 100;
  let pop = 0, reguliers = 0, ponctuels = 0;
  for (const q of state.quartiers) {
    const w = couverture(distanceM(lat, lon, q.lat, q.lon), R);
    if (w < 0.05) continue;
    pop += q.population * w;
    const menages = q.population * w / TAILLE_MENAGE;
    const reg = menages * partClienteleReguliere(q);
    reguliers += reg;
    ponctuels += (menages - reg) * partPonctuelle;
  }
  return { pop, reguliers, ponctuels };
}

// Pression concurrentielle exercée sur un point par les laveries existantes.
function offreAccessible(lat, lon, R) {
  let pression = 0;
  const concurrents = [];
  for (const l of state.laveries.filter(x => x.statut === 'actif')) {
    const d = distanceM(lat, lon, l.lat, l.lon);
    const p = poidsConcurrence(l) * couverture(d, R);
    if (p < 0.01) continue;
    pression += p;
    if (p > 0.05) concurrents.push({ nom: l.nom, d: Math.round(d), type: l.type });
  }
  return { pression, concurrents };
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
  const b = state.benchmarks;
  const dem = demandeAccessible(lat, lon, R);
  const { pression, concurrents } = offreAccessible(lat, lon, R);
  const partMarche = 1 / (1 + pression);

  const [regMin, regMax] = b.demande.clientele_reguliere.depense_annuelle_eur;
  const [ponMin, ponMax] = b.demande.clientele_ponctuelle.depense_annuelle_eur;
  const regCaptes = dem.reguliers * partMarche;
  const ponCaptes = dem.ponctuels * partMarche;

  const caMin = regCaptes * regMin + ponCaptes * ponMin;
  const caMax = regCaptes * regMax + ponCaptes * ponMax;
  const caMed = (caMin + caMax) / 2;

  return {
    ...dem, pression, concurrents, partMarche, regCaptes, ponCaptes,
    caMin, caMax, caMed,
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
  const visibles = laveriesVisibles();
  const grandPublic = state.laveries.filter(l => l.type !== 'captif' && l.statut === 'actif');
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

  const [margeMin, margeMax] = b.exploitation.marge_ebe_pct;
  const listeConc = concurrents.length
    ? concurrents.sort((a, c) => a.d - c.d).map(c => `• ${c.nom} (${c.d} m)`).join('<br>')
    : 'Aucun concurrent significatif dans la zone.';

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
    EBE indicatif (${margeMin}–${margeMax} % du CA) : ${fmtEur(caMin * margeMin / 100)} – ${fmtEur(caMax * margeMax / 100)}
    <div class="verdict ${verdictCls}">${verdictTxt}</div>
    <p class="hint">Modèle simplifié (centroïdes de quartier, rayon ${R} m, Huff à attractivité égale). Les hypothèses sont dans data/benchmarks.json.</p>`;
}

// ---------- UI ----------

function initUI() {
  document.getElementById('fiche-fermer').addEventListener('click', fermerFiche);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerFiche(); });

  for (const id of ['f-chaine', 'f-independant', 'f-captif', 'l-couverture', 'l-heat-offre', 'l-tension']) {
    document.getElementById(id).addEventListener('change', rafraichir);
  }
  const slider = document.getElementById('rayon');
  slider.addEventListener('input', () => {
    state.rayon = parseInt(slider.value, 10);
    document.getElementById('rayon-val').textContent = state.rayon;
    dessinerCouverture();
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
    Lavage 8 kg : <b>${b.prix.lavage_6_8kg_eur[0]}–${b.prix.lavage_6_8kg_eur[1]} €</b> ·
    18 kg : <b>${b.prix.lavage_16_18kg_eur[0]}–${b.prix.lavage_16_18kg_eur[1]} €</b><br>
    CA annuel type : <b>${fmtEur(b.exploitation.ca_annuel_laverie_eur[0])} – ${fmtEur(b.exploitation.ca_annuel_laverie_eur[1])}</b><br>
    Marge EBE : <b>${b.exploitation.marge_ebe_pct[0]}–${b.exploitation.marge_ebe_pct[1]} %</b> ·
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
