/* Laverie Mapper — Phase 1 (ville pilote : Pessac)
 *
 * Modèle volontairement simple et transparent :
 * - la demande est portée par les centroïdes de quartiers (à remplacer par le carroyage INSEE 200 m)
 * - la couverture est un rayon piéton paramétrable (à remplacer par des isochrones)
 * - le CA est une fourchette issue des benchmarks secteur, jamais un chiffre unique
 */

const TAILLE_MENAGE = 2.2; // personnes par ménage (moyenne France, à affiner par quartier via INSEE)

const state = {
  laveries: [],
  quartiers: [],
  benchmarks: null,
  rayon: 600,
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
  const [lav, qua, bench] = await Promise.all([
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
  dessinerCouverture();
  dessinerTension();
  dessinerHeat();
  majStats();
}

function popupLaverie(l) {
  const note = l.note_google != null ? `${l.note_google}/5 (${l.nb_avis ?? '?'} avis)` : 'non renseignée';
  const lignes = [
    ['Adresse', l.adresse],
    ['Quartier', l.quartier],
    ['Horaires', l.horaires ?? 'à relever'],
    ['Note Google', note],
    ['Machines', l.nb_lave_linge != null ? `${l.nb_lave_linge} LL / ${l.nb_seche_linge ?? '?'} SL` : 'à relever sur le terrain'],
    ['Surface', l.surface_m2 != null ? l.surface_m2 + ' m²' : 'à relever'],
    ['Prix cycle 8 kg', l.prix_cycle_8kg != null ? l.prix_cycle_8kg + ' €' : 'à relever'],
  ];
  const rows = lignes.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const verif = l.a_verifier ? `<p class="warn">⚠ Données partielles — position ${l.coord_precision === 'estimee' ? 'estimée' : 'exacte'}, fiche à compléter sur le terrain.</p>` : '';
  const notes = l.notes_terrain ? `<p class="warn" style="color:#94a3b8">${l.notes_terrain}</p>` : '';
  return `<div class="popup">
    <span class="tag tag-${l.type}">${LIBELLES[l.type]}${l.enseigne ? ' · ' + l.enseigne : ''}</span>
    <h3>${l.nom}</h3>
    <table>${rows}</table>
    ${notes}${verif}
  </div>`;
}

function dessinerMarqueurs() {
  state.layers.marqueurs.clearLayers();
  for (const l of laveriesVisibles()) {
    L.circleMarker([l.lat, l.lon], {
      radius: 9,
      color: '#fff',
      weight: 2,
      fillColor: COULEURS[l.type],
      fillOpacity: 0.95,
    }).bindPopup(popupLaverie(l), { maxWidth: 320 }).addTo(state.layers.marqueurs);
  }
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

// Tension = demande locale / offre accessible.
// Demande d'un quartier : ménages estimés sans lave-linge.
// Offre accessible : somme des laveries pondérées par la distance au centroïde.
function tensionQuartier(q) {
  const menages = q.population / TAILLE_MENAGE;
  const [pMin, pMax] = state.benchmarks.demande.part_menages_sans_lave_linge_pct;
  // La part de ménages sans lave-linge croît avec la part de petits logements.
  const partSansLL = (pMin + (pMax - pMin) * Math.min(1, q.part_petits_logements_est * 2.5)) / 100;
  const demande = menages * partSansLL;

  let offre = 0;
  for (const l of state.laveries.filter(x => x.statut === 'actif')) {
    const d = distanceM(q.lat, q.lon, l.lat, l.lon);
    offre += poidsConcurrence(l) * couverture(d, 800);
  }
  // ~150 ménages utilisateurs absorbés par laverie bien placée (ordre de grandeur benchmark)
  const capacite = offre * 150;
  return { demande, offre, ratio: demande / Math.max(capacite, 1) };
}

function couleurTension(ratio) {
  if (ratio < 0.8) return '#15803d';   // offre >= demande : saturé
  if (ratio < 1.6) return '#eab308';   // équilibré
  return '#dc2626';                    // demande >> offre : sous-équipé
}

function dessinerTension() {
  state.layers.tension.clearLayers();
  if (!document.getElementById('l-tension').checked) return;
  for (const q of state.quartiers) {
    const t = tensionQuartier(q);
    const label = t.ratio < 0.8 ? 'Zone saturée' : (t.ratio < 1.6 ? 'Marché équilibré' : 'Zone sous-équipée');
    L.circleMarker([q.lat, q.lon], {
      radius: Math.max(10, Math.sqrt(q.population) / 5),
      color: couleurTension(t.ratio),
      weight: 2,
      fillColor: couleurTension(t.ratio),
      fillOpacity: 0.30,
    }).bindPopup(`<div class="popup"><h3>${q.nom}</h3>
      <table>
      <tr><td>Population (est.)</td><td>${fmtInt(q.population)}</td></tr>
      <tr><td>Ménages cibles (est.)</td><td>~${fmtInt(t.demande)}</td></tr>
      <tr><td>Offre accessible</td><td>${t.offre.toFixed(2)} équiv. laverie</td></tr>
      <tr><td>Diagnostic</td><td><strong>${label}</strong></td></tr>
      </table>
      <p class="warn">${q.commentaire ?? ''}</p></div>`, { maxWidth: 300 })
      .addTo(state.layers.tension);
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

  // 1. Population et ménages cibles captés dans la zone
  let popCouverte = 0;
  let menagesCibles = 0;
  const [pMin, pMax] = b.demande.part_menages_sans_lave_linge_pct;
  for (const q of state.quartiers) {
    const d = distanceM(lat, lon, q.lat, q.lon);
    const w = couverture(d, R);
    if (w < 0.05) continue;
    popCouverte += q.population * w;
    const partSansLL = (pMin + (pMax - pMin) * Math.min(1, q.part_petits_logements_est * 2.5)) / 100;
    menagesCibles += (q.population * w / TAILLE_MENAGE) * partSansLL;
  }

  // 2. Concurrence : part de marché façon Huff simplifié
  //    attractivité égale pour tous, décroissance gaussienne avec la distance
  let pressionConcurrence = 0;
  const concurrents = [];
  for (const l of state.laveries.filter(x => x.statut === 'actif')) {
    const d = distanceM(lat, lon, l.lat, l.lon);
    if (d < 2 * R) {
      const p = poidsConcurrence(l) * couverture(d, R);
      pressionConcurrence += p;
      if (p > 0.05) concurrents.push({ nom: l.nom, d: Math.round(d), type: l.type });
    }
  }
  const partMarche = 1 / (1 + pressionConcurrence);
  const menagesCaptes = menagesCibles * partMarche;

  // 3. CA : ménages réguliers captés × dépense annuelle + usage ponctuel (gros volumes)
  const [depMin, depMax] = b.demande.depense_annuelle_menage_utilisateur_eur;
  const caMin = menagesCaptes * depMin * 1.20; // +20% usage ponctuel (hypothèse basse)
  const caMax = menagesCaptes * depMax * 1.40; // +40% usage ponctuel (hypothèse haute)

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
    Ménages cibles (sans lave-linge) : <b>~${fmtInt(menagesCibles)}</b><br>
    Part de marché estimée : <b>${Math.round(partMarche * 100)} %</b><br>
    <br><b>Concurrence dans la zone :</b><br>${listeConc}<br><br>
    CA potentiel annuel : <span class="ca">${fmtEur(caMin)} – ${fmtEur(caMax)}</span><br>
    EBE indicatif (${margeMin}–${margeMax} % du CA) : ${fmtEur(caMin * margeMin / 100)} – ${fmtEur(caMax * margeMax / 100)}
    <div class="verdict ${verdictCls}">${verdictTxt}</div>
    <p class="hint">Modèle simplifié (centroïdes de quartier, rayon ${R} m, Huff à attractivité égale). Les hypothèses sont dans data/benchmarks.json.</p>`;
}

// ---------- UI ----------

function initUI() {
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
