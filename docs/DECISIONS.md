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
| 🌍 Pendant ce temps | à un an près, à plus de 1 500 km ; cache d'abord, sinon requête mondiale |
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

Plafond réglable dans Réglages → Cache, de 0,5 à 100 Go (par défaut `CACHE_MAX_MB`, 10 Go), vérifié une
minute après le démarrage, toutes les heures et à chaque changement. Les images en prennent la moitié au plus ;
les points ont le reste.
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
  Désactivé par défaut (Réglages → Interface).
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

## Découpage, lecture, chargement

- **Sons** façon jeu de stratégie, toujours synthétisés : tambours de guerre, cors et fanfares (dents de
  scie désaccordées, filtre qui s'ouvre, vibrato), chœur (formants), cloches et métal (partiels
  inharmoniques), réverbération de salle commune (réponse impulsionnelle générée), compresseur.
- **Territoire → régions → sous-régions** : 2e clic dans le territoire sélectionné = découpage ; clic sur
  une région = sa fiche ; 2e clic dessus = découpage à son tour. Les cartes historiques ne dessinent que
  les États : les régions viennent de Wikidata (P131, P150, P17 et P361 vers le territoire, quatre
  requêtes simples en parallèle, la réunion en une seule expirant), filtrées par type (duché, comté,
  province, satrapie, eyalet…), par dates (qualificatifs du lien, sinon création / dissolution) et au
  premier niveau seulement. Leur tracé est **estimé** : le territoire est partagé entre les chefs-lieux
  (diagramme de Voronoï découpé au contour, bordures en pointillés), ce que la fiche signale. Sans
  subdivision connue à la date, la fiche le dit.
- **Cache et fraîcheur** : fiches et listes de régions en cache disque (`/data/polities.json`) et dans le
  navigateur (localStorage, 250 entrées) : affichage immédiat, puis vérification en arrière-plan, la fiche
  n'étant redessinée que si elle a changé. Côté serveur, une entrée de plus de 14 jours est reprise de
  Wikidata en tâche de fond ; les noms sans correspondance sont retentés au bout de 7 jours. Quand un nom
  de la carte est rapproché de Wikidata en tâche de fond, sa fiche est préparée aussi.
- **Priorité aux clics** : les requêtes d'une fiche passent devant les recherches de fond et peuvent
  prendre une place de plus auprès de Wikidata (3 au lieu de 2).
- **Correspondance** : un État encore existant (France) ne gagne plus d'office avant 1800 : les variantes
  « Kingdom of X » / « X Empire » sont toujours essayées. Les anciennes correspondances sont recalculées.
- **« Pendant ce temps »** ignore les événements de plus d'un an (20 ans avant ; réglable, Réglages → Interface).
- **Lecture** : bouton ▶ sur la timeline (ou Espace). Pas automatique (l'unité de l'époque : 1 an au
  XXe siècle, bien plus dans l'Antiquité) ou fixe, toutes les 1 à 10 s. La fenêtre garde sa durée en
  années.
- **Chargement des points** : recherche lancée 450 ms après l'arrêt (au lieu de 800), et préchargement
  des périodes juste avant et après la fenêtre, en file basse priorité qui ne tourne que quand la file
  principale est vide (24 recherches au plus, sans niveau 2).

## Frontières à l'année, personnages, armées

- **Frontières à l'année** : [Cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria)
  (Seshat Global History Databank, CC BY 4.0) remplace les ~50 instantanés d'historical-basemaps à
  partir de −3400 : ~1 600 entités, 13 765 polygones datés à l'année, 509 périodes distinctes. Le
  fichier (165 Mo) est simplifié au kilomètre et quantifié au 0,01° pendant la construction de l'image
  (`scripts/build-cliopatria.ts` → 23 Mo) ; une période pèse 80 à 200 Ko et le navigateur la garde
  (URL versionnée, `immutable`). Avant −3400, les instantanés restent.
- **Vassaux réels** : Cliopatria décrit les royaumes composites (« (Kingdom of France) ») et leurs
  membres (domaine royal, duchés, comtés). Le 2e clic découpe selon ces vraies frontières, déjà chargées,
  sans requête ; les chefs-lieux Wikidata (Voronoï) ne servent plus qu'en dessous. Les découpages estimés
  sont gardés en mémoire.
- **Noms peints façon jeu de stratégie** : dans les tuiles des frontières, en capitales espacées, nom
  court (« FRANCE »), le long de l'axe principal du royaume (analyse en composantes principales,
  inclinaison ≤ 30°) sur une parabole passant par le milieu de ses sections, taille selon l'étendue ;
  ils apparaissent et s'effacent avec le zoom. Le nom du royaume découpé laisse place à ceux de ses régions.
