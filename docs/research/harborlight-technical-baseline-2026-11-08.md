# Harborlight — référentiel technique du 8 novembre 2026

## Périmètre et statut des informations

Ce référentiel décrit le code original Harborlight au commit **`cb549fc`**, intitulé « feat: add signed GitHub deployments and immutable app releases ». Il constitue une base technique pour le dossier fonctionnel et technique, et non une certification de production. « Stable » désigne ici le jalon enregistré et vérifié du projet ; le produit reste en développement précoce. La parité complète avec Easypanel n’est pas acquise.

L’audit a confronté les sources serveur, les types partagés, les fichiers d’installation et les spécifications du dépôt. Les résultats d’exécution cités proviennent du registre `docs/VERIFICATION.md`, associé à ce jalon. Aucun conteneur ni nouveau test Docker n’a été lancé pour rédiger ce texte. Le terminal interactif présent dans l’arbre de travail est traité séparément : il n’appartient pas au commit de référence.

Harborlight est un panneau d’administration pour **un hôte Docker**, avec interface originale et licence Apache-2.0. Il administre des applications, des bases de données et un sous-ensemble de Docker Compose. Il n’installe pas Docker, ne modifie pas un cluster Swarm et ne fournit pas une plateforme distribuée à haute disponibilité.

## Architecture et responsabilités des modules

Le navigateur charge une application React et TypeScript construite avec Vite. En développement, Vite relaie les requêtes `/api` vers Fastify ; en production, Fastify sert également les fichiers de `dist/client`. Les types publics sont centralisés dans `shared/types.ts`. Les polices sont embarquées localement. Les changements de configuration sont enregistrés séparément de leur application au conteneur.

`server/index.ts` valide le mode et le port, crée l’application et organise l’arrêt sur `SIGINT` ou `SIGTERM`. `server/app.ts` assemble les routes, les contrôles d’origine, les dépendances, les tâches asynchrones et les vues filtrées. Sa fabrique `createApp` accepte un moteur injecté, permettant des tests déterministes sans appeler Docker.

La persistance appartient à `server/store.ts`. `access.ts` décide les droits à chaque requête ; `accounts.ts` gère comptes, sessions et clés personnelles. `validation.ts` et les schémas spécialisés Zod refusent les propriétés non prévues. `shared/environment.ts` définit l’import `.env` et la fusion des variables ; `project-environment.ts` fournit les routes associées.

`docker.ts` réalise les opérations d’infrastructure par processus Docker et Git avec tableaux d’arguments, sans exécuter une chaîne de commande fournie par l’utilisateur dans un shell de l’hôte. Les scripts nécessaires aux outils de bases de données s’exécutent dans des conteneurs contrôlés. `database-restore.ts` encapsule ces outils, la compatibilité des moteurs et la validation des archives. `restore-jobs.ts` orchestre restauration, sauvegarde de sécurité et reprise après interruption.

Les autres responsabilités sont isolées : `backup-schedules.ts` pour les échéances et la rétention ; `source-credentials.ts` pour l’authentification Git/registry ; `proxy-routing.ts`, `proxy-auth.ts` et `domain-ownership.ts` pour le routage ; `webhooks.ts` pour les déclencheurs Bearer ; `github-webhooks.ts` pour GitHub signé ; `releases.ts` et `release-config.ts` pour les versions immuables et les écarts de configuration. Le CLI `scripts/harborlight.mjs` utilise la même API, sans privilège supplémentaire.

## Modèle de données et invariants

Les ressources sont identifiées par UUID. Un projet possède un nom unique, une description et une couleur. Un service appartient à un projet et possède un type immuable : `app`, `postgres`, `mysql`, `mariadb`, `mongo`, `redis` ou `compose`. Il rassemble source, variables propres, domaines, volumes nommés, ports publiés, limites CPU/mémoire, notes et horodatages.

Une source décrit une image, un dépôt Git HTTPS, un Dockerfile intégré ou un document Compose intégré. Les noms publics utilisent des lettres minuscules, chiffres et tirets, avec une longueur maximale de 63 caractères. La configuration accepte au plus 20 domaines, volumes ou publications de ports par service. Les chemins et identifiants sont validés avant de parvenir au moteur ; un client ne peut pas imposer une correspondance interne de volumes restaurés.

Les utilisateurs ont un rôle global `owner`, `admin` ou `member`. Les membres reçoivent des appartenances aux projets avec rôle `viewer` ou `operator`. Le propriétaire ne peut pas être supprimé ou rétrogradé. Les clés API ajoutent un périmètre de projets, un niveau lecture/écriture et une expiration à l’autorité courante de leur émetteur.

