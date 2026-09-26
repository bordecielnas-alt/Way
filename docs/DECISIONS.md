# Décisions techniques (V0)

Complète le [brief](BRIEF.md). Chaque point dit ce qui a été choisi et pourquoi.

## Recherche niveau 1 : deux stratégies selon le zoom

Mesures sur WDQS (septembre 2026) :

- Une requête `wikibase:around` + filtre de date en rayon 300 km autour de Rome **expire** (> 60 s)
  si le filtre spatial n'est pas forcé en premier. Avec une sous-requête nommée (`WITH … AS %geo`),
  elle prend 1 à 27 s selon la densité.
- Une requête « temps d'abord » à l'échelle **mondiale** (entités datées dans une tranche, ayant des
  coordonnées et au moins 5 liens Wikipédia) prend 6 à 13 s.

D'où :

| Vue (résolution H3 d'affichage) | Clé de recherche | Requête |
|---|---|---|
| Globe, continent (res ≤ 3) | `g\|tranche\|filtre` | mondiale, temps d'abord, `sitelinks ≥ 5`, max 1200 |
| Région, ville, site (res ≥ 4) | `cellule\|tranche\|filtre` | rayon autour d'un ancêtre H3 commun (1 ou 2 niveaux au-dessus), + GeoSearch Wikipédia à res ≥ 6 |

Une requête mondiale remplit toutes les cellules d'un coup ; les cellules fines voisines sont
regroupées en une seule requête. Les tranches de 1 à 5 ans contiguës sont fusionnées (≤ 10 ans par requête).

## Clés et récupération

- Le format des clés suit le brief (§6.2). La table `search_keys` ne sert qu'à la **couverture**
  (`pending` / `done` / `failed`) ; les POI sont retrouvés par appartenance H3 : `pois.h3_cells` contient
  la cellule du point aux résolutions 0 à 8 (index GIN), et l'API renvoie les N plus importants par cellule
  visible. Pas besoin de `poi_ids` dans `search_keys`.
- Une clé `pending` de plus de 10 min ou `failed` de plus de 10 min est relancée.
- La résolution d'affichage est choisie pour que la vue tienne en ~48 cellules.

## Dates

- Années **historiques** sans an 0 (−753 = 753 av. J.-C.). WDQS renvoie des années astronomiques :
  conversion à la frontière (`packages/providers/src/wikidata.ts`).
- Date d'ancrage : P585 (date) > P580 (début) > P571 (fondation). Fin : P582 ou P576.
- Un POI s'affiche si son intervalle `[date_start, date_end]` recoupe la fenêtre de la timeline.

## Catégories

Les classes Wikidata (P31) sont rattachées à des classes racines par `P279*`, avec cache par classe
(table `class_categories`). Priorité en cas de conflit : bataille > catastrophe > État > ville > religion > …
**Si l'ordre de priorité change, vider `class_categories`.**

## Rigueur

- Un POI n'est créé que si l'entité a un article Wikipédia (fr, sinon en) : il porte toujours au moins
  deux sources (article + élément Wikidata) et est validé par le schéma Zod `Poi`.
- Le résumé est l'introduction Wikipédia, récupérée à la première ouverture de la fiche puis mise en cache.
  Si seul l'anglais existe, la fiche le signale.
- Niveau de confiance V0 : toujours `verified` (Wikidata + Wikipédia). `web_single_source` et `disputed`
  arriveront avec le niveau 2.

## Front

- CesiumJS sans Cesium ion. Fond « Relief » : **Esri World Physical Map** (relief naturel sans frontières
  modernes, routes ni noms, jusqu'au niveau 8) + **ombrage Esri** plus fin (jusqu'au niveau 13) mêlé en zoom
  rapproché. Natural Earth II livré avec Cesium s'arrêtait au niveau 2 : pixellisé dès l'échelle d'un pays.
  Bascule satellite (Esri par défaut, configurable).
- Frontières dessinées **tuile par tuile** à la résolution de chaque tuile (trait net à tout zoom), dans un
  budget de 6 ms par image pour ne pas saccader. Fondu enchaîné entre instantanés. Couleur par entité
  suzeraine (`SUBJECTO`), donc les empires apparaissent d'un seul tenant. Atténuées en zoom rapproché.
- Performances : rendu à la demande (`requestRenderMode`, aucune image calculée quand rien ne bouge),
  pas de MSAA, entités créées seulement pour les POI de la fenêtre et des filtres actifs, survol limité à
  un pick par image et suspendu pendant le glisser.
- Timeline : échelle par morceaux (`packages/shared/src/timeline.ts`). La fenêtre garde sa largeur
  **visuelle** en se déplaçant, elle couvre donc naturellement plus d'années dans l'Antiquité.
- Point de départ : dernier endroit et dernière fenêtre (localStorage), sinon la Méditerranée de −500 à −300.

## Déploiement : un seul conteneur

Le brief prévoyait six services Compose. À la demande de l'auteur, l'image publiée est **unique** :
un processus Node sert le front, l'API et le WebSocket, exécute les recherches (file en mémoire) et
stocke le cache dans un **Postgres embarqué** (PGlite, fichiers dans `/data/pgdata`). Mêmes migrations
et même code SQL que Postgres. Les frontières sont téléchargées dans `/data/borders` au premier démarrage.

Le code multi-services reste disponible (`DATABASE_URL` pour un Postgres externe, `REDIS_URL` + `apps/worker`
pour une file BullMQ) si la charge le justifie un jour.

## Hors V0 (prévu)

Niveau 2 (IA + web), routeur de fournisseurs, portes, SearXNG, Ollama, éviction du cache,
histogramme de densité, bouton Play, carnet de voyage. Le service `searxng` du brief n'est pas encore
dans le compose : il n'a pas d'usage avant le niveau 2.

## Limites connues

- Libellés des frontières en anglais (données sources).
- Le mode multi-services (Redis/BullMQ) n'a pas été exécuté ; le mode conteneur unique est testé.
