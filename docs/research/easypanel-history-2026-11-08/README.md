# Historique public Easypanel → exigences originales FullPanel

Consultation : **2026-11-08**. **151 versions**, dont **71 patches**, toutes accessibles en HTTP 200; **70 règles consolidées**. Les versions documentées couvrent le **2022-10-15 au 2026-10-22**; un article officiel complète la chronologie au **2022-08-12**.

## Méthode et limites

Inventaire des 151 fiches publiques accessibles via les 16 pages du changelog officiel, patches inclus, et trois articles officiels complémentaires. Ne prouve pas la connaissance de correctifs privés ou non publiés.

Faits: paraphrases du contenu publié. Exigences et scénarios: propositions originales Harborlight, sans présomption d’implémentation ou de succès.

- Les pages indexées du moteur de recherche affichaient parfois149/78/79 versions en cache; la collecte HTTP fraîche a retourné151 fiches, toutesHTTP 200.
- Les annonces vagues de sécurité ne permettent pas de déduire exploit, CVE, impact ou cause racine.
- Les dates sont celles publiées, pas des dates de découverte ou déploiement effectif.
- Les catalogues sont regroupés; aucun inventaire exhaustif de bugs des logiciels tiers ni certification des centaines de modèles n’est revendiqué.
- La disponibilité historique ne prouve pas la disponibilité actuelle: cluster et compression ont connu dépréciation/retrait.
- Le corpus propose des exigences originales, et non une reproduction du code propriétaire. Les pages HTML de travail ont été conservées hors dépôt sous /private/tmp. Trois captures officielles tierces sont néanmoins présentes dans [la documentation comparative](../../images/reference/README.md) et dans le DOCX ; elles ne sont pas des éléments UI de l'application FullPanel. Leurs droits ne sont pas placés sous Apache-2.0 et aucune autorisation expresse de republication n'est consignée dans leurs notices.
- La méthode comprend une inspection statique des bundles de référence. Ce corpus ne constitue ni un audit comparatif indépendant des codes ni la preuve d'un processus clean-room strictement séparé ; aucune conclusion ou garantie juridique n'en est déduite.
- Les tests dérivés sont à rapprocher du registre de preuves Harborlight; documenter une règle ne signifie pas que son scénario a été exécuté.

La priorité est celle de la règle Harborlight : P0 = sécurité/intégrité/fondation; P1 = exploitation courante; P2 = capacité avancée. Les IDs F/A/R/D/C/S renvoient à [FEATURE-PARITY.md](../../FEATURE-PARITY.md). Une règle peut viser une fonctionnalité encore absente.

## Couverture annuelle

| Année | Fiches officielles | Toutes accessibles |
|---|---:|---|
| 2022 | 7 | Oui |
| 2023 | 32 | Oui |
| 2024 | 59 | Oui |
| 2025 | 25 | Oui |
| 2026 | 28 | Oui |

Les tableaux détaillés et hashes sont dans [versions.json](versions.json); les données structurées pour le DOCX sont dans [register.json](register.json).

## Règles consolidées

### H01 — Mesures explicites et historique de supervision

**Priorité P1 · Critères : R17, R18, S01**

**Fait publié, paraphrasé :** Les publications ajoutent supervision réseau, historique, analyse disque puis métriques et journaux avancés; plusieurs défauts de mesure ou affichage sont corrigés.

**Exigence originale dérivée :** Identifier origine, unité, périmètre et instant de chaque mesure; borner la rétention et distinguer hôte, moteur Docker et service.

**Scénario de non-régression proposé :**

1. Comparer CPU/mémoire/réseau à une charge connue puis interrompre Docker: afficher une mesure indisponible, jamais zéro inventé.
2. Redémarrer le panneau et vérifier limites de rétention et distinction disque des volumes, images et journaux.