Un déploiement conserve son déclencheur, ses dates, son résultat, sa sortie filtrée et éventuellement image, commit réel, commit GitHub demandé, release créée et origine d’un rollback. Une sauvegarde conserve fichier local, taille, empreinte SHA-256, manifeste, source, état et éventuel calendrier. Un travail de restauration relie sauvegarde source, service cible, demandeur, sauvegarde préalable, phase et journal.

Les objets privés complètent les représentations publiques : configuration réellement appliquée, variables de projet, profils des sauvegardes, secrets de sources, hashes de protection HTTP, snapshots des releases, journaux candidats et intentions de restauration. Ils restent dans l’état chiffré. Les réponses publiques ne sérialisent pas ces structures ni les correspondances physiques de volumes.

Les collisions sont vérifiées sur les configurations souhaitées, appliquées et les candidats de rollback encore réservés. Un nom de service ne doit pas détourner un alias réseau encore actif ; un port ne peut pas être réaffecté parce qu’une modification a seulement été sauvegardée. Les projets réservent également leurs espaces de noms de domaines.

## Persistance et comportement en cas de panne

L’état est un document JSON versionné, chargé en mémoire et chiffré en **AES-256-GCM** dans `state.enc`. `encryption.key` contient une clé locale de 32 octets. Le répertoire est restreint à son propriétaire, les fichiers sensibles utilisent des permissions restrictives. Cette protection limite l’exposition d’un fichier d’état isolé ; elle ne protège pas contre un administrateur disposant de l’état et de la clé.

Chaque sauvegarde d’état écrit un fichier temporaire, synchronise son contenu puis le renomme. Un verrou d’écrivain combine processus et identité de démarrage ; deux instances ne doivent pas partager le même répertoire. Il ne s’agit ni d’une base SQL ni d’un mécanisme de réplication.

Si l’écriture échoue, le serveur restaure sa dernière image mémoire enregistrée et bloque les mutations suivantes. Les déploiements dont l’achèvement n’a pas été durablement enregistré deviennent incertains : l’ancienne release n’est plus annoncée active. Il faut corriger le stockage, redémarrer et réconcilier le service. L’application ne transforme pas une panne Docker ou disque en succès simulé.

## Configuration, déploiement et versions applicatives

La configuration souhaitée reste distincte de la configuration appliquée. Les variables de service remplacent les valeurs du projet, y compris par une chaîne vide. Pour Compose, la priorité est : **service, puis enfant YAML, puis projet**. L’import `.env` est littéral, sans interpolation ou exécution ; il valide les doublons, refuse le multiligne et limite l’ensemble à 200 variables. `__proto__` et `constructor` sont réservés par l’API.

Un déploiement accepté renvoie HTTP 202 après enregistrement d’un travail `queued`. Il passe à `running`, puis `success` ou `failed`. Un verrou par service empêche déploiement, sauvegarde, restauration ou mutation de configuration concurrents ; des services différents peuvent travailler en parallèle. Les tâches actives utilisent des promesses du processus, et non une file distribuée relancée automatiquement après panne.

Le moteur récupère l’image ou construit le dépôt/Dockerfile. Git utilise HTTPS, une branche enregistrée et des chemins confinés au dépôt après résolution des liens. Le commit effectif est conservé, et les builds Git portent sa révision OCI. `forceRebuild` désactive le cache et demande de nouvelles images de base pour Git/Dockerfile ; une source image est récupérée pendant son déploiement.

Les préconditions, réseaux, volumes et conteneur candidat sont préparés avant le remplacement. Le moteur vérifie la propriété des ressources ; une erreur de récupération ou de création ne doit pas supprimer l’application précédente. Le remplacement d’un conteneur autonome peut toutefois interrompre le trafic. Un conteneur démarré n’est pas une preuve générale de disponibilité fonctionnelle.

Les releases concernent uniquement les applications à conteneur unique. Chaque succès conserve un identifiant d’image exact et une référence locale `harborlight-release/<service>:<release>`, avec snapshot immuable de configuration effective et de hashes proxy. Les identifiants Git/registry n’y sont pas copiés. Le journal public contient uniquement des métadonnées.

