# Way sur Unraid

Un seul conteneur.

## Option A — à la main (le plus simple)

**Docker → Add Container**, puis :

| Champ | Valeur |
|---|---|
| Name | `way` |
| Repository | `ghcr.io/bordecielnas-alt/way:latest` |
| Port | container `8080` → host `8080` (ou un port libre) |
| Path | container `/data` → host `/mnt/user/appdata/way` |
| Variable (optionnel) | `WAY_CONTACT` = ton email |

**Apply**, puis ouvrir `http://<ip-unraid>:8080`.

### Recherche approfondie par IA (facultatif)

Sans clé, Way utilise Wikidata et Wikipédia. Avec au moins une clé d'IA gratuite, les zones pauvres
sont complétées par une recherche web analysée par IA (fiches marquées « rédigée par IA », sources
toujours affichées). Ajoute des variables au conteneur (**Add another Path, Port, Variable…**) :

| Variable | Où l'obtenir (gratuit) |
|---|---|
| `GEMINI_API_KEY` | aistudio.google.com → Get API key |
| `GROQ_API_KEY` | console.groq.com → API Keys |
| `TAVILY_API_KEY` (recherche web) | tavily.com |
| `MISTRAL_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY` | autres secours |
| `OLLAMA_URL` | IA locale, ex. `http://192.168.1.10:11434` |

État des quotas et des fournisseurs : `http://<ip-unraid>:8080/admin.html`.

## Option B — template

Copier [`my-way.xml`](my-way.xml) dans `/boot/config/plugins/dockerMan/templates-user/`,
puis **Docker → Add Container → Template : way**.

## Notes

- Premier démarrage : les frontières historiques (~66 Mo) se téléchargent en arrière-plan ;
  la carte les affiche dès qu'elles sont prêtes.
- Mise à jour : **Docker → Check for Updates → Update**.
