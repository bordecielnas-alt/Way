# BRIEF PROJET — Globe historique explorable (nom de code : *Way*)

> **Usage de ce document** : c'est le brief de référence du projet. Il sert de prompt de départ pour une nouvelle conversation avec un assistant de code.
> Les décisions marquées **[ACTÉ]** ont été discutées et validées : ne pas les remettre en question sans raison nouvelle. Les points marqués **[OUVERT]** restent à trancher.

---

## 0. Instructions pour l'assistant qui reprend ce brief

- Tu reprends un projet **au stade de la conception**. Aucun code n'existe encore.
- Commence par proposer la **structure du repo** et le **docker-compose**, puis implémente le **MVP V0** (section 12) de façon incrémentale et testable.
- Respecte les décisions **[ACTÉ]**. Si tu vois un problème bloquant, signale-le avant de dévier.
- Projet **personnel / passion**, pour un seul utilisateur à ce stade : privilégie la simplicité, pas la scalabilité prématurée.
- Langue du produit (UI, fiches) : **français**. Code et commentaires : anglais.

---

## 1. Vision

> **Un globe vivant où l'on voyage dans 7 000 ans d'histoire (de −5000 à aujourd'hui). Chaque point raconte un fait vérifié et ouvre des portes vers ailleurs, avant ou après. On y entre pour 5 minutes, on en ressort 2 heures plus tard.**

- Une carte de la Terre façon Google Earth : zoom, rotation, vol de caméra.
- Une **timeline** qui fait avancer ou reculer le temps de −5000 à aujourd'hui.
- Des **points d'intérêt** qui apparaissent selon le lieu, l'époque et les filtres : villes, batailles, monuments, personnages, événements, armées, découvertes…
- **L'utilisateur ne tape jamais de prompt.** C'est sa balade (position, zoom, temps) et ses filtres qui pilotent automatiquement les recherches en back.
- Le volume de données étant potentiellement infini, **le contenu est cherché dynamiquement** (APIs ouvertes + recherche web IA) puis mis en cache, **pas pré-stocké**.

### Moment « wow » visé
**L'addiction à la balade** : se promener des heures de point en point, comme on se perd sur Wikipedia ou dans Google Earth.

---

## 2. Cible et ton [ACTÉ]

| Axe | Choix |
|---|---|
| Public | Grand public curieux |
| Plateforme | **Web desktop** d'abord (mobile plus tard, éventuellement) |
| Ton | **Encyclopédique et rigoureux** : aucun fait sans source |
| Statut | Projet perso / passion, **usage personnel** à ce stade |
| Hébergement | **Auto-hébergé, Docker Compose**, comme les autres projets de l'auteur |
| Budget | **0 €** : uniquement des services gratuits, avec fallback entre eux |

---

## 3. Principes produit

1. **La balade avant tout.** Chaque décision répond à : « est-ce que j'ai envie de cliquer sur le point suivant ? »
2. **Rigueur visible.** Chaque fait affiche sa source et un niveau de confiance. Pas de source, pas d'affichage. Une zone vide vaut mieux qu'une invention.
3. **Fluidité.** Globe et timeline à 60 fps. La latence des recherches est masquée par un affichage progressif (les points « s'allument »).
4. **Le monde change avec le temps.** Frontières, empires et toponymes évoluent quand on bouge la timeline.
5. **Zéro configuration.** On ouvre, c'est déjà vivant.

---

## 4. Expérience utilisateur

### 4.1 Écran principal
- **Globe 3D** plein écran.
- **Timeline** en bas.
- **Panneau latéral** à droite pour la fiche du point sélectionné.
- **Filtres** en haut à gauche.

### 4.2 Timeline
- Plage : **−5000 → année courante**.
- **Échelle non linéaire** : compressée dans l'Antiquité, dilatée à l'époque moderne (la densité d'information varie d'un facteur ~1000).
- **Histogramme de densité** au-dessus du curseur : montre où il y a des choses à voir (sur les données en cache).
- **Bouton Play** avec vitesse réglable (voir les empires grandir et s'effondrer).
- L'utilisateur sélectionne une **fenêtre temporelle** (ex. −500 → −300), pas une date ponctuelle.
- Affichage des années : « 450 av. J.-C. », « 1789 ».

### 4.3 Zoom sémantique
| Niveau caméra | Contenu affiché |
|---|---|
| Globe | Empires, grandes migrations, événements majeurs |
| Continent / région | Royaumes, grandes villes, batailles, campagnes |
| Ville | Monuments, sièges, personnages, quartiers |
| Site | Anecdotes, bâtiments, découvertes archéologiques |

Le choix de ce qui s'affiche repose sur un **score d'importance** (section 6.3) et un clustering des points proches.

### 4.4 Fiche d'un point
- Titre, date (avec incertitude : « vers −2500 », « IIᵉ siècle »), lieu.
- Résumé court (3 à 6 phrases), neutre et factuel.
- Image si disponible (URL Wikimedia Commons, jamais stockée).
- **Sources cliquables.**
- **Badge de confiance** : ✅ vérifié / 🔎 source web unique / ⚠️ débattu.
- **Les « portes »** (section 4.5).

### 4.5 Les portes : moteur de l'addiction
Chaque fiche se termine par **3 ou 4 portes** choisies, pas une liste de liens :
- 🕰️ **Ici, plus tard** (ou plus tôt) : même lieu, autre époque.
- 🌍 **Pendant ce temps** : même époque, ailleurs dans le monde.
- 🔗 **La suite** : conséquence, personnage ou événement lié.
- ❓ **Surprise** : fait étonnant et vérifié à proximité.

Cliquer une porte déclenche un **vol de caméra** et un **déplacement de la timeline** vers la destination. Les destinations des portes sont **préchargées** pendant la lecture de la fiche.

### 4.6 Progression (discrète, pas gadget)
- **Carnet de voyage** : historique visuel de la balade, tracé sur le globe.
- **Brouillard de connaissance** : les zones et époques non explorées sont légèrement voilées.
- Pas de badges ni de points : ça casserait le ton encyclopédique.

### 4.7 Filtres
- **Thématiques** : guerres et batailles, politique et empires, religion, science et techniques, art et architecture, commerce et routes, explorations, catastrophes, personnages.
- **Géographie** : villes, montagnes, forêts, fleuves, sites naturels.
- **Échelle d'impact** : majeurs seulement ↔ tout.

---

## 5. Architecture de la recherche [ACTÉ]

### 5.1 Principe
Rien n'est pré-stocké en masse. Quand l'utilisateur **s'arrête** sur une zone et une époque, le back cherche, structure, valide, met en cache et pousse les résultats au front.

### 5.2 Déclenchement
1. **Debounce** : la recherche part après ~800 ms sans mouvement (caméra ou timeline).
2. Le front calcule les **clés de recherche** visibles : `cellule H3 × tranche de temps × jeu de filtres`.
3. Pour chaque clé : si elle est en cache, affichage immédiat ; sinon mise en file d'attente et abonnement WebSocket.

### 5.3 Découpage spatial : H3
Résolution H3 selon l'altitude de la caméra (valeurs indicatives, à calibrer) :

| Vue | Résolution H3 |
|---|---|
| Globe | 1–2 |
| Continent | 3 |
| Région | 4 |
| Ville | 6 |
| Site | 7–8 |

### 5.4 Découpage temporel (tranches fixes)
| Période | Taille de tranche |
|---|---|
| −5000 → −1000 | 250 ans |
| −1000 → 500 | 50 ans |
| 500 → 1500 | 25 ans |
| 1500 → 1800 | 10 ans |
| 1800 → 1900 | 5 ans |
| 1900 → aujourd'hui | 1 an |

### 5.5 Cascade de recherche
1. **Niveau 1, rapide (< 1 s), toujours exécuté**
   - **Wikipedia GeoSearch** (articles autour de coordonnées).
   - **Wikidata SPARQL** (entités avec coordonnées et dates dans la zone et la tranche).
   - Résultats poussés immédiatement au front.
2. **Niveau 2, lent (5 à 20 s), si la zone est pauvre** (moins de N points pertinents, N à calibrer)
   - Recherche web, puis LLM : extraction structurée (quoi, où, quand, source).
   - Validation (section 7), puis mise en cache et push.
3. **Préchargement en tâche de fond** : cellules voisines et destinations des portes du point affiché.

### 5.6 UX de la latence
Pas de spinner bloquant : les points **apparaissent progressivement** sur le globe (effet « la carte se révèle »). Un indicateur discret montre qu'une recherche est en cours sur la zone.

---

## 6. Données

### 6.1 Modèle d'un point d'intérêt (POI)
```
id                 : uuid
title              : string
summary            : string (FR, 3–6 phrases)
category           : enum (battle, city, monument, person, event, discovery, disaster, trade, religion, art, science, nature, ...)
tags               : string[]
date_start         : int (année, négative avant J.-C.)
date_end           : int | null
date_precision     : enum (exact_year, decade, century, approximate)
lat, lon           : float
geo_precision      : enum (exact, city, region, approximate)
h3_cells           : index H3 à plusieurs résolutions
importance         : float 0–1
confidence         : enum (verified, web_single_source, disputed)
provenance         : enum (wikidata, wikipedia, web_ai)
sources            : [{ url, title, kind }]  // au moins 1, obligatoire
image_url          : string | null (Wikimedia Commons)
wikidata_qid       : string | null
related            : [{ poi_id | qid, relation: later_here | meanwhile | consequence | surprise }]
created_at, last_viewed_at, view_count
```

### 6.2 Table des clés de recherche (cache)
```
key                : h3_cell + time_bucket + filter_hash
status             : pending | done | partial | failed
fetched_at         : timestamp
providers_used     : string[]
poi_ids            : uuid[]
```
Une clé `done` récente n'est jamais re-cherchée. TTL long (plusieurs mois) : l'histoire change peu.

### 6.3 Score d'importance
Combinaison de : nombre de langues Wikipedia (sitelinks Wikidata), pages vues si dispo, nombre de liens entrants, catégorie. Les POI issus du web ont un score estimé par le LLM, plafonné.

### 6.4 Cache borné [ACTÉ]
- **Plafond : ~10 Go** pour le cache POI (1 POI ≈ 1–3 Ko, donc plusieurs millions de points possibles).
- **Éviction** : quand le plafond approche, suppression des POI les moins vus depuis le plus longtemps. Les POI très importants sont épinglés.
- **Images jamais stockées** : URL directes vers Wikimedia Commons.

### 6.5 Seules données statiques hébergées
- **Frontières historiques** : GeoJSON du projet *historical-basemaps* (aourednik, GitHub), quelques dizaines de Mo. Ce sont des instantanés à certaines années : afficher l'instantané le plus proche antérieur à la date courante. **Vérifier la licence** avant usage.
- Le **fond de carte** (imagerie, relief) n'est **pas** auto-hébergé : chargé directement par le front depuis un fournisseur de tuiles gratuit, configurable (respecter les conditions d'usage du fournisseur).

---

## 7. Rigueur : garde-fous obligatoires [ACTÉ]

1. **Sortie structurée** du LLM (schéma JSON validé). Chaque POI doit avoir au moins une URL source.
2. **Le LLM ne fournit pas les coordonnées finales** : il donne un nom de lieu, qui est **géocodé** via Wikidata puis Nominatim (OpenStreetMap, en respectant sa limite de 1 requête/s).
3. **Contrôles de cohérence** : la date tombe dans la tranche demandée, le point tombe dans la cellule (ou une voisine).
4. **Recoupement** : fait confirmé par Wikidata ou Wikipedia, `verified` ; sinon `web_single_source` ; si les sources divergent, `disputed`.
5. **Déduplication** : fusion des POI proches (espace, temps, titre similaire, même QID).
6. **Prompts LLM** : consigne explicite de ne rien inventer, de répondre « rien trouvé » plutôt que d'extrapoler, de rester neutre.
7. **Contenu textuel** : résumés reformulés, pas de copie longue des sources.

---

## 8. Fournisseurs et fallback [ACTÉ]

### 8.1 Décision : services gratuits avec API officielle uniquement
- ❌ **Pas de scraping de Copilot, de Google AI Overviews ni d'aucune interface web conçue pour les humains** : c'est contraire à leurs conditions d'utilisation, bloqué par des CAPTCHA (à ne jamais contourner), fragile et à risque de bannissement d'IP.
- ✅ À la place, on utilise les **équivalents légitimes à tier gratuit**, via leurs API officielles.
- ⚠️ Les quotas gratuits changent souvent : **les vérifier au moment de l'implémentation** et les mettre en configuration, pas en dur.

### 8.2 Chaîne recherche (ordre indicatif)
1. **Wikipedia API + Wikidata SPARQL** : gratuits, sans clé, toujours en premier.
2. **Gemini API avec ancrage Google Search** : l'équivalent légitime de « Google search IA ».
3. **Brave Search API** (tier gratuit).
4. **Tavily** (crédits gratuits).
5. **SearXNG auto-hébergé** : métamoteur local en dernier recours. Usage modéré, les moteurs amont peuvent le limiter.

### 8.3 Chaîne LLM (ordre indicatif)
1. **Gemini API** (tier gratuit).
2. **Groq** (tier gratuit, très rapide).
3. **GitHub Models** (gratuit avec un compte GitHub, l'accès légitime le plus proche de « Copilot »).
4. **OpenRouter** (modèles gratuits) ou **Mistral** (tier gratuit).
5. **Ollama local** : dernier recours, **tâches de fond uniquement** (section 9).

### 8.4 Routeur de fournisseurs
- Interface commune par couche : `search(query, context)` et `complete(prompt, schema)`.
- **Compteurs de quota** par fournisseur (par minute et par jour) dans Redis. On bascule **avant** d'atteindre la limite.
- **Disjoncteur** : sur erreur 429 ou 5xx répétée, le fournisseur est mis de côté un temps configurable (ex. 10 min).
- **Réinitialisation** des compteurs selon la période de chaque fournisseur.
- **Routage par tâche** : extraction et classification vers les modèles rapides ; rédaction des fiches et choix des portes vers les meilleurs modèles disponibles.
- **Mode dégradé** : si tout est épuisé, on sert uniquement Wikipedia, Wikidata et le cache.
- **Configuration** : un fichier (YAML ou JSON) listant fournisseurs, clés (via variables d'environnement), quotas, priorités. Ajouter un fournisseur ne doit demander qu'un adaptateur et une entrée de config.
- **Observabilité** : logs par appel (fournisseur, tâche, latence, succès) et une page admin simple avec l'état des quotas et des disjoncteurs.

---

## 9. Infrastructure [ACTÉ]

### 9.1 Machine hôte
- **4 cœurs** d'un i9-9900K alloués.
- **25 Go de RAM**.
- **SSD 50 Go**, extensible.
- **Pas de GPU** pour l'instant.

### 9.2 LLM local (Ollama)
- Sans GPU sur 4 cœurs : petits modèles quantifiés (3 à 8 milliards de paramètres), **quelques tokens/seconde**.
- **Jamais en interactif.** Uniquement : extraction structurée en tâche de fond, préchargement nocturne, secours quand les services gratuits sont épuisés.
- **Limiter à 2 cœurs** pour ne pas étouffer l'API.
- Service **optionnel** (profil Docker Compose), désactivable.

### 9.3 Services Docker Compose
| Service | Rôle | RAM indicative |
|---|---|---|
| `front` | Build statique servi par nginx | ~50 Mo |
| `api` | HTTP + WebSocket ; cache d'abord, sinon mise en file | ~300 Mo |
| `worker` | Routeur de fournisseurs, cascade, validation, géocodage | ~500 Mo |
| `redis` | File de jobs, quotas, disjoncteurs, cache chaud | ~200 Mo |
| `postgres` (PostGIS) | Cache persistant borné, frontières historiques | 1–2 Go |
| `searxng` | Métamoteur local de secours | ~300 Mo |
| `ollama` *(profil optionnel)* | LLM local de dernier recours | 6–10 Go |

Total estimé : 3 à 13 Go de RAM, 15 à 25 Go de disque. Ça tient sur la machine.

- Configuration par fichier `.env` (clés API, plafonds, profils).
- Volumes nommés pour Postgres, Redis et les modèles Ollama.
- Healthchecks sur chaque service.

---

## 10. Stack technique (choix libre laissé à l'assistant, proposition par défaut)

- **Monorepo TypeScript** : types partagés (schéma POI, clés de recherche) entre front, API et worker.
- **Front** : Vite + TypeScript + **CesiumJS** (globe 3D, horloge et timeline natives, vols de caméra). Timeline non linéaire en composant maison. Framework UI léger au choix pour les panneaux.
- **API** : Node.js (Fastify) + WebSocket.
- **Worker** : Node.js + **BullMQ** (file de jobs sur Redis).
- **Validation** : Zod (schémas partagés, validation des sorties LLM).
- **Spatial** : `h3-js` ; PostGIS pour les requêtes spatiales.
- **Base** : PostgreSQL + PostGIS, migrations versionnées.
- Si l'assistant juge une autre stack clairement meilleure, il peut la proposer en justifiant.

### Structure de repo suggérée
```
/apps/front        # globe, timeline, panneaux
/apps/api          # HTTP + WebSocket
/apps/worker       # jobs, routeur de fournisseurs, pipeline
/packages/shared   # types, schémas Zod, utilitaires H3 et temps
/packages/providers# adaptateurs recherche et LLM
/infra             # docker-compose, config nginx, config searxng
/data              # frontières historiques (GeoJSON)
/docs              # ce brief, décisions
```

### API (esquisse)
- `GET /api/pois?cells=...&tStart=&tEnd=&filters=` : POI en cache pour les clés demandées, et mise en file des clés manquantes.
- `WS /ws` : abonnement à des clés ; réception des POI au fil de l'eau.
- `GET /api/poi/:id` : fiche complète.
- `GET /api/poi/:id/doors` : portes (calculées ou mises en file).
- `GET /api/borders?year=` : frontières de l'instantané approprié.
- `GET /api/admin/providers` : état des quotas et disjoncteurs.

---

## 11. Risques et points d'attention

- **Biais des sources** : Wikipedia et le web sont très eurocentrés. Sans effort, l'Afrique, les Amériques et l'Asie centrale paraîtront vides avant 1500. Le niveau 2 (recherche web IA) doit viser explicitement ces zones pauvres.
- **Sujets sensibles** : frontières contestées, colonisation, génocides. Ton neutre, sources, marquage `disputed`.
- **Quotas gratuits** : ils peuvent changer ou disparaître. Le routeur et le mode dégradé sont la réponse.
- **Politesse envers les API ouvertes** : respecter les limites de Wikipedia, Wikidata et Nominatim (User-Agent identifiable, débit limité, cache).
- **Armées et trajectoires** : spectaculaires mais impossibles à générer de façon fiable par IA. Réservées à des campagnes curées à la main (V2).
- **Frontières historiques** : ce sont des instantanés approximatifs. À présenter comme tels.

---

## 12. Roadmap

### V0 — « La balade marche-t-elle ? »
Objectif : valider le plaisir de la balade, avec le niveau 1 seulement.
- Docker Compose opérationnel (front, api, worker, redis, postgres).
- Globe Cesium avec timeline non linéaire.
- Recherche **niveau 1 uniquement** (Wikipedia GeoSearch + Wikidata), avec cache et push WebSocket.
- Fiche avec résumé, image, source, badge.
- Frontières historiques animées.
- Vol de caméra vers un point.

### V1 — L'IA et les portes
- Routeur de fournisseurs avec fallback (recherche + LLM), quotas, disjoncteurs, page admin.
- Recherche **niveau 2** avec validation et géocodage.
- **Portes** (4 types) avec préchargement.
- Filtres thématiques et zoom sémantique complet avec score d'importance.
- Cache borné avec éviction.

### V2 — Immersion
- Carnet de voyage et brouillard de connaissance.
- Histogramme de densité sur la timeline, bouton Play.
- **Fils rouges** : suivre une personne (Alexandre, Marco Polo, Ibn Battuta), une marchandise (soie, épices), une idée (écriture, imprimerie), une épidémie (peste noire).
- Campagnes militaires animées, curées à la main (Hannibal, Gengis Khan, Napoléon…).
- Ollama local et préchargement nocturne.

---

## 13. Points ouverts [OUVERT]

- **Nom du projet** (plus tard).
- Fournisseur de **tuiles de fond de carte** gratuit à retenir (vérifier les conditions d'usage).
- Calibrage : résolutions H3 par zoom, seuil N de « zone pauvre », taille du plafond de cache.
- Point de départ à l'ouverture : dernier endroit visité, ou « un moment au hasard » (lieu et date aléatoires) pour surprendre.
- Ambiance sonore par époque (idée d'immersion, non prioritaire).
- Ouverture à d'autres utilisateurs plus tard : à ce moment, revoir la stratégie de quotas et le préchargement.

---

## 14. Inspirations existantes (pour se différencier)
Chronas, GeaCron, Running Reality, OpenHistoricalMap, OldMapsOnline, Histography, Google Earth Voyager.
**Différenciateur** : aucun ne mise vraiment sur la **balade addictive guidée par des portes**, alimentée par une recherche dynamique et sourcée.