Le rollback exige une confirmation du nom exact, les droits opérateur, une image locale intacte et des volumes logiques compatibles. Il n’effectue aucun pull, build ou accès Git. Il réutilise les **volumes actuellement actifs**, applique l’ancienne configuration et crée une nouvelle entrée de filiation. Il ne restaure pas les données et n’annule pas une migration applicative. Les modifications souhaitées restent enregistrées ; `pendingChanges` compare configuration effective et protection proxy, sans inventer un écart pour un simple changement de commit à configuration identique.

Après interruption, les réservations du candidat et ses valeurs à masquer restent conservées. L’état `runtimeUncertain` interdit les opérations de données et les modifications qui libéreraient prématurément ces réservations. Un nouveau déploiement réussi remet l’état en cohérence. La récupération automatique de toutes les phases d’un déploiement ordinaire n’est pas implémentée.

## Sauvegardes, calendriers et restauration vérifiée

Les sauvegardes utilisent la configuration réellement déployée, pas des mots de passe ou montages seulement sauvegardés. Elles sont locales et contiennent un manifeste de format, moteur, version et volumes, une empreinte SHA-256 et un profil privé de configuration. Les fichiers de données ne sont pas chiffrés par le chiffrement de l’état du panneau.

| Cible | Format de sauvegarde | Compatibilité automatique |
|---|---|---|
| PostgreSQL | SQL natif `pg_dumpall` | Même version majeure |
| MySQL / MariaDB | SQL de l’instance avec objets associés | Même série majeure/mineure |
| MongoDB | Archive native compressée | Même version majeure |
| Redis | Archive contenant uniquement `dump.rdb` | Même version majeure |
| Volumes applicatifs | Archive par nom logique de volume | Noms et chemins identiques |

Les calendriers sont horaires, quotidiens ou hebdomadaires, exclusivement en UTC. Le processus les examine toutes les 15 secondes ; une ressource occupée est différée. Les occurrences manquées ne déclenchent pas une boucle de rattrapage. La rétention, de 1 à 100 copies, ne supprime que des sauvegardes réussies du calendrier et du service concernés. Les sauvegardes manuelles et étrangères à ce périmètre sont conservées.

La restauration produit exige un opérateur sur les projets source et cible, le nom exact du destinataire, une cible déployée et démarrée, un manifeste compatible et le profil privé correspondant. Les anciens fichiers dépourvus de métadonnées restent téléchargeables mais sont refusés pour cette opération automatique. L’API ne propose pas d’import d’archive externe arbitraire.

Le travail suit `queued → running → success/failed`, avec phases `validating`, `pre-backup`, `restoring`, `finished`. Le fichier est épinglé et son intégrité vérifiée. Une sauvegarde de sécurité du destinataire doit réussir avant l’import. Le moteur prépare ensuite de nouveaux volumes gérés et un candidat isolé utilisant l’image locale exacte de la cible. Les données actuelles restent disponibles pendant cette préparation.

Les outils natifs importent les données puis vérifient démarrage et authentification. Une restauration de base adopte les identifiants et paramètres gérés du profil source ; l’ancien mot de passe de destination n’est pas promis. PostgreSQL vérifie le secret du rôle dans le catalogue pour éviter qu’un accès local en mode `trust` valide à tort un mauvais mot de passe. Redis reconstruit sa persistance AOF après chargement du RDB. La restauration des volumes d’une application conserve son environnement.

Avant la bascule, le pilote transmet un checkpoint : identifiants exacts des anciens et nouveaux conteneurs, volumes candidats et paramètres restaurés. Le serveur enregistre durablement cette intention. Après redémarrage, il vérifie les identités et l’état réel pour adopter le candidat actif ou remettre l’ancien conteneur. Une situation ambiguë maintient un blocage ; le journal reste « interrompu », même lorsqu’une reprise sûre a été constatée.

Les volumes antérieurs et la sauvegarde préalable sont conservés. Les archives sont contrôlées en flux : chemins, traversées, tailles, checksums, doublons et types d’entrées. Liens, périphériques et extensions tar non prises en charge sont refusés. La copie de fichiers applicatifs vivants n’assure pas une cohérence transactionnelle : les écritures doivent être maîtrisées par l’exploitant.

## Contrat API principal

Toutes les routes métier commencent par `/api`. Les erreurs prennent la forme `{error: string}`. HTTP 400 signale une entrée invalide, 401 une authentification absente, 403 un droit insuffisant et 404 une ressource inexistante ou inaccessible depuis un autre projet. HTTP 409 indique un conflit ou une opération incompatible ; HTTP 202 signifie un travail accepté, jamais un succès déjà acquis.