- **Noms français** : les entités Cliopatria portent leur élément Wikidata : libellés par lots de 50,
  sans recherche. Le jeu de données relie parfois un autre élément (la Restauration pour le royaume
  médiéval, « sultan » pour un sultanat) : les dates de l'élément doivent couvrir l'époque (± 50 ans) et
  son nom anglais nommer le même lieu, sinon le titre est traduit par motif (« Duchy of Athens » →
  « duché d'Athens ») et la fiche cherche par nom.
- **Cache renforcé** : fiches, régions et libellés gardés 90 jours (6 mois depuis, réglable) avant vérification (noms introuvables
  retentés après 30 jours), recherches échouées retentées après 1 h, 600 entrées dans le navigateur.
- **Personnages suivis** (panneau Personnages, mémorisé par navigateur) : parcours tiré de Wikidata en
  trois requêtes simples (naissance, mort, résidences P551, études P69, lieux de travail P937 / P108,
  fonctions P39, moments P793 / P1344, événements où la personne est participante ou commandante
  P710 / P4791), gardé 180 jours. Entre deux lieux connus, le personnage attend, puis voyage en ligne
  droite au rythme d'un voyageur (~6 000 km/an) ; un événement daté le retient une part de la fenêtre
  (1/10), pour que la lecture année par année attrape les batailles. Fonctions sans lieu (empereur,
  consul) : décrivent l'attente sans déplacer. Guerres et révolutions ne servent pas de lieu (leurs
  coordonnées sont un centre de carte). Trois styles : figurine, médaillon (portrait Wikimedia), étendard,
  avec un signe d'activité (couronne, épées, livre, sablier, flèche de route…).
- **Armées** (masquables) : par décennie, les guerres ayant une bataille datée, puis toutes leurs
  batailles (deux requêtes : la requête imbriquée échouait côté WDQS). Une bataille citée par plusieurs
  guerres va à la plus précise ; chaque guerre donne une armée par camp (les deux plus cités, P710 non
  humains, commandants en qualificatif P4791), qui marche de bataille en bataille (~3 000 km/an).
  Affichées pour une fenêtre de 120 ans au plus.
- **Sons importés** : Réglages → Interface, un fichier audio par type (mp3, ogg, wav, m4a, flac ; 3 Mo),
  gardé dans `/data/sounds`, joué à la place du son synthétisé. Orbis n'embarque aucun son de jeu
  commercial (droits d'auteur) ; chacun peut importer les fichiers qu'il possède.

## Blasons, lecture au jour, cache configurable

- **Blasons** (panneau de gauche, rubrique Blasons ; mémorisé par navigateur) : armoiries (P94), à défaut
  drapeau (P41), de l'élément Wikidata de chaque royaume, seulement quand son nom a été vérifié pour
  l'époque (sinon on afficherait les armes de la Restauration sur le royaume médiéval). Le fichier en
  usage à l'année vient des qualificatifs P580 / P582 ; sans dates, un fichier dont le nom annonce une
  autre époque (« (1901–1952) ») ou une invention (« Fictitious ») est écarté. Dessinés en filigrane sous la
  couleur du royaume, derrière le milieu de son nom, sur un calque à part : un blason qui arrive ne
  redessine pas les frontières.
- **Armées** (même rubrique) : bannière au drapeau du camp à la décennie de la guerre. Les soldats portent
  la couleur de leur pays sur la carte (depuis la version suivante, voir plus bas).
- **Affrontement** : deux armées ou plus à la même bataille (même élément Wikidata) au même moment :
  épées croisées sur un éclat, entre les camps écartés de part et d'autre.
- **Lecture au jour** : pas de 1 jour, 1 semaine, 1 mois, puis 1 à 100 ans, cadence dès 0,5 s. Choisir un
  pas ramène la fenêtre à la largeur d'un pas (un jour commence à minuit). Les dates sont des années
  décimales, un jour valant 1/365 (29 février ignoré) ; les dates Wikidata « à l'année » tombent le
  1er janvier. Points et frontières restent à l'année (fenêtre de moins d'un an = son année) ; personnages
  et armées bougent au jour, un événement les retenant 2 jours au moins.
