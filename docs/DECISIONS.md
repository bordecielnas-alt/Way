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

## V1 : portes

Construites **sans IA**, à partir des relations Wikidata (`packages/core/src/doors.ts`) :

| Porte | Choix |
|---|---|
| 🕰️ Ici, plus tard (ou plus tôt) | entités datées à moins de 8 km (40 km si les environs sont vides), plus tard si possible ; célébrité pondérée, les entités après 1900 comptent moins |
| 🌍 Pendant ce temps | même époque (± une demi-tranche), à plus de 1 500 km ; cache d'abord, sinon requête mondiale |
| 🔗 La suite | suite ou conséquence explicite (P156, P1542…), sinon la partie suivante du même ensemble (P361 : la bataille suivante d'une guerre), sinon un événement du même protagoniste ; « Avant cela » en dernier recours |
| ❓ Surprise | voisin peu connu (2 à 40 langues), d'une autre catégorie |

Routes, stations et communes créées par des réformes modernes sont exclues de « ici » et « surprise ».
Les portes sont cherchées en parallèle à l'ouverture d'une fiche, servies au fur et à mesure,
mises en cache (colonne `related`, versionnée) ; les fiches de destination sont préchargées.

## V1 : zoom sémantique

L'importance ajoute un léger poids par catégorie (empires +0,08, lieux non classés −0,1). Le front
cache les points dont l'importance est sous un seuil qui monte avec l'altitude ; l'échelle
« Majeurs / Sélection / Tout » le décale. Les filtres géographiques du brief (montagnes, forêts,
fleuves) n'ont pas de sens ici : ces entités ne sont presque jamais datées.

## V1 : cache borné

Plafond `CACHE_MAX_MB` (10 Go), vérifié une minute après le démarrage puis toutes les heures.
Mesure : taille logique des lignes (~800 octets par POI). Éviction des moins vus, puis des plus
anciennement vus ; importance ≥ 0,75 épinglée. Les clés de recherche des zones touchées sont oubliées.

## V1 : niveau 2 (IA + web)

- **Déclenchement** : après une recherche de niveau 1 sur une zone régionale ou plus fine (résolution
  ≥ 5), s'il reste moins de 5 POI pour la période. Les clés passent `partial`, le niveau 2 tourne dans
  une file à part (un à la fois) pour ne jamais retarder le niveau 1.
- **Chaîne** : nom de la zone (Nominatim inverse) → recherche web (Wikipédia sans clé, puis Tavily,
  Brave, SearXNG si configurés) → extraction JSON par IA, validée par Zod → géocodage indépendant
  (Wikidata puis Nominatim, 1 req/s) → contrôles §7 → cache et push.
- **Garde-fous** : chaque fait cite une source réellement fournie ; date dans la tranche ; lieu à moins
  de 1,8 rayon de la zone ; doublons écartés (≤ 10 km, ± 10 ans, titres proches) ; importance plafonnée
  à 0,35 ; `verified` si Wikipédia est citée, `disputed` si l'IA signale des sources contradictoires,
  sinon `web_single_source`. La fiche dit « rédigée par IA ».
- **Routeur** (`packages/core/src/router.ts`, config `packages/core/providers.default.json`, remplaçable
  par `PROVIDERS_FILE`) : tous les LLM du brief passent par leur API compatible OpenAI. Quotas par
  minute et par jour avec 5 % de marge (compteurs du jour conservés dans `/data`), disjoncteur
  (429 immédiat, sinon 2 échecs de suite, 10 min), routes par tâche (`extract` rapide, `write` meilleur),
  mode dégradé si tout est épuisé. Page `/admin.html`.
- **Tâche `write`** : traduit en français les résumés disponibles seulement en anglais (signalé sur la fiche).
- **Quotas vérifiés en septembre 2026** : Gemini 2.5 Flash-Lite 15/min et 1 000/jour, Flash 10/min et
  250/jour ; Groq 30/min et 1 000/jour. Brave n'a plus d'offre gratuite sans carte bancaire (le
  dépassement est facturé) : présent mais inactif sans clé. Gemini avec ancrage Google Search n'est pas
  utilisé : il n'est pas exposé par l'API compatible OpenAI.

## Réglages et compte

- Page **Réglages** (`/admin.html`, roue dentée sur le globe) : interrupteur du niveau 2, clés et adresses
  des fournisseurs, modèle de chaque IA, activation par fournisseur, bouton **Tester** (un vrai appel,
  compté dans les quotas), état des quotas, mot de passe.
- Enregistrés dans `/data/settings.json` (droits 600). Ils passent **devant** les variables
  d'environnement ; effacer une valeur rend la main à la variable. Pris en compte sans redémarrage
  (relu toutes les 3 s, y compris par un worker séparé). Les clés ne sont jamais renvoyées en entier
  au navigateur (4 derniers caractères).
- **Un compte** (`admin`, mot de passe par défaut `way`, bandeau tant qu'il n'est pas changé). Hash
  scrypt dans `/data/auth.json`. Session = cookie signé HMAC, HttpOnly, SameSite=Strict, 30 jours ;
  changer le mot de passe renouvelle la clé de signature (déconnecte les autres appareils). 5 échecs →
  5 min de blocage pour cette adresse. Écritures refusées si l'en-tête Origin est d'un autre site.
- Protégé : réglages et état (`/api/settings`, `/api/admin`). Le globe reste ouvert sans compte.
- Mot de passe oublié : supprimer `/data/auth.json` et redémarrer.

## Marqueurs, sons et territoires

- **Marqueurs façon jeu de stratégie** : pion dessiné (jeton biseauté sur un mât, ombre au sol), forme et
  pictogramme par catégorie (bouclier et épées croisées pour une bataille, hexagone et couronne pour un
  État…), cerclage or / argent / bronze selon l'importance. Pseudo-3D sur canvas : de vrais modèles 3D
  coûteraient bien plus cher pour des centaines de points. Plus d'agrandissement selon la distance (il
  floutait l'image) ; le globe est rendu à la densité de l'écran, plafonnée à 1,5×.
- **Survol** : rester 350 ms sur un point ouvre sa fiche (sans déplacer la caméra) ; le clic vole jusqu'au point.
- **Sons** synthétisés par Web Audio (aucun fichier à héberger ni licence), un par catégorie et un pour les
  territoires. Réglages → Interface (activé par défaut, volume), commun à tous les appareils.
- **Clic sur un territoire** : détourage lumineux (couche d'imagerie limitée au territoire, l'empire avec
  ses vassaux) et fiche : nom français, type, dates, emblème, capitale, régime, religion, langues,
  dirigeant(s) à l'année de la timeline, résumé Wikipédia.
  - Les frontières (historical-basemaps) ne donnent qu'un nom anglais approximatif (« Rome », « Castille »,
    « Mamluke Sultanate ») : candidats Wikidata par recherche de libellé et recherche plein texte
    Wikipédia, notés sur le type (État, État historique), les dates (couvrent l'année ; un État encore
    existant est pénalisé avant 1800), la ressemblance du nom et la notoriété. Sans candidat suffisant,
    la fiche le dit.
  - Dirigeants : P35, titulaires de la fonction P1906, titulaires d'un office de monarque de ce
    territoire (P1001). Un règne sans date de fin s'arrête au suivant. Hors règne connu, seuls les
    voisins à moins de 30 ans sont montrés.
  - Cache disque `/data/polities.json`.
- **Noms en filigrane** : capitales espacées, taille selon l'étendue, plus transparents de près,
  masqués au-delà de l'horizon. Traduits en français quand la correspondance est sûre (même nom),
  cherchés en tâche de fond, une à la fois, en pause dès que Wikimedia demande de ralentir (429) ou
  qu'une fiche est demandée. Les zones sans nom dans les données sont en gris neutre.

## Hors V1 (prévu)

Histogramme de densité, bouton Play, carnet de voyage, brouillard de connaissance, fils rouges,
campagnes animées, préchargement nocturne.

## Limites connues

- Noms des territoires : en anglais tant que la traduction n'est pas trouvée ou pas sûre. Rapprochement avec Wikidata automatique, donc parfois faux sur les noms vagues (« Hunter-gatherers »).
- Wikimedia limite le débit : premier clic sur un territoire parfois lent (jusqu'à une minute) si le serveur vient de beaucoup interroger Wikidata ; ensuite en cache.
- Le mode multi-services (Redis/BullMQ) n'a pas été exécuté ; le mode conteneur unique est testé.
- Niveau 2 : testé avec des fournisseurs simulés (tests) et les adaptateurs sans clé en réel ; pas encore
  avec une vraie clé d'IA.