| Groupe | Méthodes et parcours principaux |
|---|---|
| Initialisation et session | GET `health`, `auth/session` ; POST `auth/setup`, `auth/login`, `auth/logout` |
| Projets et services | GET/POST collections ; PATCH/DELETE ressources ; création de projet réservée aux administrateurs |
| Exécution | POST service `deploy`, `start`, `stop`, `restart` ; GET logs et historiques de déploiement |
| Variables | GET/PUT environnement de projet ; GET environnement hérité/propre/effectif d’un service |
| Données | POST sauvegarde et restauration ; GET inventaires, journal, téléchargement ; CRUD des calendriers et lancement manuel |
| Releases | GET historique et éligibilité ; POST `rollback` avec release et nom confirmé |
| Accès | CRUD utilisateurs, réinitialisation de mot de passe ; création/révocation de clés personnelles |
| Sources et domaines | GET statuts ; PUT/DELETE secrets Git/registry et protection HTTP de domaine |
| Automatisation | GET/rotation/révocation des déclencheurs ; POST public distinct pour Bearer ou GitHub HMAC |
| Pilotage | GET aperçu, métriques, activité, modèles ; installation de modèle ; GET/PATCH réglages |

La suppression d’un projet exige qu’il soit vide. La suppression d’un service retire sa configuration et son exécution gérée, conserve les volumes nommés et les sauvegardes, puis nettoie seulement ses références de releases. Installer un modèle crée une configuration ; le déploiement reste explicite. `health` constate que l’API répond, pas que Docker ou toutes les applications sont disponibles.

## Authentification, secrets et automatisation

Le premier compte propriétaire est créé une seule fois. Les mots de passe de nouveaux comptes comportent au moins 12 caractères et utilisent scrypt avec sel aléatoire. Setup et login sont limités à dix tentatives par minute. Le cookie de session est HttpOnly, SameSite strict, avec durée de sept jours et option Secure pour HTTPS. Le serveur conserve le hash du jeton ; les mutations contrôlent l’origine reçue et refusent les requêtes déclarées intersites.

Les droits sont vérifiés côté serveur, sur la route canonique et la ressource. Les listes sont filtrées par projet. Les inventaires omettent les valeurs d’environnement pour tous ; les viewers ne reçoivent pas non plus le code intégré, les notes, sorties de déploiement, logs ou téléchargements de sauvegarde. Les opérateurs accèdent délibérément aux secrets nécessaires à leurs services.

Les clés `hl_…` sont affichées une seule fois, stockées sous forme de hash et révocables. Leur expiration est de 90 jours par défaut, au maximum 365. Elles ne donnent pas accès à l’administration des comptes, réglages serveur, autres clés ou déclencheurs. Un changement de droits, d’email ou de mot de passe révoque les sessions, clés et déclencheurs du compte.

Git utilise un programme askpass temporaire, une configuration isolée, TLS vérifié et aucun suivi de redirection. Les credentials registry passent par stdin et une configuration Docker temporaire privée. Leur portée est un service et un dépôt exact. Les sorties masquent les valeurs connues de la configuration courante, appliquée et des candidats historiques ; ce filtrage n’est pas un système général de prévention des fuites de données.

GitHub possède son propre secret HMAC, conservé chiffré. Le serveur recalcule le HMAC des octets originaux, compare la signature en temps constant, puis contrôle dépôt GitHub.com, branche et SHA du push. Ping, suppression de branche et événements hors cible ne déploient pas. Les identifiants de livraison et empreintes du corps signé sont dédupliqués sur les 256 dernières acceptations. Reçu et travail sont enregistrés ensemble ; un conflit temporaire ne consomme pas la livraison. Modifier dépôt ou branche désactive le webhook jusqu’à rotation.

## Réseaux et publication

Les ressources utilisent des noms `hl-…` et des labels de propriété. Chaque projet possède un réseau ; les applications publiées rejoignent aussi `harborlight-proxy`. Les ports des bases restent internes sauf publication explicite. Le sous-ensemble Compose accepte des images et volumes nommés gérés ; builds, accès hôte, réseaux externes et labels arbitraires sont refusés.

Traefik fournit routage hôte/chemin, priorité aux hôtes exacts, retrait de préfixe, redirection HTTPS et authentification Basic bcrypt. Les frontières de chemin respectent les segments. Un wildcard couvre un seul niveau de sous-domaine ; le TLS wildcard est refusé avec le challenge HTTP fourni. Le domaine du panneau et les wildcards qui le couvriraient sont réservés.