- **Images par le serveur** : portraits, photos, blasons et drapeaux passent par `/api/media` et sont
  gardés sur disque (`/data/media`, les moins récemment vus retirés d'abord). Même origine : ils peuvent être
  peints sur la carte. Demandés directement aux serveurs d'images de Wikimedia (chemin tiré du MD5 du nom),
  aux largeurs standard (60, 120, 250, 330, 500, 960, 1280 px) : `Special:FilePath` et les autres largeurs
  sont limités en rafale. Le User-Agent porte l'adresse du projet : sans contact, les serveurs d'images
  répondent 429 (politique robots de Wikimedia).
- **Cache configurable** (Réglages → Cache) : taille (0,5 à 100 Go), délai avant revérification des fiches,
  noms, blasons, parcours et armées (1 mois à 5 ans, ou jamais ; 6 mois par défaut), images gardées ou non,
  bouton pour vider les images. Les armées de la décennie suivante sont préchargées pendant la lecture.

## Trajets, défilement, géographie

- **Blasons sourcés** : un fichier n'est montré que si une source le date pour l'année : qualificatifs P580 /
  P582 ; ou années dans son nom autour de l'année ; ou royaume du passé (P576, dissous) vivant à cette date.
  Le drapeau sans date d'un pays actuel n'est plus pris (Espagne de 1806). Un nom qui contredit les dates de la
  déclaration l'emporte (« Flag of Spain (1760–1785) » écarté en 1806 malgré des dates plus larges ; une année
  seule bien plus tardive, « Arms of Prussia 1873 », aussi). Sans blason sourcé : rien.
- **Filigrane sur tout le territoire** : le blason couvre la plus grande pièce du royaume depuis le milieu de
  son nom, découpé à ses frontières, estompé vers les bords (dégradé radial), à 28 % au plus sous la couleur.
- **Couleur des armées** : celle du pays sur la carte, même teinte que ses frontières. Le camp est cherché par
  son élément Wikidata, sinon par les racines de son nom en anglais ou en français (« Première République
  française », « France » et « Empire français » se rejoignent sur « fran »), le plus grand royaume d'abord.
