# dev-stack-watcher-mcp

_[English version](README.en.md)_

Veille technique automatisée : le projet collecte chaque jour l'actualité **GitHub** et
**Dev.to**, demande à **Claude** d'en produire une synthèse JSON structurée, la stocke dans
**SQLite** (un seul résumé par jour) et l'expose via un serveur **MCP**.

Le code est en anglais (convention professionnelle) ; **les résumés produits sont en
français**, puisque c'est le livrable destiné à être lu.

> **Projet scolaire** — CREA, 2ᵉ année, module IA · Auteur : Matis Wostry

---

## Architecture

```
ÉTAPE 1 — Collecte          ÉTAPE 2 — Synthèse + stockage      ÉTAPE 3 — Exposition
┌────────────────────┐      ┌──────────────────────────┐       ┌──────────────────┐
│ GitHub API         │      │ API Claude               │       │ Serveur MCP      │
│  dépôts en vogue   │──┐   │  → JSON structuré       │   ┌──▶│                  │
│  releases (7 j)    │  ├──▶├──────────────────────────┤───┤   │ summaries://list │
├────────────────────┤  │   │ SQLite                   │   │   │ summary://{date} │
│ Dev.to API         │──┘   │  1 résumé / jour (UNIQUE)│   └──▶│ 3 outils MCP     │
│  articles du jour  │      │  migrations auto         │       └──────────────────┘
└────────────────────┘      └──────────────────────────┘
```

**Déduplication** — la colonne `summary_date` porte une contrainte `UNIQUE`, et la
vérification a lieu _avant_ l'appel à Claude : relancer deux fois dans la même journée ne
consomme aucun token.

---

## Prérequis

- **Node.js ≥ 20** (testé sur 22.12)
- Une **clé API Anthropic** — [console.anthropic.com](https://console.anthropic.com/settings/keys)
- Un **jeton GitHub** (facultatif, mais fait passer la limite de 60 à 5000 requêtes/heure)

## Installation

```bash
npm install
cp .env.example .env      # puis renseigner ANTHROPIC_API_KEY
npm run build             # optionnel en développement
```

La base SQLite et ses tables sont créées automatiquement au premier lancement.

---

## Configuration

Tout passe par le fichier `.env` (voir `.env.example` pour la liste complète).

| Variable               | Défaut            | Rôle                                          |
| ---------------------- | ----------------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY`    | —                 | **Obligatoire** pour générer un résumé        |
| `CLAUDE_MODEL`         | `claude-opus-5`   | Modèle de synthèse                            |
| `GITHUB_TOKEN`         | —                 | Jeton sans scope ; lève la limite de 60 req/h |
| `GITHUB_LOOKBACK_DAYS` | `7`               | Fenêtre des tendances et releases             |
| `DEVTO_ARTICLE_LIMIT`  | `15`              | Nombre d'articles collectés                   |
| `DB_PATH`              | `./data/watch.db` | Emplacement du fichier SQLite                 |
| `LOG_LEVEL`            | `info`            | `debug`, `info`, `warn`, `error`, `silent`    |

> Tous les logs partent sur `stderr` : `stdout` est réservé au protocole JSON-RPC du
> serveur MCP, et la moindre ligne parasite casserait la communication.

---

## Utilisation

### Générer le résumé du jour

```bash
npm run fetch
```

```
INFO  Collecting data (GitHub + Dev.to)...
INFO  Dev.to: 15 article(s) collected.
INFO  GitHub: 26 item(s) collected, 0 error(s).
INFO  Generating summary with claude-opus-5 (41 item(s), effort high).
OK    Summary for 2026-09-08 stored (id 1, 41 item(s)).
```

Options (après `--` avec npm) :

```bash
npm run fetch -- --skip-summary      # collecte seule, aucun appel à Claude
npm run fetch -- --force             # régénère et remplace le résumé du jour
npm run fetch -- --date=2026-09-01   # cible une autre date
```

### Consulter les résumés

```bash
npm run list                         # catalogue des résumés stockés
npm run show                         # affiche le plus récent
npm run show -- 2026-09-08           # affiche une date précise
```

### Démarrer le serveur MCP

```bash
npm run mcp        # stdio : Claude lance lui-même le processus
npm run mcp:http   # HTTP  : http://127.0.0.1:3000/mcp
```

En stdio, le serveur reste en attente sans rien afficher : c'est normal, il est piloté par
le client.

---

## Brancher le serveur à un client MCP

Le serveur expose **deux ressources** et **trois outils**.

| Ressource          | Contenu                                                 |
| ------------------ | ------------------------------------------------------- |
| `summaries://list` | Catalogue JSON : date, titre, modèle, nombre d'éléments |
| `summary://{date}` | Résumé JSON structuré d'une journée (`AAAA-MM-JJ`)      |

| Outil            | Paramètres                    |
| ---------------- | ----------------------------- |
| `list_summaries` | `limit` (1–200, défaut 30)    |
| `get_summary`    | `date` (`AAAA-MM-JJ`, requis) |
| `latest_summary` | —                             |

Les outils permettent à Claude d'interroger la base en langage naturel : « montre-moi la
veille du 8 septembre », « qu'est-ce qui est sorti côté Next.js ? ».

**Claude Desktop** — dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "dev-stack-watcher": {
      "command": "node",
      "args": ["D:/CREA/2eAnnee/IA/dev-stack-watcher-mcp/dist/cli.js", "mcp"]
    }
  }
}
```

**Claude Code** :

```bash
claude mcp add dev-stack-watcher -- node <chemin-absolu>/dist/cli.js mcp
```

Lancez `npm run build` au préalable, puis redémarrez le client.

---

## Structure du projet

```
src/
├── fetcher/
│   ├── github.ts      Dépôts en vogue + releases des 7 derniers jours
│   ├── devto.ts       Articles populaires du jour
│   └── types.ts       FeedItem et utilitaires partagés
├── summarizer/
│   ├── claude.ts      Prompt, appel API, réessais réseau
│   └── storage.ts     SQLite : migrations, déduplication, lecture/écriture
├── mcp/
│   ├── server.ts      Serveur MCP : ressources, outils, transport stdio
│   └── http.ts        Transport HTTP (sessions, sonde /health)
├── config.ts          Configuration centralisée (.env)
├── logger.ts          Journalisation sur stderr
├── cli.ts             Interface en ligne de commande
└── index.ts           Pipeline runWatch() + API publique
```

`Dockerfile` et `docker-compose.yml` permettent de lancer le projet en conteneur.