**Sources officielles :** [1.21.0 — 2023-08-03](https://easypanel.io/changelog/1-21-0-1), [1.22.0 — 2023-08-09](https://easypanel.io/changelog/1-22-0-1), [1.29.0 — 2023-11-28](https://easypanel.io/changelog/1-29-0-1), [2.19.0 — 2025-05-23](https://easypanel.io/changelog/2-19-0-1), [2.29.0 — 2026-04-16](https://easypanel.io/changelog/2-29-0), [2.29.2 — 2026-04-17](https://easypanel.io/changelog/2-29-2), [Resource Monitoring, New Dashboard, and Other Improvements — 2022-08-12](https://easypanel.io/blog/changelog-august-2022).

### H02 — État réel et actions distinctes du déploiement

**Priorité P0 · Critères : F04, A15**

**Fait publié, paraphrasé :** L’indicateur des services arrêtés est ajouté; un correctif empêche de reconstruire une application lors de son arrêt.

**Exigence originale dérivée :** Dériver l’état du runtime canonique; start/stop/restart ne doivent pas lancer de clone ou build.

**Scénario de non-régression proposé :**

1. Arrêter une app et interdire toute commande build/pull dans le fixture.
2. Laisser un ancien conteneur arrêté à côté du conteneur actif; celui-ci reste affiché running, tandis qu’un enfant Compose arrêté affecte sa stack.

**Sources officielles :** [1.12.4 — 2022-10-31](https://easypanel.io/changelog/1-12-4-1), [1.12.7 — 2022-11-05](https://easypanel.io/changelog/1-12-7-1), [1.33.0 — 2024-02-16](https://easypanel.io/changelog/1-33-0-1), [1.33.4 — 2024-02-21](https://easypanel.io/changelog/1-33-4-1), [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [Resource Monitoring, New Dashboard, and Other Improvements — 2022-08-12](https://easypanel.io/blog/changelog-august-2022).

### H03 — Environnement de projet, valeurs vides et substitutions

**Priorité P0 · Critères : F05, R01, A12**

**Fait publié, paraphrasé :** L’héritage de variables apparaît en 2022; plusieurs variables Nixpacks, valeurs vides et substitution du nom d’hôte sont ensuite corrigées.

**Exigence originale dérivée :** Définir une précédence stable, conserver les valeurs vides et littérales, séparer configuration enregistrée et effective. Toute interpolation doit être explicitement activée.

**Scénario de non-régression proposé :**

1. Projet A=parent et service A=vide: le runtime reçoit vide après déploiement, jamais avant.
2. Vérifier espaces, dollar, égal, Unicode et plusieurs variables; le projet voisin ne reçoit aucune valeur.

**Sources officielles :** [1.12.6 — 2022-11-05](https://easypanel.io/changelog/1-12-6-1), [1.13.0 — 2023-01-03](https://easypanel.io/changelog/1-13-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.26.3 — 2026-02-13](https://easypanel.io/changelog/2-26-3).

### H04 — Catalogue et modèles reproductibles

**Priorité P1 · Critères : C06, C07**

**Fait publié, paraphrasé :** De nombreuses versions ajoutent ou actualisent des modèles; certaines corrigent images, noms de services, domaines, variables, liens ou initialisation.

**Exigence originale dérivée :** Maintenir un catalogue original versionné avec schéma validé, références d’images explicites, dépendances, secrets générés et tests de démarrage; regrouper les ajouts éditoriaux sans prétendre tester tous les logiciels tiers.

**Scénario de non-régression proposé :**

1. Instancier chaque modèle déclaré vérifié dans un projet neuf, contrôler URL, ports, comptes et persistance.
2. Rejeter une dépendance manquante; conserver un diagnostic et un nettoyage limité aux ressources créées.

**Sources :** 63 fiches contenant des changements de catalogue; chacune est reliée à H04 dans l’inventaire ci-dessous. Exemples : [2.36.0 — 2026-09-24](https://easypanel.io/changelog/2-36-0), [2.35.0 — 2026-09-16](https://easypanel.io/changelog/2-35-0), [2.34.0 — 2026-09-10](https://easypanel.io/changelog/2-34-0), [1.12.6 — 2022-11-05](https://easypanel.io/changelog/1-12-6-1), [1.12.5 — 2022-11-01](https://easypanel.io/changelog/1-12-5-1), [1.12.3 — 2022-10-15](https://easypanel.io/changelog/1-12-3-1).

### H05 — Versions de builders et compatibilité des langages

**Priorité P2 · Critères : A09, A10, A11**

**Fait publié, paraphrasé :** Nixpacks, Buildpacks et leurs outils évoluent régulièrement; les versions sélectionnables et Railpack arrivent plus tard, avec des correctifs réseau/langage.

**Exigence originale dérivée :** Épingler chaque builder et publier sa matrice de compatibilité; exposer overrides et erreurs. Une option non implémentée doit rester indisponible.

**Scénario de non-régression proposé :**

1. Pour chaque builder supporté, construire une fixture de langage et enregistrer sa version.
2. Changer de version ou simuler DNS indisponible: produire un échec utile, sans remplacer l’application active.

**Sources officielles :** [1.12.3 — 2022-10-15](https://easypanel.io/changelog/1-12-3-1), [1.12.7 — 2022-11-05](https://easypanel.io/changelog/1-12-7-1), [1.13.0 — 2023-01-03](https://easypanel.io/changelog/1-13-0-1), [1.15.1 — 2023-03-07](https://easypanel.io/changelog/1-15-1-1), [1.15.3 — 2023-03-09](https://easypanel.io/changelog/1-15-3-1), [1.17.0 — 2023-05-07](https://easypanel.io/changelog/1-17-0-1), [1.18.0 — 2023-05-27](https://easypanel.io/changelog/1-18-0-1), [1.30.0 — 2023-12-19](https://easypanel.io/changelog/1-30-0-1), [1.31.3 — 2024-01-06](https://easypanel.io/changelog/1-31-3-1), [1.37.3 — 2024-04-05](https://easypanel.io/changelog/1-37-3-1), [1.41.0 — 2024-06-06](https://easypanel.io/changelog/1-41-0-1), [1.44.1 — 2024-07-17](https://easypanel.io/changelog/1-44-1-1), [1.44.2 — 2024-07-19](https://easypanel.io/changelog/1-44-2-1), [2.5.0 — 2025-01-06](https://easypanel.io/changelog/2-5-0-1), [2.14.0 — 2025-03-24](https://easypanel.io/changelog/2-14-0-1), [2.24.0 — 2025-12-31](https://easypanel.io/changelog/2-24-0-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0), [2.29.2 — 2026-04-17](https://easypanel.io/changelog/2-29-2), [2.29.4 — 2026-04-18](https://easypanel.io/changelog/2-29-4).

### H06 — Images de bases épinglées et changements de version

**Priorité P0 · Critères : D01, D02, D03, D04, D05, A01**

**Fait publié, paraphrasé :** Un correctif remplace latest par une version statique pour les bases; PostgreSQL 18 devient ensuite une version prise en charge et le défaut.

**Exigence originale dérivée :** Séparer version proposée, version configurée et digest exécuté; ne pas transformer une mise à jour du catalogue en migration automatique des données.

**Scénario de non-régression proposé :**

1. Créer une base sur une version puis changer le défaut du catalogue: la base existante reste inchangée.
2. Refuser la restauration entre versions incompatibles avant de modifier le runtime.

**Sources officielles :** [1.13.0 — 2023-01-03](https://easypanel.io/changelog/1-13-0-1), [2.34.0 — 2026-09-10](https://easypanel.io/changelog/2-34-0).

### H07 — Autorisation par projet, y compris collections

**Priorité P0 · Critères : S02, F10**

**Fait publié, paraphrasé :** Le multi-utilisateur commence en 2023; les publications de 2025–2026 corrigent droits non-admin, visibilité des domaines et contrôles de projet. Le détail des vulnérabilités n’est pas publié.

**Exigence originale dérivée :** Appliquer l’autorisation côté serveur aux listes et actions, avec refus par défaut et filtrage des métadonnées, journaux, fichiers et domaines.

**Scénario de non-régression proposé :**

1. Un membre du projet A tente IDs, listes globales et routes encodées du projet B: aucun contenu n’est révélé.
2. Révoquer le rôle pendant une session et vérifier l’effet immédiat sur toutes les interfaces.

**Sources officielles :** [1.14.0 — 2023-02-22](https://easypanel.io/changelog/1-14-0-1), [2.20.0 — 2025-06-10](https://easypanel.io/changelog/2-20-0-1), [2.20.1 — 2025-06-10](https://easypanel.io/changelog/2-20-1-1), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H08 — Authentification forte, déconnexion et récupération

**Priorité P0 · Critères : F01, F02, F09**

**Fait publié, paraphrasé :** La double authentification est annoncée en bêta; des correctifs touchent ensuite sa reprise après logout et plusieurs réinitialisations de mot de passe.

**Exigence originale dérivée :** Spécifier séparément connexion, second facteur, récupération, expiration et révocation. Ne pas déduire d’un historique de correctifs une 2FA déjà présente dans Harborlight.

**Scénario de non-régression proposé :**

1. Avec 2FA activée, logout puis nouveau login impose à nouveau le second facteur.
2. Un lien de récupération expiré ou réutilisé est refusé et une modification de mot de passe invalide les sessions prévues par la politique.

**Sources officielles :** [1.15.0 — 2023-03-02](https://easypanel.io/changelog/1-15-0-1), [1.18.0 — 2023-05-27](https://easypanel.io/changelog/1-18-0-1), [1.36.1 — 2024-03-22](https://easypanel.io/changelog/1-36-1-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [2.30.1 — 2026-05-15](https://easypanel.io/changelog/2-30-1).

### H09 — Git privé et clés SSH

**Priorité P1 · Critères : A04**

**Fait publié, paraphrasé :** Le support Git par clé SSH est suivi d’un patch; la génération des clés Compose et l’aide aux tokens GitHub évoluent aussi.

**Exigence originale dérivée :** Garder les secrets liés au dépôt exact; vérifier identité serveur et révocation. Distinguer explicitement HTTPS-token supporté, SSH et GitHub OAuth non supportés.

**Scénario de non-régression proposé :**

1. Un secret du dépôt A ne doit jamais partir au dépôt B ni après redirection.
2. Rotation et révocation font échouer l’ancien accès; une option SSH indisponible ne peut produire un faux succès.

**Sources officielles :** [1.15.1 — 2023-03-07](https://easypanel.io/changelog/1-15-1-1), [1.15.2 — 2023-03-08](https://easypanel.io/changelog/1-15-2-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [2.24.0 — 2025-12-31](https://easypanel.io/changelog/2-24-0-1).

### H10 — Schémas de modèles et identité du projet cible

**Priorité P1 · Critères : C06, C07, F03**

**Fait publié, paraphrasé :** Les schémas gagnent des variables de projet/service/domaine, puis sont simplifiés et acceptent des sources Git.

**Exigence originale dérivée :** Valider un schéma déclaratif original; résoudre les références dans le projet cible sans accepter un projectId ou chemin arbitraire du document importé.

**Scénario de non-régression proposé :**

1. Importer le même modèle dans deux projets et vérifier noms, secrets et URLs indépendants.
2. Un schéma visant un autre projet ou contenant un cycle de dépendance est refusé sans création partielle silencieuse.

**Sources officielles :** [1.15.4 — 2023-03-13](https://easypanel.io/changelog/1-15-4-1), [1.20.1 — 2023-07-08](https://easypanel.io/changelog/1-20-1-1), [1.47.1 — 2024-08-02](https://easypanel.io/changelog/1-47-1-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1).

### H11 — Frontière cluster, données locales et modes réseau

**Priorité P2 · Critères : S09, R13**

**Fait publié, paraphrasé :** Le multi-serveur bêta est annoncé en 2023, puis le cluster est déprécié en 2024 pour instabilité; une option Swarm DNSRR apparaît en 2026. Ces annonces ne prouvent pas une disponibilité continue du cluster.

**Exigence originale dérivée :** Documenter le moteur réellement supporté et la localisation des données. Ne promettre ni HA ni répartition multi-nœuds sans reprise vérifiée.

**Scénario de non-régression proposé :**

1. Retirer un worker dans une fixture future: seul un service stateless admissible peut être replanifié.
2. Vérifier DNS et routage pour chaque endpoint mode; le mode standalone actuel ne lance jamais swarm init/leave.

**Sources officielles :** [1.16.0 — 2023-04-04](https://easypanel.io/changelog/1-16-0-1), [1.47.0 — 2024-08-01](https://easypanel.io/changelog/1-47-0-1), [2.35.0 — 2026-09-16](https://easypanel.io/changelog/2-35-0), [Multi-Server Support (Beta) — 2023-04-04](https://easypanel.io/blog/multi-server-support-beta-release).

### H12 — Unicité des domaines et validation canonique

**Priorité P0 · Critères : R06, R09, S02**

**Fait publié, paraphrasé :** L’utilisation d’un domaine dans plusieurs services est empêchée; la validation des doublons est ensuite corrigée.

**Exigence originale dérivée :** Normaliser hostname/IDN/casse et évaluer conflits de routes exactes, wildcard et chemins sans exposer l’identité des autres projets.

**Scénario de non-régression proposé :**

1. Deux requêtes concurrentes réclament le même host/path: une seule réussit.
2. Tester casse, point final et wildcard; un refus inter-projet ne révèle pas son propriétaire.

**Sources officielles :** [1.18.0 — 2023-05-27](https://easypanel.io/changelog/1-18-0-1), [1.21.0 — 2023-08-03](https://easypanel.io/changelog/1-21-0-1).

### H13 — Cible du domaine, chemin et protocole amont

**Priorité P1 · Critères : R06, R09, C05**

**Fait publié, paraphrasé :** Les domaines peuvent choisir port et chemin; les ports internes sont affichés, le protocole amont et les URL externes sont ajoutés plus tard.

**Exigence originale dérivée :** Représenter explicitement service/conteneur, port, chemin et HTTP/HTTPS amont; valider URL externe et certificat sans désactiver TLS.

**Scénario de non-régression proposé :**

1. Router deux chemins vers deux ports et vérifier la frontière /api versus /apix.
2. Un mauvais certificat amont ou port absent donne une erreur observable; aucune base n’est exposée implicitement.

**Sources officielles :** [1.20.1 — 2023-07-08](https://easypanel.io/changelog/1-20-1-1), [1.48.0 — 2024-08-16](https://easypanel.io/changelog/1-48-0-1), [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1), [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1).

### H14 — Middleware, redirections et maintenance

**Priorité P1 · Critères : R10, R11, R12**

**Fait publié, paraphrasé :** Les publications ajoutent configuration Traefik, redirections, maintenance et gestion de middlewares; des défauts de redirection et basic auth sont corrigés.

**Exigence originale dérivée :** Composer les règles dans un ordre défini, tester activation/désactivation, borner les redirections et protéger les configurations administratives.

**Scénario de non-régression proposé :**

1. Tester basic auth juste/fausse, changement de secret, maintenance puis retour normal.
2. Une redirection de chemin fonctionne sans domaine source auxiliaire et ne crée pas de boucle.

**Sources officielles :** [1.13.1 — 2023-01-08](https://easypanel.io/changelog/1-13-1-1), [1.20.1 — 2023-07-08](https://easypanel.io/changelog/1-20-1-1), [1.28.0 — 2023-11-27](https://easypanel.io/changelog/1-28-0-1), [1.32.0 — 2024-01-25](https://easypanel.io/changelog/1-32-0-1), [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.36.0 — 2024-03-22](https://easypanel.io/changelog/1-36-0-1), [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1), [Resource Monitoring, New Dashboard, and Other Improvements — 2022-08-12](https://easypanel.io/blog/changelog-august-2022).

### H15 — Proxy de confiance et exposition volontaire

**Priorité P0 · Critères : R06, R11, S10, F09**

**Fait publié, paraphrasé :** Un problème avec le proxy Cloudflare est corrigé; Traefik cesse d’exposer les conteneurs par défaut; une liste de proxies de confiance est ajoutée.

**Exigence originale dérivée :** Publier uniquement des routes explicites et n’accepter les en-têtes forwarded que depuis des réseaux de confiance configurés.

**Scénario de non-régression proposé :**

1. Un conteneur sans domaine reste inaccessible via le proxy.
2. Un client direct falsifie X-Forwarded-For/Proto: cela ne contourne ni origine, limites ni journal d’identité.

**Sources officielles :** [1.37.1 — 2024-04-04](https://easypanel.io/changelog/1-37-1-1), [1.40.0 — 2024-05-01](https://easypanel.io/changelog/1-40-0-1), [2.37.0 — 2026-10-14](https://easypanel.io/changelog/2-37-0).

### H16 — Certificats et priorité des routes wildcard

**Priorité P0 · Critères : R07, R09, S10**

**Fait publié, paraphrasé :** La gestion de certificats et les wildcards apparaissent; provisioning SSL, documentation de certificat personnalisé et priorité des wildcards sont corrigés.

**Exigence originale dérivée :** Séparer émission, renouvellement, import et sélection de route; une route exacte doit gagner sur un wildcard. Le test HTTP ne vaut pas preuve ACME.

**Scénario de non-régression proposé :**

1. Sur un domaine de test réel, émettre puis renouveler en environnement ACME staging et vérifier la chaîne.
2. Tester host exact et wildcard concurrents, certificat expiré et indisponibilité de l’autorité sans perdre l’accès de secours.

**Sources officielles :** [1.29.0 — 2023-11-28](https://easypanel.io/changelog/1-29-0-1), [1.30.0 — 2023-12-19](https://easypanel.io/changelog/1-30-0-1), [1.41.0 — 2024-06-06](https://easypanel.io/changelog/1-41-0-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [2.1.0 — 2024-11-18](https://easypanel.io/changelog/2-1-0-1), [2.11.1 — 2025-02-18](https://easypanel.io/changelog/2-11-1-1).

### H17 — Domaine du panneau et URL générée

**Priorité P1 · Critères : R08, S10**

**Fait publié, paraphrasé :** Rafraîchissement IP, URL générée et domaine personnalisé évoluent; plusieurs patches corrigent IP, accès direct et domaine du panneau.

**Exigence originale dérivée :** Traiter tout changement d’adresse comme une transition explicite avec URL canonique, contrôle d’origine et accès de récupération.

**Scénario de non-régression proposé :**

1. Changer le domaine généré: seules les nouvelles routes prévues changent, les personnalisées restent intactes.
2. Un domaine panneau invalide ne supprime pas le chemin de récupération local.

**Sources officielles :** [1.17.0 — 2023-05-07](https://easypanel.io/changelog/1-17-0-1), [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.37.0 — 2024-04-04](https://easypanel.io/changelog/1-37-0-1), [1.37.4 — 2024-04-05](https://easypanel.io/changelog/1-37-4-1), [2.10.0 — 2025-02-14](https://easypanel.io/changelog/2-10-0-1), [2.26.0 — 2026-02-11](https://easypanel.io/changelog/2-26-0), [2.26.1 — 2026-02-11](https://easypanel.io/changelog/2-26-1), [2.26.3 — 2026-02-13](https://easypanel.io/changelog/2-26-3).

### H18 — Ports TCP/UDP, collisions et retrait

**Priorité P0 · Critères : R05, D08**

**Fait publié, paraphrasé :** Le support UDP, la vérification des collisions et le retrait de ports sont ajoutés ou corrigés; une action retire ensuite tous les ports.

**Exigence originale dérivée :** Valider protocole, port hôte/cible et conflit avant remplacement; le retrait doit fermer réellement l’écoute externe.

**Scénario de non-régression proposé :**

1. Publier un port, vérifier une connexion authentifiée, le retirer et constater le refus TCP.
2. Tester conflit occupé et paire TCP/UDP; l’ancien runtime reste fonctionnel en cas d’échec.

**Sources officielles :** [1.12.7 — 2022-11-05](https://easypanel.io/changelog/1-12-7-1), [1.37.3 — 2024-04-05](https://easypanel.io/changelog/1-37-3-1), [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [1.40.0 — 2024-05-01](https://easypanel.io/changelog/1-40-0-1), [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1).

### H19 — Réseaux de projet et résolution interne

**Priorité P1 · Critères : F03, C07, S09**

**Fait publié, paraphrasé :** Les alias internes et réseaux par projet apparaissent; des correctifs touchent Docker, Nixpacks et le réseau Box.

**Exigence originale dérivée :** Créer des réseaux nommés et possédés par le projet; distinguer réseau du build, runtime et proxy, et ne pas rejoindre un réseau tiers.

**Scénario de non-régression proposé :**

1. Deux services du même projet résolvent leurs alias; un autre projet ne reçoit pas automatiquement l’accès.
2. Échec de création réseau ou DNS build: pas de remplacement destructeur du runtime existant.

**Sources officielles :** [1.33.5 — 2024-02-28](https://easypanel.io/changelog/1-33-5-1), [1.38.0 — 2024-04-12](https://easypanel.io/changelog/1-38-0-1), [1.38.1 — 2024-04-13](https://easypanel.io/changelog/1-38-1-1), [1.44.1 — 2024-07-17](https://easypanel.io/changelog/1-44-1-1), [1.44.2 — 2024-07-19](https://easypanel.io/changelog/1-44-2-1).

### H20 — Commande, identité Unix, PID1 et processus enfants

**Priorité P1 · Critères : R14, A15**

**Fait publié, paraphrasé :** Les commandes personnalisées de bases et groupes Unix des services sont ajoutés; la récupération des enfants et les applications exigeant PID1 sont ensuite corrigées.

**Exigence originale dérivée :** Définir init, signal d’arrêt et délai de terminaison sans imposer un wrapper incompatible; borner les processus orphelins. Définir commande et UID/GID/groupes appliqués, et vérifier leur compatibilité avec les volumes gérés.

**Scénario de non-régression proposé :**

1. Une fixture qui intercepte SIGTERM écrit son marqueur et termine proprement.
2. Une fixture qui exige PID1 fonctionne avec le mode approprié; les enfants ne survivent pas à la fin du conteneur.
3. Exécuter une commande avec UID/GID/groupes configurés; vérifier identité et écriture uniquement dans les volumes autorisés.

**Sources officielles :** [1.37.0 — 2024-04-04](https://easypanel.io/changelog/1-37-0-1), [1.37.2 — 2024-04-05](https://easypanel.io/changelog/1-37-2-1), [1.21.0 — 2023-08-03](https://easypanel.io/changelog/1-21-0-1), [1.32.0 — 2024-01-25](https://easypanel.io/changelog/1-32-0-1).

### H21 — Image disponible avant remplacement

**Priorité P0 · Critères : A01, A17, A18, A02**

**Fait publié, paraphrasé :** Le déploiement attend désormais la fin du pull; des erreurs Docker pull et image introuvable sont corrigées.

**Exigence originale dérivée :** Résoudre l’image en ID immuable avant création du candidat et conserver l’ancien runtime en cas d’échec du pull ou de création.

**Scénario de non-régression proposé :**

1. Retirer l’accès registry ou déplacer le tag pendant la préparation: ne pas arrêter l’ancienne app.
2. Rollback sans image locale échoue avant toute mutation et ne déclenche aucun pull implicite.

**Sources officielles :** [1.37.0 — 2024-04-04](https://easypanel.io/changelog/1-37-0-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [2.12.0 — 2025-02-19](https://easypanel.io/changelog/2-12-0-1).

### H22 — Reconstruction forcée vérifiable

**Priorité P1 · Critères : A14, C08, C11**

**Fait publié, paraphrasé :** L’invalidation du cache est améliorée; le webhook puis Box/WordPress reçoivent une reconstruction forcée.

**Exigence originale dérivée :** Définir si rebuild invalide cache, actualise bases et recrée le runtime; journaliser ce choix et protéger les secrets de build.

**Scénario de non-régression proposé :**

1. Une instruction RUN marquée est réexécutée en mode forcé.
2. Un échec du nouveau build laisse l’ancienne app disponible et ne prétend pas avoir appliqué les mises à jour de sécurité.

**Sources officielles :** [1.37.3 — 2024-04-05](https://easypanel.io/changelog/1-37-3-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [2.38.0 — 2026-10-22](https://easypanel.io/changelog/2-38-0).

### H23 — Branche Git, force push et répertoire propre

**Priorité P0 · Critères : A03, A05**

**Fait publié, paraphrasé :** Des correctifs concernent la branche d’auto-déploiement, le changement de branche, les modifications locales et les force push.

**Exigence originale dérivée :** Utiliser un workspace isolé et une révision explicite; définir le traitement d’un SHA réécrit ou devenu inaccessible.

**Scénario de non-régression proposé :**

1. Déployer A, changer de branche puis force-push B: le commit exécuté est exactement celui attendu.
2. Un événement d’une autre branche ou un workspace sale ne modifie pas la source sélectionnée.

**Sources officielles :** [1.33.0 — 2024-02-16](https://easypanel.io/changelog/1-33-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [2.6.0 — 2025-01-20](https://easypanel.io/changelog/2-6-0-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0).

### H24 — Références Git et traçabilité du commit

**Priorité P0 · Critères : A03, A13, A17**

**Fait publié, paraphrasé :** Le commit Git devient disponible au runtime puis au build; les refs autres que branches sont rétablies.

**Exigence originale dérivée :** Enregistrer commit demandé, commit cloné, révision OCI et imageID; annoncer précisément branches/tags/SHA supportés.

**Scénario de non-régression proposé :**

1. Déplacer un tag après build puis inspecter l’image active: son SHA reste le précédent exact.
2. Le journal et le label OCI concordent après redémarrage du serveur.

**Sources officielles :** [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.51.0 — 2024-09-03](https://easypanel.io/changelog/1-51-0-1).

### H25 — Webhooks de déploiement et répétitions

**Priorité P0 · Critères : A05, A16, A18**

**Fait publié, paraphrasé :** Plusieurs versions corrigent les webhooks app/Compose et l’auto-déploiement GitHub; une publication précise le comportement force deploy.

**Exigence originale dérivée :** Authentifier le corps brut, filtrer dépôt et branche, borner/dédupliquer les livraisons et utiliser la même exclusion mutuelle que l’UI.

**Scénario de non-régression proposé :**

1. Signature invalide, dépôt incorrect, suppression de branche et replay ne créent aucun job.
2. Un refus busy peut être retenté; rotation, révocation et changement de source invalident l’ancienne autorité.

**Sources officielles :** [1.19.1 — 2023-07-04](https://easypanel.io/changelog/1-19-1-1), [1.33.3 — 2024-02-17](https://easypanel.io/changelog/1-33-3-1), [1.36.0 — 2024-03-22](https://easypanel.io/changelog/1-36-0-1), [1.42.1 — 2024-06-22](https://easypanel.io/changelog/1-42-1-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.51.0 — 2024-09-03](https://easypanel.io/changelog/1-51-0-1).

### H26 — Erreurs Git utiles et dépôts volumineux

**Priorité P1 · Critères : A03, A04, A05**

**Fait publié, paraphrasé :** Les erreurs Git/GitHub deviennent plus explicites; la sélection dépôt/branche et le téléchargement des gros dépôts sont améliorés.

**Exigence originale dérivée :** Différencier refus d’accès, ref absente, réseau et taille, sans divulguer token ou dépôt hors périmètre; paginer les sélecteurs.

**Scénario de non-régression proposé :**

1. Simuler chaque catégorie d’échec et vérifier message/action de reprise.
2. Cloner une fixture volumineuse avec budgets mémoire/temps, annulation et cleanup; aucune URL contenant secret ne finit dans les logs.

**Sources officielles :** [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.44.0 — 2024-07-17](https://easypanel.io/changelog/1-44-0-1), [1.48.0 — 2024-08-16](https://easypanel.io/changelog/1-48-0-1), [1.52.0 — 2024-09-30](https://easypanel.io/changelog/1-52-0-1), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H27 — Fichier environnement injecté au build

**Priorité P1 · Critères : R01, A08, A10**

**Fait publié, paraphrasé :** Un fichier .env peut être créé avant le build, puis son nom et chemin deviennent configurables.

**Exigence originale dérivée :** Séparer variables de build/runtime et secrets; restreindre le chemin au workspace et décider explicitement si le fichier entre dans une couche image.

**Scénario de non-régression proposé :**

1. Tester sous-répertoire autorisé et noms avec espaces; refuser chemins absolus, symlink et parent.
2. Inspecter historique/couches d’une fixture à secret: aucun secret déclaré éphémère ne doit persister.

**Sources officielles :** [1.27.0 — 2023-11-25](https://easypanel.io/changelog/1-27-0-1), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0).

### H28 — Archives source, plateformes et bornes

**Priorité P0 · Critères : A06, F10**

**Fait publié, paraphrasé :** Les uploads ZIP puis de multiples formats sont ajoutés; Windows, entrées de répertoire ZIP et validation des sources font l’objet de correctifs.

**Exigence originale dérivée :** Annoncer les formats acceptés; valider chemins, liens, fichiers spéciaux, tailles compressées/décompressées et quotas avant construction.

**Scénario de non-régression proposé :**

1. Accepter une archive avec répertoires terminés par slash et fichiers Unicode.
2. Refuser ../, chemin Windows absolu, lien sortant, archive-bombe et fichier trop grand avant toute extraction hors workspace.

**Sources officielles :** [1.30.0 — 2023-12-19](https://easypanel.io/changelog/1-30-0-1), [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.48.0 — 2024-08-16](https://easypanel.io/changelog/1-48-0-1), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H29 — Terminal conteneur : shell, dimensions et fermeture

**Priorité P0 · Critères : R16, F10, S02**

**Fait publié, paraphrasé :** Plusieurs correctifs portent sur console navigateur, absence de bash, largeur des lignes et redimensionnement.

**Exigence originale dérivée :** Choisir un shell disponible, transmettre les dimensions PTY, vérifier le conteneur exact et fermer la session à la déconnexion/révocation.

**Scénario de non-régression proposé :**

1. Sur Alpine sans bash, ouvrir sh, envoyer Unicode/Ctrl-C et vérifier stty après resize.
2. Déconnecter ou retirer le rôle: aucun exec interactif orphelin ne reste actif.

**Sources officielles :** [1.33.2 — 2024-02-17](https://easypanel.io/changelog/1-33-2-1), [1.33.4 — 2024-02-21](https://easypanel.io/changelog/1-33-4-1), [1.33.5 — 2024-02-28](https://easypanel.io/changelog/1-33-5-1), [1.46.0 — 2024-07-30](https://easypanel.io/changelog/1-46-0-1), [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0).

### H30 — Console hôte et redémarrage séparés

**Priorité P2 · Critères : R16, S01, S02**

**Fait publié, paraphrasé :** Une console et un bouton reboot hôte sont ajoutés; le bouton de fermeture est corrigé ensuite.

**Exigence originale dérivée :** Séparer les droits d’administration hôte de ceux du terminal de service; rendre indisponible l’action hôte tant que son périmètre n’est pas implémenté.

**Scénario de non-régression proposé :**

1. Un opérateur projet ne peut ouvrir la console hôte.
2. Une fermeture coupe le transport; reboot exige une confirmation et un journal indépendant de la disponibilité du panneau.

**Sources officielles :** [1.50.0 — 2024-09-02](https://easypanel.io/changelog/1-50-0-1), [2.1.0 — 2024-11-18](https://easypanel.io/changelog/2-1-0-1).

### H31 — Annulation, concurrence et interruption

**Priorité P0 · Critères : A18, C13**

**Fait publié, paraphrasé :** L’annulation des builds est ajoutée; le dernier déploiement peut annuler les précédents, les actions sont arrêtées au redémarrage, puis une course d’annulation est corrigée.

**Exigence originale dérivée :** Définir une machine d’états durable; annuler un job ne doit ni tuer un autre job ni annoncer succès avant finalisation.

**Scénario de non-régression proposé :**

1. Déclencher finish et cancel simultanément mille fois dans un test contrôlé: un seul état terminal cohérent.
2. SIGKILL aux frontières du journal puis redémarrer: l’action reste interrompue ou réconciliée, jamais faussement réussie.

**Sources officielles :** [1.43.0 — 2024-06-25](https://easypanel.io/changelog/1-43-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [2.12.0 — 2025-02-19](https://easypanel.io/changelog/2-12-0-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0).

### H32 — Journal global, acteur, fuseau et identité stable

**Priorité P0 · Critères : A13, F11, S02**

**Fait publié, paraphrasé :** Les actions gagnent vue globale, acteur et origine; des bugs affectent installation neuve, fuseau horaire et historique après renommage.

**Exigence originale dérivée :** Persister UUID, acteur, source UI/API/système, timestamps UTC et état; l’affichage local ne modifie pas les données. Journaliser les changements sans valeurs secrètes.

**Scénario de non-régression proposé :**

1. Créer sur une installation vierge, changer de fuseau puis renommer le service: ordre, identité et liens historiques restent corrects.
2. Job planifié et requête API conservent des origines distinctes après restart.

**Sources officielles :** [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1), [2.3.3 — 2024-12-20](https://easypanel.io/changelog/2-3-3-1), [2.4.0 — 2025-01-02](https://easypanel.io/changelog/2-4-0-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1), [2.11.0 — 2025-02-17](https://easypanel.io/changelog/2-11-0-1), [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1), [2.26.0 — 2026-02-11](https://easypanel.io/changelog/2-26-0), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0).

### H33 — Journaux : ordre, répétitions, fluidité et taille

**Priorité P1 · Critères : R15, R18, A13**

**Fait publié, paraphrasé :** Les publications corrigent défilement, ordre, largeur, répétition et modales des logs; elles ajoutent rotation et logs par service Compose.

**Exigence originale dérivée :** Définir curseur/reprise, limites de rétention et séparation stderr/stdout; éviter doublons de transport sans supprimer de vraies lignes identiques.

**Scénario de non-régression proposé :**

1. Une fixture émet deux lignes identiques légitimes et subit une reconnexion: deux lignes, pas une ni quatre.
2. Débit élevé, pause, filtre, mobile et rotation restent utilisables sans mémoire non bornée.

**Sources officielles :** [1.12.4 — 2022-10-31](https://easypanel.io/changelog/1-12-4-1), [1.47.0 — 2024-08-01](https://easypanel.io/changelog/1-47-0-1), [1.47.1 — 2024-08-02](https://easypanel.io/changelog/1-47-1-1), [1.47.3 — 2024-08-05](https://easypanel.io/changelog/1-47-3-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [2.2.3 — 2024-12-14](https://easypanel.io/changelog/2-2-3-1), [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H34 — Révélation et propagation contrôlée des secrets

**Priorité P0 · Critères : F10, D06, S02**

**Fait publié, paraphrasé :** Un défaut de révélation de mot de passe est corrigé; des durcissements touchent plus tard les journaux et actions WordPress. Aucun mécanisme détaillé n’est publié.

**Exigence originale dérivée :** Révéler un secret seulement sur action autorisée, ne jamais le placer dans inventaires ou traces; redacter aussi les anciens secrets appliqués.

**Scénario de non-régression proposé :**

1. Tester viewer/opérateur/admin sur réponses, logs et erreurs.
2. Émettre un secret en fragments et changer ensuite le secret: les fragments reconstitués et les anciennes valeurs restent masqués.

**Sources officielles :** [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H35 — Rotation de mot de passe native

**Priorité P0 · Critères : D07, D06**

**Fait publié, paraphrasé :** Le changement de mot de passe de base est introduit puis corrigé dans la version suivante.

**Exigence originale dérivée :** Changer le compte dans le moteur avant de valider sa configuration; prévoir compensation si la persistance échoue.

**Scénario de non-régression proposé :**

1. Sur une base déjà remplie, l’ancien secret échoue et le nouveau se connecte depuis un client réseau indépendant.
2. Échec en cours de rotation: un état récupérable décrit la réalité du moteur, pas seulement son environnement.

**Sources officielles :** [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [1.40.0 — 2024-05-01](https://easypanel.io/changelog/1-40-0-1).

### H36 — Noms, utilisateurs et configuration native des bases

**Priorité P1 · Critères : D01, D02, D03, D04, D06, D09**

**Fait publié, paraphrasé :** Des noms/utilisateurs personnalisés et configurations MySQL/MariaDB sont ajoutés; noms affichés et clients PostgreSQL personnalisés sont corrigés.

**Exigence originale dérivée :** Utiliser le profil réellement appliqué, encoder les URI, valider identifiants sans interpolation shell/SQL et refuser les topologies non prises en charge.

**Scénario de non-régression proposé :**

1. Noms autorisés avec ponctuation et secret réservé URI: le client utilise les bons paramètres.
2. Une chaîne de connexion injectée comme nom ou un data_directory hors volume géré est refusé avant sauvegarde/restauration.

**Sources officielles :** [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.2.1 — 2024-12-09](https://easypanel.io/changelog/2-2-1-1), [2.3.2 — 2024-12-20](https://easypanel.io/changelog/2-3-2-1), [2.6.0 — 2025-01-20](https://easypanel.io/changelog/2-6-0-1), [2.20.0 — 2025-06-10](https://easypanel.io/changelog/2-20-0-1).

### H37 — Périmètre exact des dumps et restauration

**Priorité P0 · Critères : D10, D13**

**Fait publié, paraphrasé :** Les sauvegardes bêta précèdent la restauration; 1.31.0 limite le dump à la base par défaut, puis la sélection et les sauvegardes multiples évoluent.

**Exigence originale dérivée :** Versionner format et périmètre; distinguer dump mono-base, instance complète, utilisateurs et rôles. Harborlight choisit explicitement ses propres formats.

**Scénario de non-régression proposé :**

1. Créer deux bases et comptes distincts, restaurer et vérifier exactement le périmètre annoncé.
2. Pour un dump d’instance, vérifier adoption des comptes source, refus anciens comptes cible et absence de perte des volumes précédents.

**Sources officielles :** [1.15.0 — 2023-03-02](https://easypanel.io/changelog/1-15-0-1), [1.31.0 — 2024-01-05](https://easypanel.io/changelog/1-31-0-1), [1.33.0 — 2024-02-16](https://easypanel.io/changelog/1-33-0-1), [2.14.0 — 2025-03-24](https://easypanel.io/changelog/2-14-0-1), [Database backups are here! — 2023-03-02](https://easypanel.io/blog/database-backups-are-here).

### H38 — Planification et rétention des sauvegardes

**Priorité P1 · Critères : D11, D12**

**Fait publié, paraphrasé :** Les sauvegardes programmées sont annoncées en 2023; la purge est alors future. Des réglages de rétention arrivent en 2026.

**Exigence originale dérivée :** Rendre fuseau, prochain passage, reprise après redémarrage et rétention explicites; ne supprimer que les fichiers attribués à ce service/job.

**Scénario de non-régression proposé :**

1. Avec horloge contrôlée, redémarrer après trois échéances: pas de tempête de rattrapage.
2. Busy/échec ne supprime pas la dernière copie valide; tester fichiers manquants, symlinks et changement de configuration.

**Sources officielles :** [1.15.0 — 2023-03-02](https://easypanel.io/changelog/1-15-0-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0), [Database backups are here! — 2023-03-02](https://easypanel.io/blog/database-backups-are-here).

### H39 — Grandes sauvegardes et MySQL GTID

**Priorité P0 · Critères : D02, D10, D13**

**Fait publié, paraphrasé :** Deux correctifs distincts concernent grandes bases et sauvegardes MySQL avec GTID actif.

**Exigence originale dérivée :** Streamer les dumps vers un fichier durable et borner la mémoire; définir les options GTID pour le périmètre importé.

**Scénario de non-régression proposé :**

1. Sauvegarder/restaurer une fixture dépassant le budget mémoire du processus puis vérifier des lignes en début/fin.
2. Sur MySQL GTID activé, valider import, utilisateurs et absence de mutation de la source; le test MySQL standard seul ne couvre pas GTID.

**Sources officielles :** [1.52.0 — 2024-09-30](https://easypanel.io/changelog/1-52-0-1), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0).

### H40 — Chemins et noms de sauvegarde

**Priorité P0 · Critères : D10, D12, D15**

**Fait publié, paraphrasé :** Validation des chemins, acceptation des points, nom de base et nommage des copies manuelles évoluent par corrections successives.

**Exigence originale dérivée :** Conserver les noms légitimes tout en refusant traversée et liens; séparer nom d’affichage, nom natif et identifiant fichier interne.

**Scénario de non-régression proposé :**

1. Accepter backup.2026-11-08.sql dans le répertoire prévu; refuser ../, symlink et caractères de contrôle.
2. Deux copies de même titre conservent des identifiants distincts et un téléchargement autorisé.

**Sources officielles :** [2.14.0 — 2025-03-24](https://easypanel.io/changelog/2-14-0-1), [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1), [2.20.0 — 2025-06-10](https://easypanel.io/changelog/2-20-0-1), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0).

### H41 — Stockage distant, OAuth et sauvegardes de volumes

**Priorité P1 · Critères : D14, D16, D17, D18**

**Fait publié, paraphrasé :** Des fournisseurs locaux/FTP/SFTP/Dropbox/Drive puis sauvegardes de volumes sont ajoutés; OAuth Drive et S3 volumes sont corrigés; classes S3 et R2 suivent.

**Exigence originale dérivée :** Modéliser upload, vérification, téléchargement, refresh et révocation séparément; une copie locale réussie ne signifie pas upload réussi.

**Scénario de non-régression proposé :**

1. Avec bucket S3 test et fournisseur OAuth simulant expiration, vérifier upload/download/checksum et refresh unique.
2. Une destination invalide reste supprimable; rétention ne touche aucun objet extérieur au préfixe attribué.

**Sources officielles :** [2.6.0 — 2025-01-20](https://easypanel.io/changelog/2-6-0-1), [2.7.0 — 2025-01-23](https://easypanel.io/changelog/2-7-0-1), [2.8.0 — 2025-01-30](https://easypanel.io/changelog/2-8-0-1), [2.12.0 — 2025-02-19](https://easypanel.io/changelog/2-12-0-1), [2.12.1 — 2025-02-19](https://easypanel.io/changelog/2-12-1-1), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0), [Database backups are here! — 2023-03-02](https://easypanel.io/blog/database-backups-are-here).

### H42 — Persistance et permissions des volumes

**Priorité P0 · Critères : R02, R03, D14, C02**

**Fait publié, paraphrasé :** La persistance de fichiers Compose dans le dépôt est améliorée; les sauvegardes de volumes et leurs permissions font l’objet d’évolutions.

**Exigence originale dérivée :** Séparer source reconstruite et données persistantes; conserver UID/GID/modes et gérer explicitement liens et chemins non supportés.

**Scénario de non-régression proposé :**

1. Réécrire le dépôt puis déployer: la donnée utilisateur reste présente.
2. Restaurer un fichier Unicode UID123/GID234/mode0640 et vérifier contenu et droits; un lien non supporté provoque un refus explicite.

**Sources officielles :** [1.48.0 — 2024-08-16](https://easypanel.io/changelog/1-48-0-1), [2.12.0 — 2025-02-19](https://easypanel.io/changelog/2-12-0-1), [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1), [Resource Monitoring, New Dashboard, and Other Improvements — 2022-08-12](https://easypanel.io/blog/changelog-august-2022).

### H43 — Clients de bases : compte personnalisé et nettoyage

**Priorité P1 · Critères : D09, F08, S02**

**Fait publié, paraphrasé :** Des clients web natifs puis DbGate sont ajoutés; pgAdmin oublié lors d’une suppression et clients PostgreSQL avec utilisateurs personnalisés sont corrigés.

**Exigence originale dérivée :** Lier le client web au service exact, à ses identifiants appliqués et à une autorisation; fermer ses routes lors de la désactivation/suppression.

**Scénario de non-régression proposé :**

1. Ouvrir le client sur un utilisateur personnalisé puis révoquer l’accès.
2. Supprimer la base selon la politique annoncée: aucun client web orphelin ni URL encore accessible ne subsiste.

**Sources officielles :** [1.36.0 — 2024-03-22](https://easypanel.io/changelog/1-36-0-1), [1.41.0 — 2024-06-06](https://easypanel.io/changelog/1-41-0-1), [1.45.0 — 2024-07-25](https://easypanel.io/changelog/1-45-0-1), [2.6.0 — 2025-01-20](https://easypanel.io/changelog/2-6-0-1).

### H44 — Compose : source, build et diagnostic par enfant

**Priorité P1 · Critères : C01, C02, C03, C04, C05**

**Fait publié, paraphrasé :** Le service Compose natif apporte source inline/Git, domaines, logs et console; des logs individuels et build au déploiement suivent.

**Exigence originale dérivée :** Annoncer le sous-ensemble YAML supporté, préserver les chemins relatifs et adresser chaque enfant sans confondre la stack avec ses conteneurs.

**Scénario de non-régression proposé :**

1. Une stack à deux enfants conserve ses volumes après stop/start/redeploy.
2. Rejeter clairement un bind hôte ou option non supportée; une erreur d’un enfant est identifiée dans son propre journal.

**Sources officielles :** [1.46.0 — 2024-07-30](https://easypanel.io/changelog/1-46-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1).

### H45 — WordPress : initialisation et opérations natives

**Priorité P2 · Critères : C08, C09**

**Fait publié, paraphrasé :** WordPress natif arrive avec des correctifs d’installation de plugin, base existante, image et création; ses actions sont ensuite durcies.

**Exigence originale dérivée :** Implémenter WordPress comme workflow vérifié avec base privée et commandes natives autorisées, sans déclarer ce support à partir d’un simple modèle Docker.

**Scénario de non-régression proposé :**

1. Installer avec base neuve puis existante; vérifier navigateur, médias, plugin et mise à jour.
2. Un membre hors projet ne peut lancer une action; l’échec d’upgrade garde un chemin de récupération.

**Sources officielles :** [1.52.0 — 2024-09-30](https://easypanel.io/changelog/1-52-0-1), [1.53.0 — 2024-10-03](https://easypanel.io/changelog/1-53-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.1.0 — 2024-11-18](https://easypanel.io/changelog/2-1-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.3.4 — 2024-12-23](https://easypanel.io/changelog/2-3-4-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2), [2.38.0 — 2026-10-22](https://easypanel.io/changelog/2-38-0).

### H46 — Import/export WordPress et charge importante

**Priorité P2 · Critères : C10, D13, F08**

**Fait publié, paraphrasé :** Les snapshots de services sont ajoutés; limites et performances d’import/export WordPress évoluent, puis les noms importés sont validés.

**Exigence originale dérivée :** Distinguer contenu, base et configuration; prévisualiser cible et migrations d’URL, borner l’archive et vérifier le résultat avant adoption.

**Scénario de non-régression proposé :**

1. Importer une fixture avec médias volumineux et URL d’origine; vérifier liens et données après bascule.
2. Nom cible invalide ou archive corrompue: pas de remplacement partiel ni fuite de secrets.

**Sources officielles :** [1.54.0 — 2024-10-10](https://easypanel.io/changelog/1-54-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.4.0 — 2025-01-02](https://easypanel.io/changelog/2-4-0-1).

### H47 — Box : modules, IDE et processus

**Priorité P2 · Critères : C11, C12**

**Fait publié, paraphrasé :** Box bêta introduit IDE et modules; extensions PHP, identité Git, réseau et versions Node évoluent ensuite.

**Exigence originale dérivée :** Décrire une matrice de modules réellement supportés, identité du processus, accès IDE et stockage persistant; garder le reste explicitement indisponible.

**Scénario de non-régression proposé :**

1. Déployer une fixture par module déclaré et vérifier processus, redémarrage et workspace.
2. IDE désactivé ou token révoqué: accès refusé; une extension incompatible échoue avant bascule.

**Sources officielles :** [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.37.0 — 2024-04-04](https://easypanel.io/changelog/1-37-0-1), [1.44.2 — 2024-07-19](https://easypanel.io/changelog/1-44-2-1), [1.47.3 — 2024-08-05](https://easypanel.io/changelog/1-47-3-1), [2.3.4 — 2024-12-23](https://easypanel.io/changelog/2-3-4-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0).

### H48 — Scripts nommés, cron et déclencheurs

**Priorité P1 · Critères : C13, R16, A18**

**Fait publié, paraphrasé :** Box inclut scripts/cron; les routes de scripts évoluent, puis les applications obtiennent un CRUD de scripts nommés.

**Exigence originale dérivée :** Exécuter uniquement dans le service autorisé avec limites, journal, annulation et politique de chevauchement; définir fuseau et sémantique HTTP.

**Scénario de non-régression proposé :**

1. Deux échéances chevauchées respectent la politique documentée sans lancer deux jobs silencieux.
2. Exécution API, manuelle et planifiée conservent acteur/origine et code de sortie; arrêt coupe le bon processus.

**Sources officielles :** [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [2.8.0 — 2025-01-30](https://easypanel.io/changelog/2-8-0-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1), [2.27.0 — 2026-03-13](https://easypanel.io/changelog/2-27-0).

### H49 — Budgets de build et builders distants

**Priorité P2 · Critères : S08, R04, A08**

**Fait publié, paraphrasé :** La priorité CPU des builds est expérimentée, puis des builders avec limites et un guide distant sont introduits.

**Exigence originale dérivée :** Allouer CPU/mémoire et accès réseau du build séparément du runtime; ne pas exposer le socket ou les services du projet sans choix explicite.

**Scénario de non-régression proposé :**

1. Un build dépassant son budget ne rend pas le panneau indisponible.
2. Builder distant perdu: le job échoue ou reprend selon politique, sans déployer une image non vérifiée.

**Sources officielles :** [1.31.0 — 2024-01-05](https://easypanel.io/changelog/1-31-0-1), [2.8.0 — 2025-01-30](https://easypanel.io/changelog/2-8-0-1), [2.12.0 — 2025-02-19](https://easypanel.io/changelog/2-12-0-1).

### H50 — Nettoyage Docker ciblé et prévisualisé

**Priorité P0 · Critères : S07, A17, F08**

**Fait publié, paraphrasé :** Le nettoyage images/builders et sa planification évoluent; plusieurs correctifs touchent valeurs par défaut et images devenues introuvables.

**Exigence originale dérivée :** Prévisualiser les objets possédés et les références conservées; aucune purge globale implicite, aucun volume utilisateur ou image de rollback retenue supprimé.

**Scénario de non-régression proposé :**

1. Daemon partagé avec ressources étrangères, images partagées et releases: seules les références sélectionnées disparaissent.
2. Annulation ou changement d’inventaire entre preview/exécution provoque réévaluation, pas élargissement du périmètre.

**Sources officielles :** [1.24.0 — 2023-09-29](https://easypanel.io/changelog/1-24-0-1), [1.25.0 — 2023-11-13](https://easypanel.io/changelog/1-25-0-1), [1.25.1 — 2023-11-13](https://easypanel.io/changelog/1-25-1-1), [1.32.0 — 2024-01-25](https://easypanel.io/changelog/1-32-0-1), [1.44.0 — 2024-07-17](https://easypanel.io/changelog/1-44-0-1), [2.10.0 — 2025-02-14](https://easypanel.io/changelog/2-10-0-1), [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1).

### H51 — Pression disque et limites des journaux

**Priorité P0 · Critères : S01, R18, S07**

**Fait publié, paraphrasé :** Une rotation bornée des logs est introduite pour éviter saturation; une analyse disque distingue stockage service et éléments exclus.

**Exigence originale dérivée :** Afficher capacité réelle du daemon séparée du disque du panneau et calculer le coût de sauvegarde/candidat; traiter ENOSPC sans corrompre l’état.

**Scénario de non-régression proposé :**

1. Simuler disque plein lors du dump, de la sauvegarde d’état et de la création candidat: pas de faux succès, ancien runtime intact.
2. Vérifier que la rotation et la suppression ciblée rendent l’espace attendu.

**Sources officielles :** [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1), [2.19.0 — 2025-05-23](https://easypanel.io/changelog/2-19-0-1).

### H52 — Compatibilité Docker et avertissements versionnés

**Priorité P1 · Critères : S01, S11**

**Fait publié, paraphrasé :** Un contrôle de version Docker est ajouté, immédiatement suivi d’un correctif pour anciennes versions et d’un avertissement renforcé.

**Exigence originale dérivée :** Publier une version minimale testée et détecter les fonctionnalités requises avant mutation; ne pas déduire compatibilité d’un simple numéro affiché.

**Scénario de non-régression proposé :**

1. Simuler API Docker ancienne, absente et compatible; commandes indisponibles ne sont pas exécutées.
2. La recommandation d’upgrade est affichée sans lancer une mise à jour hôte automatiquement.

**Sources officielles :** [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0), [2.25.1 — 2026-02-04](https://easypanel.io/changelog/2-25-1), [2.29.3 — 2026-04-17](https://easypanel.io/changelog/2-29-3).

### H53 — Mise à jour du panneau et dépendances actives

**Priorité P0 · Critères : S11, S01, F11**

**Fait publié, paraphrasé :** Des dépendances de sécurité sont régulièrement mises à jour; certaines nécessitent un redémarrage manuel. Un patch corrige un script pouvant empêcher le panneau de démarrer. Une version annonce également une réduction de la taille de l’image.

**Exigence originale dérivée :** Distinguer version installée et active, montrer changements/migrations, sauvegarder état et clés, prévoir rollback du panneau sans toucher les workloads. Enregistrer le digest et la taille de l’artefact livré.

**Scénario de non-régression proposé :**

1. Interrompre une mise à jour après téléchargement et après migration; l’accès se récupère selon procédure vérifiée.
2. Après restart, contrôler les versions réellement exécutées et non seulement le tag téléchargé.

**Sources officielles :** [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.36.2 — 2024-03-26](https://easypanel.io/changelog/1-36-2-1), [1.38.1 — 2024-04-13](https://easypanel.io/changelog/1-38-1-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.51.1 — 2024-09-13](https://easypanel.io/changelog/1-51-1-1), [1.52.0 — 2024-09-30](https://easypanel.io/changelog/1-52-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.11.2 — 2025-02-19](https://easypanel.io/changelog/2-11-2-1), [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1), [2.25.0 — 2026-02-04](https://easypanel.io/changelog/2-25-0), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0), [2.35.0 — 2026-09-16](https://easypanel.io/changelog/2-35-0), [2.38.0 — 2026-10-22](https://easypanel.io/changelog/2-38-0).

### H54 — Compaction de l’état au démarrage

**Priorité P0 · Critères : F11, S11**

**Fait publié, paraphrasé :** La compaction automatique de la base du panneau au démarrage est annoncée. Le mécanisme interne n’est pas publié.

**Exigence originale dérivée :** Toute compaction/migration Harborlight doit être transactionnelle, verrouillée et compatible avec la sauvegarde de l’état chiffré.

**Scénario de non-régression proposé :**

1. Tuer le processus au milieu d’une compaction simulée: au prochain démarrage, obtenir un état ancien ou nouveau valide.
2. Deux writers concurrents et un disque plein doivent échouer sans perte silencieuse.

**Sources officielles :** [2.30.0 — 2026-04-22](https://easypanel.io/changelog/2-30-0).

### H55 — Snapshots de configuration et migration serveur

**Priorité P1 · Critères : S11, F03, F08, D13**

**Fait publié, paraphrasé :** Des snapshots export/import puis migration serveur sont ajoutés; tailles et validation des noms évoluent.

**Exigence originale dérivée :** Séparer copie de configuration et transfert des données; vérifier versions, secrets, conflits de ports, volumes et intégrité avant activer la cible.

**Scénario de non-régression proposé :**

1. Migrer une fixture avec données et comptes; la source reste récupérable tant que la cible n’est pas vérifiée.
2. Nom/ID interdit, fichier corrompu ou port occupé: aucun écrasement hors cible confirmée.

**Sources officielles :** [1.54.0 — 2024-10-10](https://easypanel.io/changelog/1-54-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.4.0 — 2025-01-02](https://easypanel.io/changelog/2-4-0-1), [2.10.0 — 2025-02-14](https://easypanel.io/changelog/2-10-0-1).

### H56 — Renommer, déplacer et supprimer sans perdre les liens

**Priorité P0 · Critères : F03, F08, R06, A13**

**Fait publié, paraphrasé :** Renommage/déplacement sont ajoutés; répertoire manquant, services non initialisés, historique et domaines perdus au renommage font l’objet de correctifs.

**Exigence originale dérivée :** Utiliser UUID stables pour routes, jobs, secrets et volumes; définir transfert de droits et nettoyage des dépendances avec confirmation.

**Scénario de non-régression proposé :**

1. Renommer puis déplacer vers un projet vide: domaines, données et historique restent associés au bon UUID.
2. Supprimer un service partiellement créé n’affecte aucun voisin et indique clairement les données conservées.

**Sources officielles :** [1.37.0 — 2024-04-04](https://easypanel.io/changelog/1-37-0-1), [1.38.2 — 2024-04-16](https://easypanel.io/changelog/1-38-2-1), [1.45.0 — 2024-07-25](https://easypanel.io/changelog/1-45-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1), [2.10.0 — 2025-02-14](https://easypanel.io/changelog/2-10-0-1), [2.24.0 — 2025-12-31](https://easypanel.io/changelog/2-24-0-1).

### H57 — Tunnels Cloudflare et règles existantes

**Priorité P2 · Critères : S09, S10**

**Fait publié, paraphrasé :** Cloudflared natif, domaines racines et conservation des règles existantes sont ajoutés/corrigés; la version du tunnel est ensuite actualisée.

**Exigence originale dérivée :** Limiter les tokens au tunnel visé, fusionner les règles explicitement possédées et conserver un accès local au panneau.

**Scénario de non-régression proposé :**

1. Ajouter/supprimer une règle Harborlight dans un tunnel comportant une règle externe: celle-ci reste intacte.
2. Rotation du token et mise à jour du binaire sont vérifiées sans confondre tunnel actif et configuration enregistrée.

**Sources officielles :** [1.55.0 — 2024-10-11](https://easypanel.io/changelog/1-55-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.2.2 — 2024-12-09](https://easypanel.io/changelog/2-2-2-1), [2.38.0 — 2026-10-22](https://easypanel.io/changelog/2-38-0).

### H58 — Notifications d’événements et tests de livraison

**Priorité P2 · Critères : S06, D11**

**Fait publié, paraphrasé :** Des canaux de notification et événements de déploiement, sauvegarde, disque ou mise à jour sont ajoutés, puis un canal webhook.

**Exigence originale dérivée :** Définir événement, destinataire autorisé, retry, déduplication et masquage; une notification échouée ne change pas rétroactivement le résultat du job.

**Scénario de non-régression proposé :**

1. Simuler timeout, réponse500 puis succès: un événement conserve son ID et ses tentatives.
2. Le message contient cible et résultat utiles, jamais token, mot de passe ou dump.

**Sources officielles :** [1.26.0 — 2023-11-17](https://easypanel.io/changelog/1-26-0-1), [2.9.0 — 2025-02-12](https://easypanel.io/changelog/2-9-0-1).

### H59 — Clés API, sessions et révocation

**Priorité P0 · Critères : S03, F02, F10**

**Fait publié, paraphrasé :** Les tokens API sont introduits puis ouverts aux plans gratuits; une intégration d’authentification bearer est mentionnée.

**Exigence originale dérivée :** Séparer clés et sessions, stocker uniquement un hash vérifiable, limiter permissions/projets, afficher le secret une seule fois et permettre expiration/révocation.

**Scénario de non-régression proposé :**

1. Une clé read-only ne lance pas de mutation et une clé d’un projet ne traverse pas ses limites.
2. Après rotation ou révocation et restart, l’ancienne clé reste refusée et le secret ne figure dans aucune réponse de liste.

**Sources officielles :** [1.27.0 — 2023-11-25](https://easypanel.io/changelog/1-27-0-1), [1.27.1 — 2023-11-25](https://easypanel.io/changelog/1-27-1-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1).

### H60 — API publique, CLI, MCP et conversion des paramètres

**Priorité P1 · Critères : S03, S04, S05**

**Fait publié, paraphrasé :** Documentation API, migration compatible, CLI/MCP et nouveaux contrats publics sont publiés; chemins de documentation et paramètres numériques sont corrigés.

**Exigence originale dérivée :** Versionner les contrats et schémas; préserver identité/scopes entre UI, CLI et MCP; convertir les paramètres sans coercition permissive.

**Scénario de non-régression proposé :**

1. Tester limites numériques, valeurs négatives/NaN et pagination cohérente.
2. Le même appel refusé à l’UI reste refusé via CLI/MCP; une migration garde les contrats promis et documente les ruptures.

**Sources officielles :** [1.53.0 — 2024-10-03](https://easypanel.io/changelog/1-53-0-1), [2.13.0 — 2025-02-26](https://easypanel.io/changelog/2-13-0-1), [2.31.0 — 2026-06-05](https://easypanel.io/changelog/2-31-0), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0), [2.33.0 — 2026-07-31](https://easypanel.io/changelog/2-33-0), [2.33.1 — 2026-08-03](https://easypanel.io/changelog/2-33-1), [2.33.2 — 2026-08-21](https://easypanel.io/changelog/2-33-2), [2.34.0 — 2026-09-10](https://easypanel.io/changelog/2-34-0).

### H61 — Codes HTTP et erreurs compréhensibles

**Priorité P0 · Critères : F12, A13, S04**

**Fait publié, paraphrasé :** Pages d’erreur, diagnostics service/Git et codes API sont améliorés; des réponses génériques500 deviennent401/404/400.

**Exigence originale dérivée :** Définir codes, messages publics et détails internes séparément; ne jamais transformer indisponibilité runtime en succès démo.

**Scénario de non-régression proposé :**

1. Entrée invalide400, anonyme401, ressource inaccessible404 et conflit409 sont cohérents.
2. Une vraie erreur Docker reste visible dans le job avec un identifiant de diagnostic et sans secret.

**Sources officielles :** [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.38.0 — 2024-04-12](https://easypanel.io/changelog/1-38-0-1), [1.44.0 — 2024-07-17](https://easypanel.io/changelog/1-44-0-1), [2.26.0 — 2026-02-11](https://easypanel.io/changelog/2-26-0).

### H62 — Navigation, recherche et refonte sans perte de workflow

**Priorité P1 · Critères : F04, F07, S12**

**Fait publié, paraphrasé :** Le tableau, la recherche, les onglets mémorisés et plusieurs refontes UX évoluent; 2.0 annonce une refonte visuelle sans rupture fonctionnelle. Un patch corrige aussi le bouton de déploiement.

**Exigence originale dérivée :** Concevoir une UI originale tout en conservant objectifs et étapes; liens profonds, retour navigateur et recherche doivent préserver la sélection autorisée.

**Scénario de non-régression proposé :**

1. Naviguer projet→service→logs puis retour/reload; vérifier écran et contexte.
2. Création/suppression actualise la navigation, et une recherche ne montre jamais un projet inaccessible.

**Sources officielles :** [1.12.4 — 2022-10-31](https://easypanel.io/changelog/1-12-4-1), [1.23.1 — 2023-09-04](https://easypanel.io/changelog/1-23-1-1), [1.24.0 — 2023-09-29](https://easypanel.io/changelog/1-24-0-1), [1.33.0 — 2024-02-16](https://easypanel.io/changelog/1-33-0-1), [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.35.0 — 2024-03-20](https://easypanel.io/changelog/1-35-0-1), [1.53.1 — 2024-10-04](https://easypanel.io/changelog/1-53-1-1), [2.0.0 — 2024-11-07](https://easypanel.io/changelog/2-0-0-1), [2.1.0 — 2024-11-18](https://easypanel.io/changelog/2-1-0-1), [2.2.0 — 2024-12-04](https://easypanel.io/changelog/2-2-0-1), [2.26.0 — 2026-02-11](https://easypanel.io/changelog/2-26-0), [1.30.1 — 2023-12-19](https://easypanel.io/changelog/1-30-1-1), [Resource Monitoring, New Dashboard, and Other Improvements — 2022-08-12](https://easypanel.io/blog/changelog-august-2022).

### H63 — Responsive, thème et surfaces défilantes

**Priorité P1 · Critères : S12, F07**

**Fait publié, paraphrasé :** Les correctifs couvrent mobile, création de modèles, sidebars, modales, logs, couleurs Markdown et toasts sombres.

**Exigence originale dérivée :** Tester clavier et petites largeurs sur les vrais workflows; chaque modale possède focus, fermeture et zone de défilement utilisable.

**Scénario de non-régression proposé :**

1. À 390px et avec texte long, réaliser création, déploiement et confirmation sans débordement global.
2. Changer de thème et zoom 200%: libellés, erreurs, logs et boutons restent lisibles et atteignables.

**Sources officielles :** [1.18.0 — 2023-05-27](https://easypanel.io/changelog/1-18-0-1), [1.19.1 — 2023-07-04](https://easypanel.io/changelog/1-19-1-1), [1.30.2 — 2023-12-19](https://easypanel.io/changelog/1-30-2-1), [1.33.1 — 2024-02-16](https://easypanel.io/changelog/1-33-1-1), [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.40.0 — 2024-05-01](https://easypanel.io/changelog/1-40-0-1), [1.47.1 — 2024-08-02](https://easypanel.io/changelog/1-47-1-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.51.1 — 2024-09-13](https://easypanel.io/changelog/1-51-1-1), [2.6.0 — 2025-01-20](https://easypanel.io/changelog/2-6-0-1), [2.8.0 — 2025-01-30](https://easypanel.io/changelog/2-8-0-1), [2.26.2 — 2026-02-11](https://easypanel.io/changelog/2-26-2), [2.29.0 — 2026-04-16](https://easypanel.io/changelog/2-29-0), [2.29.5 — 2026-04-18](https://easypanel.io/changelog/2-29-5), [2.32.0 — 2026-06-22](https://easypanel.io/changelog/2-32-0), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H64 — Notes de service non intrusives

**Priorité P2 · Critères : F06, S12**

**Fait publié, paraphrasé :** Les notes sont ajoutées, peuvent être masquées puis leur bouton et visibilité à vide sont améliorés.

**Exigence originale dérivée :** Persister les notes par UUID, distinguer contenu vide/masqué et rendre le texte sans exécuter HTML/script.

**Scénario de non-régression proposé :**

1. Éditer, cacher, renommer puis recharger un service: la note reste attachée au bon service.
2. Une note contenant Markdown et HTML malveillant n’exécute aucun code.

**Sources officielles :** [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [1.40.0 — 2024-05-01](https://easypanel.io/changelog/1-40-0-1), [2.29.0 — 2026-04-16](https://easypanel.io/changelog/2-29-0), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H65 — Branding, licences et options commerciales : frontière explicite

**Priorité P2 · Critères : S12, F10**

**Fait publié, paraphrasé :** L’historique inclut plans, licences, logos, page de login, scripts de branding et corrections d’activation. Ces éléments commerciaux ne sont pas des exigences de licence Harborlight.

**Exigence originale dérivée :** Conserver une identité visuelle originale et des préférences sûres; exclure la reproduction des mécanismes de licence propriétaires. Les extensions HTML/script nécessitent une autorisation dédiée si elles existent.

**Scénario de non-régression proposé :**

1. Harborlight fonctionne sans clé Easypanel ni appel au portail commercial.
2. Logo et thème ne modifient pas authentification/origine; une préférence invalide garde une interface récupérable.

**Sources officielles :** [1.17.0 — 2023-05-07](https://easypanel.io/changelog/1-17-0-1), [1.18.0 — 2023-05-27](https://easypanel.io/changelog/1-18-0-1), [1.23.0 — 2023-09-01](https://easypanel.io/changelog/1-23-0-1), [1.24.0 — 2023-09-29](https://easypanel.io/changelog/1-24-0-1), [1.25.0 — 2023-11-13](https://easypanel.io/changelog/1-25-0-1), [1.36.2 — 2024-03-26](https://easypanel.io/changelog/1-36-2-1), [1.41.0 — 2024-06-06](https://easypanel.io/changelog/1-41-0-1), [1.49.0 — 2024-08-30](https://easypanel.io/changelog/1-49-0-1), [1.51.0 — 2024-09-03](https://easypanel.io/changelog/1-51-0-1), [1.51.1 — 2024-09-13](https://easypanel.io/changelog/1-51-1-1), [1.53.0 — 2024-10-03](https://easypanel.io/changelog/1-53-0-1), [1.56.0 — 2024-10-24](https://easypanel.io/changelog/1-56-0-1), [2.1.0 — 2024-11-18](https://easypanel.io/changelog/2-1-0-1), [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1), [2.20.0 — 2025-06-10](https://easypanel.io/changelog/2-20-0-1), [2.24.0 — 2025-12-31](https://easypanel.io/changelog/2-24-0-1), [2.32.1 — 2026-07-02](https://easypanel.io/changelog/2-32-1), [2.32.2 — 2026-07-08](https://easypanel.io/changelog/2-32-2).

### H66 — Installation initiale et état partiel

**Priorité P0 · Critères : F01, F08, F11**

**Fait publié, paraphrasé :** Script setup, wizard et validation initiale sont améliorés; des patches corrigent les actions sur installation fraîche et la création de services spécialisés.

**Exigence originale dérivée :** Créer le premier administrateur une seule fois et rendre les étapes d’installation idempotentes; tracer et nettoyer les ressources partielles avec leur propriété exacte.

**Scénario de non-régression proposé :**

1. Deux bootstraps simultanés n’obtiennent pas deux propriétaires.
2. Arrêter le processus entre configuration et runtime: restart expose un état explicite, sans service fantôme ni mutation d’un daemon existant.

**Sources officielles :** [1.34.0 — 2024-03-11](https://easypanel.io/changelog/1-34-0-1), [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [1.39.1 — 2024-04-27](https://easypanel.io/changelog/1-39-1-1), [2.3.3 — 2024-12-20](https://easypanel.io/changelog/2-3-3-1), [2.3.4 — 2024-12-23](https://easypanel.io/changelog/2-3-4-1).

### H67 — Validation des identités et absence d’énumération

**Priorité P0 · Critères : F01, F02, F09**

**Fait publié, paraphrasé :** Validation email, session mémorisée et double authentification évoluent; un message révélant un utilisateur absent est supprimé pour sécurité.

**Exigence originale dérivée :** Normaliser les identités sans collision, limiter les tentatives et rendre les erreurs de login/récupération indistinguables sur l’existence du compte.

**Scénario de non-régression proposé :**

1. Compte absent et mauvais secret produisent le même contrat public; tester casse et email valide atypique.
2. Expiration et logout invalident la session selon la durée configurée, même après reconnexion du navigateur.

**Sources officielles :** [1.24.4 — 2023-10-30](https://easypanel.io/changelog/1-24-4-1), [1.39.0 — 2024-04-26](https://easypanel.io/changelog/1-39-0-1), [1.42.0 — 2024-06-21](https://easypanel.io/changelog/1-42-0-1), [2.4.0 — 2025-01-02](https://easypanel.io/changelog/2-4-0-1).

### H68 — Mode démo et transports temps réel

**Priorité P0 · Critères : F12, R16**

**Fait publié, paraphrasé :** Un mode démo explicite est introduit; WebSocket et site de démonstration reçoivent des correctifs.

**Exigence originale dérivée :** Garder les simulations explicitement étiquetées et empêcher qu’un contrôle démo paraisse agir sur Docker; tester séparément les transports réels.

**Scénario de non-régression proposé :**

1. Dans la démo, aucune action terminal/restore/rollback non simulée n’annonce un succès réel.
2. Dans le vrai runtime, une panne WebSocket ou Docker ne bascule jamais silencieusement vers la démo.

**Sources officielles :** [1.47.1 — 2024-08-02](https://easypanel.io/changelog/1-47-1-1), [1.47.2 — 2024-08-02](https://easypanel.io/changelog/1-47-2-1), [2.33.1 — 2026-08-03](https://easypanel.io/changelog/2-33-1).

### H69 — Compression proxy : ajout puis retrait

**Priorité P1 · Critères : R10, S10**

**Fait publié, paraphrasé :** La compression globale ajoutée en 2.16.0 est retirée en 2.17.0 à cause d’un problème Traefik; l’historique impose de garder les retraits, pas seulement les ajouts.

**Exigence originale dérivée :** Activer les middlewares par politique explicite, tester protocoles et permettre un rollback de configuration sans effacer les routes.

**Scénario de non-régression proposé :**

1. Tester HTML, téléchargement binaire, SSE et WebSocket avec et sans compression.
2. Après rollback du middleware, contenu et headers restent corrects et les domaines inchangés.

**Sources officielles :** [2.16.0 — 2025-05-14](https://easypanel.io/changelog/2-16-0-1), [2.17.0 — 2025-05-19](https://easypanel.io/changelog/2-17-0-1).

### H70 — Source Dockerfile inline et contexte de construction

**Priorité P1 · Critères : A07, A08**

**Fait publié, paraphrasé :** La publication 1.36.0 ajoute un type de source Dockerfile.

**Exigence originale dérivée :** Construire le Dockerfile inline dans un contexte isolé, définir les fichiers disponibles et refuser toute résolution hors workspace; enregistrer le résultat immuable.

**Scénario de non-régression proposé :**

1. Construire une petite application HTTP depuis le texte sauvegardé et contrôler le contenu servi.
2. Dockerfile invalide, contexte absent ou symlink sortant: échec explicite, runtime précédent conservé.

**Sources officielles :** [1.36.0 — 2024-03-22](https://easypanel.io/changelog/1-36-0-1).

## Inventaire de toutes les versions accessibles

Chaque fiche est reliée à au moins une règle; une ligne «catalogue uniquement» n’est pas présentée comme un correctif du moteur. Tous les liens ci-dessous ont répondu HTTP 200 à la collecte.

| Version | Date publiée | Type | Règles |
|---|---|---|---|
| [1.12.3](https://easypanel.io/changelog/1-12-3-1) | 2022-10-15 | patch | H04, H05 |
| [1.12.4](https://easypanel.io/changelog/1-12-4-1) | 2022-10-31 | patch | H02, H33, H62 |
| [1.12.5](https://easypanel.io/changelog/1-12-5-1) | 2022-11-01 | patch | H04 |
| [1.12.6](https://easypanel.io/changelog/1-12-6-1) | 2022-11-05 | patch | H03, H04 |
| [1.12.7](https://easypanel.io/changelog/1-12-7-1) | 2022-11-05 | patch | H02, H05, H18 |
| [1.12.8](https://easypanel.io/changelog/1-12-8-1) | 2022-11-15 | patch | H04 |
| [1.12.9](https://easypanel.io/changelog/1-12-9-1) | 2022-12-10 | patch | H04 |
| [1.12.10](https://easypanel.io/changelog/1-12-10-1) | 2023-01-02 | patch | H04 |
| [1.13.0](https://easypanel.io/changelog/1-13-0-1) | 2023-01-03 | mineure/majeure | H03, H05, H06 |
| [1.13.1](https://easypanel.io/changelog/1-13-1-1) | 2023-01-08 | patch | H04, H14 |
| [1.13.2](https://easypanel.io/changelog/1-13-2-1) | 2023-01-28 | patch | H04 |
| [1.14.0](https://easypanel.io/changelog/1-14-0-1) | 2023-02-22 | mineure/majeure | H04, H07 |
| [1.15.0](https://easypanel.io/changelog/1-15-0-1) | 2023-03-02 | mineure/majeure | H04, H08, H37, H38 |
| [1.15.1](https://easypanel.io/changelog/1-15-1-1) | 2023-03-07 | patch | H05, H09 |
| [1.15.2](https://easypanel.io/changelog/1-15-2-1) | 2023-03-08 | patch | H09 |
| [1.15.3](https://easypanel.io/changelog/1-15-3-1) | 2023-03-09 | patch | H05 |
| [1.15.4](https://easypanel.io/changelog/1-15-4-1) | 2023-03-13 | patch | H04, H10 |
| [1.15.5](https://easypanel.io/changelog/1-15-5-1) | 2023-03-28 | patch | H04 |
| [1.16.0](https://easypanel.io/changelog/1-16-0-1) | 2023-04-04 | mineure/majeure | H11 |
| [1.17.0](https://easypanel.io/changelog/1-17-0-1) | 2023-05-07 | mineure/majeure | H04, H05, H17, H65 |
| [1.18.0](https://easypanel.io/changelog/1-18-0-1) | 2023-05-27 | mineure/majeure | H04, H05, H08, H12, H63, H65 |
| [1.19.1](https://easypanel.io/changelog/1-19-1-1) | 2023-07-04 | patch | H04, H25, H63 |
| [1.20.1](https://easypanel.io/changelog/1-20-1-1) | 2023-07-08 | patch | H04, H10, H13, H14 |
| [1.21.0](https://easypanel.io/changelog/1-21-0-1) | 2023-08-03 | mineure/majeure | H01, H12, H20 |
| [1.22.0](https://easypanel.io/changelog/1-22-0-1) | 2023-08-09 | mineure/majeure | H01 |
| [1.23.0](https://easypanel.io/changelog/1-23-0-1) | 2023-09-01 | mineure/majeure | H65 |
| [1.23.1](https://easypanel.io/changelog/1-23-1-1) | 2023-09-04 | patch | H04, H62 |
| [1.24.0](https://easypanel.io/changelog/1-24-0-1) | 2023-09-29 | mineure/majeure | H50, H62, H65 |
| [1.24.4](https://easypanel.io/changelog/1-24-4-1) | 2023-10-30 | patch | H67 |
| [1.25.0](https://easypanel.io/changelog/1-25-0-1) | 2023-11-13 | mineure/majeure | H50, H65 |
| [1.25.1](https://easypanel.io/changelog/1-25-1-1) | 2023-11-13 | patch | H50 |
| [1.26.0](https://easypanel.io/changelog/1-26-0-1) | 2023-11-17 | mineure/majeure | H58 |
| [1.27.0](https://easypanel.io/changelog/1-27-0-1) | 2023-11-25 | mineure/majeure | H27, H59 |
| [1.27.1](https://easypanel.io/changelog/1-27-1-1) | 2023-11-25 | patch | H59 |
| [1.28.0](https://easypanel.io/changelog/1-28-0-1) | 2023-11-27 | mineure/majeure | H14 |
| [1.29.0](https://easypanel.io/changelog/1-29-0-1) | 2023-11-28 | mineure/majeure | H01, H16 |
| [1.30.0](https://easypanel.io/changelog/1-30-0-1) | 2023-12-19 | mineure/majeure | H05, H16, H28 |
| [1.30.1](https://easypanel.io/changelog/1-30-1-1) | 2023-12-19 | patch | H62 |
| [1.30.2](https://easypanel.io/changelog/1-30-2-1) | 2023-12-19 | patch | H63 |
| [1.31.0](https://easypanel.io/changelog/1-31-0-1) | 2024-01-05 | mineure/majeure | H04, H37, H49 |
| [1.31.3](https://easypanel.io/changelog/1-31-3-1) | 2024-01-06 | patch | H04, H05 |
| [1.32.0](https://easypanel.io/changelog/1-32-0-1) | 2024-01-25 | mineure/majeure | H04, H14, H20, H50 |
| [1.33.0](https://easypanel.io/changelog/1-33-0-1) | 2024-02-16 | mineure/majeure | H02, H23, H37, H62 |
| [1.33.1](https://easypanel.io/changelog/1-33-1-1) | 2024-02-16 | patch | H63 |
| [1.33.2](https://easypanel.io/changelog/1-33-2-1) | 2024-02-17 | patch | H29 |
| [1.33.3](https://easypanel.io/changelog/1-33-3-1) | 2024-02-17 | patch | H25 |
| [1.33.4](https://easypanel.io/changelog/1-33-4-1) | 2024-02-21 | patch | H02, H29 |
| [1.33.5](https://easypanel.io/changelog/1-33-5-1) | 2024-02-28 | patch | H19, H29 |
| [1.34.0](https://easypanel.io/changelog/1-34-0-1) | 2024-03-11 | mineure/majeure | H28, H47, H48, H61, H62, H63, H66 |
| [1.35.0](https://easypanel.io/changelog/1-35-0-1) | 2024-03-20 | mineure/majeure | H14, H17, H26, H47, H53, H62 |
| [1.36.0](https://easypanel.io/changelog/1-36-0-1) | 2024-03-22 | mineure/majeure | H14, H25, H43, H70 |
| [1.36.1](https://easypanel.io/changelog/1-36-1-1) | 2024-03-22 | patch | H08 |
| [1.36.2](https://easypanel.io/changelog/1-36-2-1) | 2024-03-26 | patch | H53, H65 |
| [1.37.0](https://easypanel.io/changelog/1-37-0-1) | 2024-04-04 | mineure/majeure | H17, H20, H21, H47, H56 |
| [1.37.1](https://easypanel.io/changelog/1-37-1-1) | 2024-04-04 | patch | H15 |
| [1.37.2](https://easypanel.io/changelog/1-37-2-1) | 2024-04-05 | patch | H20 |
| [1.37.3](https://easypanel.io/changelog/1-37-3-1) | 2024-04-05 | patch | H05, H18, H22 |
| [1.37.4](https://easypanel.io/changelog/1-37-4-1) | 2024-04-05 | patch | H17 |
| [1.38.0](https://easypanel.io/changelog/1-38-0-1) | 2024-04-12 | mineure/majeure | H19, H61 |
| [1.38.1](https://easypanel.io/changelog/1-38-1-1) | 2024-04-13 | patch | H19, H53 |
| [1.38.2](https://easypanel.io/changelog/1-38-2-1) | 2024-04-16 | patch | H56 |
| [1.39.0](https://easypanel.io/changelog/1-39-0-1) | 2024-04-26 | mineure/majeure | H02, H04, H18, H35, H64, H66, H67 |
| [1.39.1](https://easypanel.io/changelog/1-39-1-1) | 2024-04-27 | patch | H66 |
| [1.40.0](https://easypanel.io/changelog/1-40-0-1) | 2024-05-01 | mineure/majeure | H04, H15, H18, H35, H63, H64 |
| [1.41.0](https://easypanel.io/changelog/1-41-0-1) | 2024-06-06 | mineure/majeure | H04, H05, H16, H43, H65 |
| [1.42.0](https://easypanel.io/changelog/1-42-0-1) | 2024-06-21 | mineure/majeure | H04, H08, H16, H21, H22, H53, H67 |
| [1.42.1](https://easypanel.io/changelog/1-42-1-1) | 2024-06-22 | patch | H04, H25 |
| [1.43.0](https://easypanel.io/changelog/1-43-0-1) | 2024-06-25 | mineure/majeure | H31 |
| [1.44.0](https://easypanel.io/changelog/1-44-0-1) | 2024-07-17 | mineure/majeure | H04, H26, H50, H61 |
| [1.44.1](https://easypanel.io/changelog/1-44-1-1) | 2024-07-17 | patch | H05, H19 |
| [1.44.2](https://easypanel.io/changelog/1-44-2-1) | 2024-07-19 | patch | H05, H19, H47 |
| [1.45.0](https://easypanel.io/changelog/1-45-0-1) | 2024-07-25 | mineure/majeure | H04, H43, H56 |
| [1.46.0](https://easypanel.io/changelog/1-46-0-1) | 2024-07-30 | mineure/majeure | H04, H29, H44 |
| [1.47.0](https://easypanel.io/changelog/1-47-0-1) | 2024-08-01 | mineure/majeure | H11, H33 |
| [1.47.1](https://easypanel.io/changelog/1-47-1-1) | 2024-08-02 | patch | H04, H10, H33, H63, H68 |
| [1.47.2](https://easypanel.io/changelog/1-47-2-1) | 2024-08-02 | patch | H68 |
| [1.47.3](https://easypanel.io/changelog/1-47-3-1) | 2024-08-05 | patch | H33, H47 |
| [1.47.4](https://easypanel.io/changelog/1-47-4-1) | 2024-08-05 | patch | H04 |
| [1.48.0](https://easypanel.io/changelog/1-48-0-1) | 2024-08-16 | mineure/majeure | H13, H26, H28, H42 |
| [1.49.0](https://easypanel.io/changelog/1-49-0-1) | 2024-08-30 | mineure/majeure | H04, H09, H23, H24, H25, H31, H33, H44, H53, H56, H63, H65 |
| [1.50.0](https://easypanel.io/changelog/1-50-0-1) | 2024-09-02 | mineure/majeure | H30 |
| [1.51.0](https://easypanel.io/changelog/1-51-0-1) | 2024-09-03 | mineure/majeure | H24, H25, H65 |
| [1.51.1](https://easypanel.io/changelog/1-51-1-1) | 2024-09-13 | patch | H04, H53, H63, H65 |
| [1.52.0](https://easypanel.io/changelog/1-52-0-1) | 2024-09-30 | mineure/majeure | H26, H39, H45, H53 |
| [1.53.0](https://easypanel.io/changelog/1-53-0-1) | 2024-10-03 | mineure/majeure | H45, H60, H65 |
| [1.53.1](https://easypanel.io/changelog/1-53-1-1) | 2024-10-04 | patch | H62 |
| [1.54.0](https://easypanel.io/changelog/1-54-0-1) | 2024-10-10 | mineure/majeure | H04, H46, H55 |
| [1.55.0](https://easypanel.io/changelog/1-55-0-1) | 2024-10-11 | mineure/majeure | H04, H57 |
| [1.56.0](https://easypanel.io/changelog/1-56-0-1) | 2024-10-24 | mineure/majeure | H04, H45, H46, H55, H56, H57, H65 |
| [2.0.0](https://easypanel.io/changelog/2-0-0-1) | 2024-11-07 | mineure/majeure | H62 |
| [2.1.0](https://easypanel.io/changelog/2-1-0-1) | 2024-11-18 | mineure/majeure | H04, H16, H30, H45, H62, H65 |
| [2.2.0](https://easypanel.io/changelog/2-2-0-1) | 2024-12-04 | mineure/majeure | H03, H04, H10, H36, H44, H45, H53, H57, H59, H62 |
| [2.2.1](https://easypanel.io/changelog/2-2-1-1) | 2024-12-09 | patch | H36 |
| [2.2.2](https://easypanel.io/changelog/2-2-2-1) | 2024-12-09 | patch | H57 |
| [2.2.3](https://easypanel.io/changelog/2-2-3-1) | 2024-12-14 | patch | H33 |
| [2.3.2](https://easypanel.io/changelog/2-3-2-1) | 2024-12-20 | patch | H13, H14, H18, H29, H32, H36 |
| [2.3.3](https://easypanel.io/changelog/2-3-3-1) | 2024-12-20 | patch | H32, H66 |
| [2.3.4](https://easypanel.io/changelog/2-3-4-1) | 2024-12-23 | patch | H45, H47, H66 |
| [2.4.0](https://easypanel.io/changelog/2-4-0-1) | 2025-01-02 | mineure/majeure | H04, H32, H46, H55, H67 |
| [2.5.0](https://easypanel.io/changelog/2-5-0-1) | 2025-01-06 | mineure/majeure | H04, H05 |
| [2.6.0](https://easypanel.io/changelog/2-6-0-1) | 2025-01-20 | mineure/majeure | H04, H23, H36, H41, H43, H63 |
| [2.7.0](https://easypanel.io/changelog/2-7-0-1) | 2025-01-23 | mineure/majeure | H04, H41 |
| [2.8.0](https://easypanel.io/changelog/2-8-0-1) | 2025-01-30 | mineure/majeure | H04, H41, H48, H49, H63 |
| [2.9.0](https://easypanel.io/changelog/2-9-0-1) | 2025-02-12 | mineure/majeure | H04, H14, H32, H45, H48, H56, H58 |
| [2.10.0](https://easypanel.io/changelog/2-10-0-1) | 2025-02-14 | mineure/majeure | H04, H17, H50, H55, H56 |
| [2.11.0](https://easypanel.io/changelog/2-11-0-1) | 2025-02-17 | mineure/majeure | H04, H32 |
| [2.11.1](https://easypanel.io/changelog/2-11-1-1) | 2025-02-18 | patch | H16 |
| [2.11.2](https://easypanel.io/changelog/2-11-2-1) | 2025-02-19 | patch | H53 |
| [2.12.0](https://easypanel.io/changelog/2-12-0-1) | 2025-02-19 | mineure/majeure | H21, H31, H41, H42, H49 |
| [2.12.1](https://easypanel.io/changelog/2-12-1-1) | 2025-02-19 | patch | H41 |
| [2.13.0](https://easypanel.io/changelog/2-13-0-1) | 2025-02-26 | mineure/majeure | H60 |
| [2.14.0](https://easypanel.io/changelog/2-14-0-1) | 2025-03-24 | mineure/majeure | H04, H05, H37, H40 |
| [2.15.0](https://easypanel.io/changelog/2-15-0-1) | 2025-04-14 | mineure/majeure | H04 |
| [2.16.0](https://easypanel.io/changelog/2-16-0-1) | 2025-05-14 | mineure/majeure | H13, H32, H34, H40, H50, H69 |
| [2.17.0](https://easypanel.io/changelog/2-17-0-1) | 2025-05-19 | mineure/majeure | H33, H42, H51, H53, H65, H69 |
| [2.18.0](https://easypanel.io/changelog/2-18-0-1) | 2025-05-21 | mineure/majeure | H04 |
| [2.19.0](https://easypanel.io/changelog/2-19-0-1) | 2025-05-23 | mineure/majeure | H01, H51 |
| [2.20.0](https://easypanel.io/changelog/2-20-0-1) | 2025-06-10 | mineure/majeure | H04, H07, H36, H40, H65 |
| [2.20.1](https://easypanel.io/changelog/2-20-1-1) | 2025-06-10 | patch | H07 |
| [2.21.0](https://easypanel.io/changelog/2-21-0-1) | 2025-06-25 | mineure/majeure | H04 |
| [2.22.0](https://easypanel.io/changelog/2-22-0-1) | 2025-08-29 | mineure/majeure | H04 |
| [2.23.0](https://easypanel.io/changelog/2-23-0-1) | 2025-10-06 | mineure/majeure | H04 |
| [2.24.0](https://easypanel.io/changelog/2-24-0-1) | 2025-12-31 | mineure/majeure | H04, H05, H09, H56, H65 |
| [2.25.0](https://easypanel.io/changelog/2-25-0) | 2026-02-04 | mineure/majeure | H04, H05, H23, H29, H31, H38, H47, H52, H53 |
| [2.25.1](https://easypanel.io/changelog/2-25-1) | 2026-02-04 | patch | H52 |
| [2.26.0](https://easypanel.io/changelog/2-26-0) | 2026-02-11 | mineure/majeure | H04, H17, H32, H61, H62 |
| [2.26.1](https://easypanel.io/changelog/2-26-1) | 2026-02-11 | patch | H17 |
| [2.26.2](https://easypanel.io/changelog/2-26-2) | 2026-02-11 | patch | H63 |
| [2.26.3](https://easypanel.io/changelog/2-26-3) | 2026-02-13 | patch | H03, H17 |
| [2.27.0](https://easypanel.io/changelog/2-27-0) | 2026-03-13 | mineure/majeure | H04, H48 |
| [2.28.0](https://easypanel.io/changelog/2-28-0) | 2026-03-24 | mineure/majeure | H04 |
| [2.29.0](https://easypanel.io/changelog/2-29-0) | 2026-04-16 | mineure/majeure | H01, H63, H64 |
| [2.29.1](https://easypanel.io/changelog/2-29-1) | 2026-04-16 | patch | H04 |
| [2.29.2](https://easypanel.io/changelog/2-29-2) | 2026-04-17 | patch | H01, H05 |
| [2.29.3](https://easypanel.io/changelog/2-29-3) | 2026-04-17 | patch | H52 |
| [2.29.4](https://easypanel.io/changelog/2-29-4) | 2026-04-18 | patch | H05 |
| [2.29.5](https://easypanel.io/changelog/2-29-5) | 2026-04-18 | patch | H63 |
| [2.30.0](https://easypanel.io/changelog/2-30-0) | 2026-04-22 | mineure/majeure | H54 |
| [2.30.1](https://easypanel.io/changelog/2-30-1) | 2026-05-15 | patch | H08 |
| [2.31.0](https://easypanel.io/changelog/2-31-0) | 2026-06-05 | mineure/majeure | H04, H26, H27, H33, H40, H53, H60 |
| [2.32.0](https://easypanel.io/changelog/2-32-0) | 2026-06-22 | mineure/majeure | H04, H28, H32, H33, H39, H41, H60, H63 |
| [2.32.1](https://easypanel.io/changelog/2-32-1) | 2026-07-02 | patch | H65 |
| [2.32.2](https://easypanel.io/changelog/2-32-2) | 2026-07-08 | patch | H07, H26, H28, H33, H34, H45, H63, H64, H65 |
| [2.33.0](https://easypanel.io/changelog/2-33-0) | 2026-07-31 | mineure/majeure | H60 |
| [2.33.1](https://easypanel.io/changelog/2-33-1) | 2026-08-03 | patch | H60, H68 |
| [2.33.2](https://easypanel.io/changelog/2-33-2) | 2026-08-21 | patch | H60 |
| [2.34.0](https://easypanel.io/changelog/2-34-0) | 2026-09-10 | mineure/majeure | H04, H06, H60 |
| [2.35.0](https://easypanel.io/changelog/2-35-0) | 2026-09-16 | mineure/majeure | H04, H11, H53 |
| [2.36.0](https://easypanel.io/changelog/2-36-0) | 2026-09-24 | mineure/majeure | H04 |
| [2.37.0](https://easypanel.io/changelog/2-37-0) | 2026-10-14 | mineure/majeure | H15 |
| [2.38.0](https://easypanel.io/changelog/2-38-0) | 2026-10-22 | mineure/majeure | H22, H45, H53, H57 |

## Chronologie à ne pas aplatir

- 2023-03 : sauvegarde bêta; restauration et purge annoncées comme futures.
- 2024-01 : restauration et périmètre limité à la base par défaut publiés.
- 2025-03 : plusieurs bases peuvent être sauvegardées.
- 2026-02 : réglages de rétention publiés.
- 2023-04 : cluster bêta, un manager et services stateless dans l’article. 2024-08 : dépréciation pour instabilité. L’option DNSRR 2026 ne démontre pas à elle seule le retour d’une offre multi-manager fiable.
- 2025-05 : compression globale ajoutée puis retirée cinq jours plus tard; ne pas cumuler des fonctions contradictoires dans une spécification.

Ces distinctions sont des faits publiés; le choix de formats d’instance, de candidats de restauration et d’un runtime standalone dans Harborlight reste une conception indépendante.