- **Trajets réalistes et bateaux** : grille du monde à 0,25° tirée de Natural Earth (domaine public, 50 m :
  terres, lacs, fleuves de rang 5 au plus ; Bosphore, Dardanelles, Øresund, Kertch, Messine, Gibraltar ouverts à
  la main), 44 Ko, construite une fois par `scripts/build-geo.ts`. Recherche A* entre deux lieux, à pied (terre,
  rives) ou à bord (mer, lacs, fleuves). Coûts par km : marche 1, fleuve 0,75, mer 0,8 ; embarquer en mer vaut
  400 km (20 jours de marche pour réunir une flotte), sur un fleuve 80, débarquer 30. D'où : on contourne une
  baie, on traverse la Méditerranée, on descend un grand fleuve seulement sur une longue distance. À bord, le
  temps passe trois fois moins. Sans chemin trouvé (l'autre bout du monde) : ligne droite, à bord au-dessus de
  l'eau. Recherches en quelques millisecondes (Paris–Moscou 6 ms, Toulon–Alexandrie 3 ms), gardées en
  mémoire ; 25 ms au plus par image, le reste juste après. Les personnages suivent les mêmes chemins.
- **Défilement** : ◂◂◂ ◂◂ ◂ ❚❚ ▸ ▸▸ ▸▸▸ ; chaque cran va trois fois plus vite ; sous 150 ms entre deux pas,
  les pas s'allongent. Clavier : ← recule (plus vite à chaque appui), → avance, ↓ pause, Espace lecture / pause.
  En pas auto, une fenêtre de moins d'un an avance de sa propre largeur.
- **Curseur fin** : une fenêtre de moins de 24 px se saisit entière (sans poignées) et se déplace au jour près
  près du point de saisie, puis de plus en plus vite (8 px = un jour, 300 px ≈ un an pour une fenêtre d'un
  jour). Flèches sur la frise : une fenêtre à la fois (dix avec Maj).
- **« Pendant ce temps »** : à un an près de l'événement, quelle que soit l'époque (avant : une demi-tranche,
  25 ans dans l'Antiquité).
- **Géographie** (panneau de gauche) : relief (ombrage Esri World Hillshade), fleuves et lacs (Natural Earth,
  dessinés en tuiles, les petits apparaissant en descendant), et l'occupation du sol MODIS 2001 (NASA GIBS,
  classes IGBP) repeinte classe par classe : forêts, savanes et maquis, prairies et steppes, déserts, marais,
  glaces. Cultures et villes laissées de côté (d'aujourd'hui). 2001, la plus ancienne année, pour le moins de
  défrichements récents. Tuiles de NASA passées par le serveur et gardées avec les images (`/api/geo/landcover`).

## Thèmes, fonds, lentilles et recherche continue

- **Nom** : l'application s'appelle **Orbis** (UI, titres, User-Agent). Paquets `@way/*`, image Docker,
  dossier de données et variable `WAY_CONTACT` gardent leur nom, pour ne pas casser les installations.
- **Thèmes ≠ catégories** : une catégorie dit ce qu'est un point (un château), un thème de quoi il parle
  (la guerre). Onze thèmes (`packages/shared/src/themes.ts`) regroupent les catégories ; deux catégories
  nouvelles : fortification (sortie de « monument ») et expédition. Cache des classes versionné (`v2:`) pour
  reclasser.
- **Personnages transversaux** : leurs thèmes viennent de leurs métiers (P106) et fonctions (P39), remontés
  par P279* vers des racines (monarque → pouvoir, clerc → religion…), gardés dans `tags` (`role:<thème>`).
  Un personnage s'affiche si l'un de ses rôles est visible (ou s'il n'en a aucun connu).
- **Fond des territoires**, exclusif : politique, religieux, aucun. Religion d'un État : P3075 (officielle,
  poids ×2) et P140, rang préféré ×3, datées par qualificatifs ; familles par P279*/P361/P140. Les cultes
  « antiques et traditionnels » ne s'additionnent pas (ce sont des religions distinctes).
- **Lentilles** : filtres tout prêts (Stratège, Pèlerin, Marchand, Savant, Voyageur, Bâtisseur).
- **Recherche continue** : tant que la vue ne bouge pas, le front demande toutes les 4 s un anneau de
  cellules H3 de plus autour d'elle (8 au plus ; en vue lointaine, les périodes voisines, 4 au plus). Les
  points trouvés sont gardés en mémoire et apparaissent sans animation. L'étape 0 enrichit la vue par le
  niveau 2 (web + IA) même si elle n'est pas pauvre, 2 zones à la fois, puis de nouveau après 30 jours.
- **Statut discret** : plus de « Zone explorée » ; un point qui pulse pendant la recherche, un sablier
  quand l'IA cherche (clés `partial`).

## Couleurs des blasons, affinage en fond, frontières en lecture

- **Couleur d'un royaume** : la couleur dominante de son blason (sinon de son drapeau), mesurée dans le
  navigateur sur une copie 40×40 (plus grande surface d'une même teinte ; argent, sable, blanc et gris écartés,
  car ce sont le champ et les contours de la plupart des armes). Teinte fixe par royaume en l'absence de blason.
  Même couleur pour son territoire, ses armées et ses vassaux blasonnés. Couleurs gardées par le navigateur
  (`orbis:tints:v2`).
- **Blasons manquants** : nouvelles sources (image de l'élément « blason » P237 ou « drapeau » P163, sceau
  P158) ; un royaume trouvé sans blason est recherché à nouveau après 3 jours.