La protection HTTP retire l’en-tête Authorization avant transmission à l’application. Ses hashes restent visibles aux administrateurs Docker dans les labels. Les domaines partagent un réseau proxy : une application peut joindre directement une autre application de ce réseau. Les permissions du panneau ne constituent pas une isolation contre des opérateurs ou locataires hostiles.

## Installation, exploitation et récupération

Le développement requiert Node.js 22.13 ou supérieur, npm et Docker avec Compose/Buildx pour les opérations réelles. L’image de production utilise Node 24 Alpine, Git, certificats, tini et Docker CLI. `npm ci` puis `npm run dev` démarrent l’environnement local. `HARBORLIGHT_MODE=demo` sélectionne explicitement les simulations ; son répertoire doit être séparé des données réelles.

Sur serveur, `scripts/install.sh` vérifie Docker, initialise `.env` et construit le panneau. Compose publie son port sur `127.0.0.1` seulement. L’exploitant crée le propriétaire via localhost ou tunnel SSH, puis configure DNS, `ACME_EMAIL`, le profil proxy et, pour publier le panneau, `PANEL_DOMAIN`, `PUBLIC_URL` et les cookies Secure via l’override public.

Le volume `harborlight-data` contient état, clé, espaces de travail et sauvegardes locales ; les données applicatives résident dans d’autres volumes. Une sauvegarde administrative doit copier le volume complet **panneau arrêté**, avec sa clé, puis protéger indépendamment les volumes des services. Une copie de `state.enc` seule est insuffisante. Les sauvegardes doivent également quitter l’hôte : un fichier local ne couvre pas sa perte.

`docker compose down` arrête le panneau et son proxy, pas les conteneurs applicatifs déployés séparément. `down --volumes` peut détruire données du panneau et certificats. Les anciens volumes conservés après restauration, images de releases et candidats orphelins consomment de l’espace ; aucun nettoyage global Docker aveugle n’est prévu.

## Preuves, limites et terminal en développement

Le registre du commit consigne 105 tests API/état et 15 parcours Chromium de démonstration, ainsi que des vérifications réelles distinctes : déploiement, proxy, registry privée, Git, héritage d’environnement, GitHub signé, rollback, restauration PostgreSQL/Redis/volumes, reprise SIGKILL, navigateur et image empaquetée. Ces preuves ont des périmètres différents ; la réussite en mode démo ne démontre pas une opération Docker.

Au jalon `cb549fc`, MySQL, MariaDB et MongoDB sont implémentés mais leurs restaurations réelles ne sont pas déclarées vérifiées. ACME sur domaine réel, livraison depuis GitHub public, Git privé hébergé et CI distante restent non prouvés. Il manque notamment stockage hors site intégré, Swarm, rolling deployments, OAuth/GitHub App, SSH deploy keys, bases privées de builds et rétention automatique des releases. Les métriques combinent CPU Docker et mesures mémoire/disque de l’environnement du panneau ; elles ne décrivent pas nécessairement tout l’hôte distant.

Le chantier terminal ajoute `terminals.ts`, `container-terminal.ts` et une UI xterm. Son contrat prévoit cookie opérateur, Origin exact obligatoire, WebSocket sans jeton dans l’URL, sélection logique d’un conteneur géré, shell `sh`/`bash`, messages bornés, limites de sessions et fermeture avant mutation ou révocation. Neuf tests supplémentaires avec runtime injecté ont passé, portant la suite de travail à 114 ; ils ne valident pas le PTY Docker réel. La validation réelle, le journal durable des sessions et leur nettoyage au redémarrage restent à terminer. Ce terminal ne doit donc pas être présenté comme une fonctionnalité stable ou livrée.

## Sources internes utilisées

Référence : `git show cb549fc:<chemin>` pour les fichiers modifiés depuis le jalon, et lecture des modules inchangés. Principales sources : `shared/types.ts`, `server/app.ts`, `store.ts`, `access.ts`, `accounts.ts`, `validation.ts`, `docker.ts`, `database-restore.ts`, `restore-jobs.ts`, `backup-schedules.ts`, `releases.ts`, `github-webhooks.ts`, modules environnement/credentials/proxy ; `API-CONTRACT.md`, `SECURITY.md`, `README.md`, `Dockerfile`, `compose.yaml`, `compose.public.yaml`, `scripts/install.sh`, `docs/VERIFICATION.md` et `docs/specs/09` à `13`. Les preuves du terminal proviennent uniquement de la suite locale injectée de l’arbre de travail.
