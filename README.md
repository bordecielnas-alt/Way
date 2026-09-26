# Way — globe historique explorable

Un globe où l'on voyage dans 7 000 ans d'histoire. Voir [docs/BRIEF.md](docs/BRIEF.md) pour la vision
et [docs/DECISIONS.md](docs/DECISIONS.md) pour les choix techniques.

**État : V0** — globe Cesium, timeline non linéaire, recherche niveau 1 (Wikidata + Wikipédia)
avec cache et push WebSocket, fiches sourcées, frontières historiques animées, vol de caméra.

## Démarrer

### Docker : un seul conteneur

```bash
docker run -d --name way -p 8080:8080 -v ./data-way:/data ghcr.io/bordecielnas-alt/way:latest
```

Puis ouvrir http://localhost:8080. Tout est dans l'image (site, API, recherche, Postgres embarqué) ;
tout ce qui persiste est dans `/data`. Au premier démarrage, les frontières historiques (~66 Mo) se
téléchargent en arrière-plan. Variable optionnelle : `WAY_CONTACT` (ton email, demandé par Wikimedia).

Unraid : voir [infra/unraid/README.md](infra/unraid/README.md). Avec Compose : `docker compose up -d`.

### Développement local (sans Docker)

```bash
npm install
npm run borders:fetch   # une fois
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
- Images : [Wikimedia Commons](https://commons.wikimedia.org), chargées directement, jamais stockées.
- Frontières : [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), instantanés approximatifs.
- Fond de carte : Natural Earth II (livré avec Cesium) ; satellite : Esri World Imagery par défaut (configurable).