- **Affinage en arrière-plan** : toutes les 90 s, si personne ne clique et que peu de travail attend, le serveur
  passe en revue *tous* les royaumes de Cliopatria (les plus durables d'abord), 50 noms, 50 blasons et
  50 religions à la fois, avec les pauses déjà en place entre deux requêtes Wikidata. L'avancement est
  affiché dans la page Réglages.
- **Frontières pendant la lecture** : les périodes s'enchaînent sans attendre l'arrêt de la frise ; la
  suivante attend que la précédente soit peinte (ou 1,5 s), donc la carte suit aussi vite que la machine
  dessine, sans jamais passer par un écran vide. Le territoire sélectionné garde son contour, et ses vassaux
  sont redessinés à chaque période. Pendant la lecture, les armées ne prennent que 2 connexions et les
  nouvelles images de blasons attendent l'arrêt : les frontières passent devant.

## Royaumes suivis de près

- **Intérêt** : chaque clic sur un royaume compte 1 (ouvrir ses régions, 0,5) ; le score est divisé par deux
  toutes les deux semaines et gardé dans le cache des territoires.
- **Fraîcheur selon l'intérêt** : ce qu'on sait d'un royaume (nom, blason, religion, fiche politique —
  gouvernement, souverains —, régions) est revérifié après le délai des Réglages divisé par 1 + 4 × intérêt,
  jamais plus d'une fois par jour. Ce qui manque (pas de blason, pas de religion, fiche sans gouvernement ni
  souverain, pas de régions) est recherché à nouveau après 3 jours divisés par 1 + 2 × intérêt, au plus
  toutes les 6 h. C'est la mécanique des blasons, étendue à la religion et à la politique.
- **Au clic** : ce qui est périmé pour ce royaume est mis en tête du travail de fond, juste après la réponse
  (la fiche s'affiche d'abord depuis le cache). Le navigateur redemande blasons et religions 20 s plus tard,
  puis toutes les 3 min, pour montrer le changement.
- **Balayage** : les royaumes suivis passent avant les autres ; leur fiche et leurs régions sont revérifiées
  (3 royaumes par passage). La page Réglages indique combien de royaumes sont suivis de près.

## Hors V1 (prévu)

Histogramme de densité, carnet de voyage, brouillard de connaissance, fils rouges,
préchargement nocturne, couche des langues, fronts de diffusion (épidémies, religions, techniques),
rivages anciens.

## Limites connues

- Noms des territoires : en anglais tant que la traduction n'est pas trouvée ou pas sûre ; titre traduit par motif sinon, le lieu restant en anglais (« duché d'Athens »).
- Frontières Cliopatria : couverture des vassaux inégale selon les régions et les époques ; en dessous, régions estimées.
- Personnages : aussi précis que Wikidata ; un personnage peu renseigné (naissance et mort seulement) attend puis traverse la carte.
- Trajets : grille de 28 km ; pas de montagnes ni de routes (on franchit les Alpes comme la plaine) ; côtes de 2020 ; les détroits fins ouverts à la main seulement.
- Géographie : terres d'aujourd'hui (forêts de 2001, pas celles du Moyen Âge) ; couverture du sol détaillée au mieux à 600 m.
- Couleur des armées : un camp dont ni l'élément ni le nom ne se retrouvent sur la carte garde une teinte à lui.
- Armées : seules les batailles rattachées à une guerre (P361) et localisées ; les camps viennent des participants de chaque bataille. Austerlitz, par exemple, n'est rattachée à aucune guerre dans Wikidata : pas d'armées ni d'affrontement ce jour-là.
- Blasons : aussi justes que Wikidata ; moins de royaumes en ont (67 en 1806 contre 83), faute de source qui date le fichier.
- Lecture au jour : points et frontières restent à l'année ; un événement daté à l'année seulement tombe le 1er janvier.
- Régions : tracé approximatif ; couverture Wikidata inégale (bonne pour l'Empire ottoman, le Saint-Empire, la France ; faible pour les niveaux fins : aucun comté rattaché au duché de Bourgogne).
- Sons : vérifiés sans erreur, pas à l'oreille.
- Rôles des personnages et nouvelles catégories : seulement pour les points trouvés après cette version ;
  les anciens gardent leur catégorie (un château reste « monument ») jusqu'à éviction du cache.
- Fond religieux : seulement pour les années couvertes par Cliopatria, et aussi juste que Wikidata (beaucoup
  d'États sans religion renseignée, en gris).
- Wikimedia limite le débit : premier clic sur un territoire parfois lent (jusqu'à une minute) si le serveur vient de beaucoup interroger Wikidata ; ensuite en cache.
- Le mode multi-services (Redis/BullMQ) n'a pas été exécuté ; le mode conteneur unique est testé.
- Niveau 2 : testé avec des fournisseurs simulés (tests) et les adaptateurs sans clé en réel ; pas encore
  avec une vraie clé d'IA.
