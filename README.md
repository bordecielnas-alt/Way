# Orbis — globe historique explorable

Un globe où l'on voyage dans 7 000 ans d'histoire. Voir [docs/BRIEF.md](docs/BRIEF.md) pour la vision
et [docs/DECISIONS.md](docs/DECISIONS.md) pour les choix techniques.

**État : V1** — globe Cesium, timeline non linéaire, recherche niveau 1 (Wikidata + Wikipédia)
avec cache et push WebSocket, fiches sourcées, frontières historiques animées, vol de caméra.

## Démarrer

### Docker : un seul conteneur

```bash
docker run -d --name way -p 8080:8080 -v ./data-way:/data ghcr.io/bordecielnas-alt/way:latest
```

Puis ouvrir http://localhost:8080. Tout est dans l'image (site, API, recherche, Postgres embarqué) ;
tout ce qui persiste est dans `/data`. Au premier démarrage, les frontières historiques (~66 Mo) se
téléchargent en arrière-plan. Variable optionnelle : `WAY_CONTACT` (un contact ajouté à l'adresse du projet dans les requêtes à Wikimedia).

Recherche approfondie par IA (facultatif) : dans l'application, roue dentée ⚙ en haut à gauche →
**Réglages** (compte `admin`, mot de passe `way` à changer dans l'onglet Compte). Coller au moins une
clé gratuite (Gemini ou Groq), **Tester**, c'est actif tout de suite. Les variables d'environnement
(`GEMINI_API_KEY`, `GROQ_API_KEY`…, liste dans
[packages/core/providers.default.json](packages/core/providers.default.json)) marchent aussi ; une valeur
saisie dans les réglages les remplace.

Sur le globe : frontières datées à l'année, noms des royaumes peints sur la carte, deux États voisins toujours de
couleurs bien distinctes. Menu **Carte** : fond politique, **religieux** (la religion officielle ou dominante, sinon
celle de ses prédécesseurs, de son nom ou de ses voisins, en pointillés) ou **cultures** (le peuple de chaque État,
sinon sa langue, en grandes familles : Latins, Germaniques, Slaves, Turcs, Sémites… ou « Plusieurs peuples »). Clic sur un territoire
= sa fiche ; nouveau clic dedans = découpage en vassaux et provinces (frontières de l'époque, ou limites
estimées à défaut), et ainsi de suite. Panneau **Personnages** (en bas à gauche) : suivre un ou plusieurs
personnages (études, voyages, combats, couronnement…) et afficher les armées en campagne ; rubrique
**Blasons** : armoiries en filigrane sur les territoires, drapeaux sur les armées (en bateau sur la mer et les
grands fleuves) ; rubrique **Géographie** : relief, fleuves, forêts, steppes, déserts, marais, glaces ;
rubrique **Monde vivant** : les villes grandissent et déclinent (populations estimées de Chandler et Modelski,
[Reba et al. 2016](https://doi.org/10.1038/sdata.2016.34), CC BY 4.0, construites par `npx tsx scripts/build-cities.ts`),
les routes commerciales s'animent de caravanes et de navires, les épidémies et les diffusions (religions,
écritures, techniques) se propagent ville après ville. Les étapes des flux sont lues par l'IA dans un article
Wikipédia (chaque étape doit y être citée) : il faut une clé d'IA, chaque flux est lu une fois puis gardé.
Sur chaque fiche, **Le fil de l'histoire** (avec une clé d'IA) : les lieux et moments du sujet lus dans son article
(pour le Titanic : construction à Belfast, départ de Southampton, escales de Cherbourg et Queenstown, arrivée du
Carpathia à New York), ce qu'il a engendré et ses personnages (clic = les suivre sur la carte). Lieux et personnages
doivent être cités dans l'article et se retrouver dans Wikidata ou sur la carte. Puis, sous « Partir sur un fil »,
trois **parcours** : l'un suit **quelqu'un** (un personnage réel), l'un **une chose** (le fret, un navire, une relique,
l'argent), l'un **une idée** (une foi, une technique, une loi), choisis selon votre lentille, vos thèmes et les fiches
explorées juste avant ; leurs étapes suivent l'ordre des jours quand l'article les date, et le parcours d'une personne
s'arrête à sa mort. Deux autres fils, sans IA pour les tracer : **Rester ici** (le même lieu d'époque en époque, les
moments les plus connus alentour d'après Wikidata) et **Le monde vers telle année** (une fiche par thème — pouvoir,
guerre, foi, commerce, savoirs… —, loin les unes des autres, en tournée depuis l'endroit où vous êtes). Chaque étape est rédigée à l'arrivée deux fois, d'après
la section de l'article Wikipédia qui raconte ce moment (et l'article qui la détaille) : en deux ou trois phrases, **le
récit**, et comme une section d'encyclopédie, à la troisième personne (plusieurs paragraphes, les images de la section
avec leurs légendes, les personnes que l'article y nomme, des repères datés, une phrase citée mot pour mot, ses sources),
pour **l'article**. Les étapes de la vie d'un personnage, et celles des deux fils faits de fiches, sont rédigées de même
d'après leur propre article. **Le scénario à gauche, l'exploration à droite** : le chemin se lit dans la fiche du
scénario, à gauche, l'étape comme un article (son image, son lieu et son moment, le récit, puis **Lire l'article** pour
la section entière), avec à son pied **le lecteur** : les étapes de la file en pastilles et un gros bouton **Suivant**
qui avance étape par étape (les pastilles du scénario en cours et du précédent). ▾ la replie sur son lecteur ; elle ne
se ferme jamais d'elle-même. Le petit arbre près de ☰ montre **l'arbre des scénarios** pris, comme dans un carnet : les
chemins suivis, les crochets en branches, les routes laissées (reprenables d'un clic). Ce que vous cliquez sur
la carte ouvre sa propre fiche à droite, et les deux se lisent côte à côte ; chacune s'élargit ou se rétrécit par la
poignée de son bord intérieur. La frise générale reste en bas, les étapes de la file y sont marquées en or, celles
de trois scénarios au plus (un clic y mène). Les filtres sont réunis en haut, en menus (lentille, thèmes, carte, monde vivant, personnages, échelle) avec
l'interrupteur des scénarios. Les étapes sont rangées dans **la file**, comme sur un lecteur de musique : déjà vu,
maintenant, à suivre (☰ pour la voir, la réordonner, en retirer). Un **crochet** (une personne, un lieu que la section
lie, ceux de vos thèmes d'abord, en pointillés bleus) glisse quelques étapes en tête de la file, qui reprend d'elle-même
après ; **Bifurquer** (une bifurcation prévue, toute une vie, ce lieu à travers les siècles, le monde à ce moment)
remplace la suite, mise de côté comme route non prise ; **+ À la file** sur une fiche y ajoute le lieu. Cliquer ailleurs
sur la carte ne quitte rien : la caméra est à vous jusqu'à **Suivant** (ou ◎), et la pastille dorée du scénario
reste sur la carte (un clic dessus vous y ramène). Sur le globe, seulement l'étape en cours, la précédente
(pointillés) et la suivante (flèche dorée), cliquables ; l'étape suivante est écrite en sachant les choix faits. L'IA au travail est nommée dans la barre d'état et sur tout ce qu'elle écrit (étapes,
parcours, rôles des lieux, flux, fiches traduites ou rédigées). La caméra ne bouge que si l'étape sort de la vue, sans
changer de hauteur ni d'inclinaison. Boutons
◂◂◂ … ▸▸▸ sous la timeline (ou ← ↓ → et Espace) : reculer, pause, avancer, jusqu'au jour près. Sons (et import de vos propres fichiers audio), ouverture
au survol et filtre « Pendant ce temps » : Réglages → Interface. Taille et durée du cache (jusqu'à 100 Go) :
Réglages → Cache.

Unraid : voir [infra/unraid/README.md](infra/unraid/README.md). Avec Compose : `docker compose up -d`.

### Développement local (sans Docker)

```bash
npm install
npm run borders:fetch   # une fois (frontières Cliopatria + instantanés anciens)
npm run dev             # API :3000 (cache en mémoire, file inline) + front :5173
```

Sans `DATABASE_URL` ni `REDIS_URL`, l'API garde le cache en mémoire (sauvegardé dans
`.dev/store.json`) et exécute les recherches elle-même.

```bash
npm test          # vitest (dont le store Postgres sur PGlite)
npm run typecheck
```

## Structure

```
apps/front         Vite + CesiumJS : globe, timeline, fiche, filtres
apps/api           Fastify + WebSocket ; sert aussi le front en mode conteneur unique
apps/worker        Worker BullMQ optionnel (mode multi-services, non utilisé par l'image)
packages/shared    Types, schémas Zod, tranches de temps, H3, protocole
packages/providers Clients Wikidata (SPARQL) et Wikipédia (GeoSearch, résumés)
packages/core      Pipeline de recherche, stores (Postgres / mémoire), bus de jobs
infra/unraid       Template et guide Unraid
scripts            Téléchargement des frontières, smoke test des fournisseurs
data/borders       Frontières historiques (GPL-3.0, non versionnées)
```

## Crédits des données

- Faits : [Wikidata](https://www.wikidata.org) (CC0) et [Wikipédia](https://fr.wikipedia.org) (CC BY-SA), cités sur chaque fiche.
- Images : [Wikimedia Commons](https://commons.wikimedia.org), chacune sous sa propre licence (domaine public, CC BY-SA…). Gardées en cache sur votre serveur pour l'affichage (Réglages → Cache pour le désactiver) ; les photos des fiches renvoient à leur page Commons. Les blasons en filigrane sur la carte n'ont pas de crédit individuel : leur nom de fichier est celui de la page Commons.
- Frontières : [Cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria), Seshat Global History Databank (CC BY 4.0), datées à l'année, simplifiées au kilomètre ; avant −3400, [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), instantanés approximatifs.
- Fond de carte : Natural Earth II (livré avec Cesium) ; satellite : Esri World Imagery par défaut (configurable).
- Géographie : [Natural Earth](https://www.naturalearthdata.com) (domaine public) pour les terres, fleuves et lacs, et les trajets des armées ; occupation du sol MODIS (IGBP, 2001) de la NASA via [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) (données ouvertes) ; ombrage du relief © Esri.
