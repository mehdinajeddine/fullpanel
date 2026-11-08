# Migration depuis Easypanel, Portainer et autres plateformes

État au 2026-11-08 : **fonctionnalité future demandée, aucune implémentation ni migration réelle validée**. À réaliser après le lot fonctionnel en cours. Identifiant de feuille de route : M01. Cette spécification complète la matrice vivante ; elle ne modifie pas le DOCX approuvé ni son corpus historique de 91 critères.

## Objectif et limites

Un assistant inventorie une plateforme source autorisée, explique ce qu'il peut transférer, prépare un plan vérifiable et recrée les applications et leurs données dans FullPanel. La source reste exploitable jusqu'à une bascule explicitement décidée. La découverte, le plan, la copie de données et la bascule sont des phases distinctes ; aucune connexion à une source ne vaut autorisation de l'arrêter ou de changer son DNS.

Les premiers adaptateurs visés sont Easypanel et Portainer. Le contrat d'adaptateur permettra d'en ajouter d'autres sans modifier le moteur de planification. La présence d'une API, d'un fichier Compose ou d'une sauvegarde n'établit pas une compatibilité automatique. Un service Swarm, un objet Kubernetes, WordPress/Box géré, une extension Compose ou un réseau non pris en charge ne doit jamais être converti silencieusement en conteneur autonome.

## Capacités publiées et conséquences

Sources primaires consultées le 2026-11-08. Ces faits servent à concevoir les adaptateurs ; aucune API source authentifiée n'a été interrogée dans cette recherche.

| Source | Fait publié | Conséquence pour l'adaptateur futur |
| --- | --- | --- |
| [Easypanel — index API](https://easypanel.io/docs/api/endpoints) | Des lectures de projets/services, domaines, montages, ports et sauvegardes sont documentées, séparément des actions de mutation. | Détecter la version et les capacités effectives ; utiliser une liste explicite d'opérations de lecture pour l'inventaire. Aucun contrat universel d'export portable n'est établi par cet index. |
| [Easypanel — sauvegardes de bases](https://easypanel.io/docs/backups/database) | Les outils et formats sont propres aux moteurs ; PostgreSQL utilise notamment un format personnalisé de pg_dump compressé, et Redis nécessite un traitement distinct. | Identifier format/compression/moteur par inspection contrôlée, pas seulement par extension. Le format PostgreSQL ne correspond pas au SQL pg_dumpall des sauvegardes natives FullPanel : un importeur explicite et testé est nécessaire. |
| [Easypanel — sauvegardes de volumes](https://easypanel.io/docs/backups/volumes) | La sauvegarde documentée synchronise un miroir ; elle n'est pas une archive horodatée. Les montages Bind/File sont exclus de ce parcours. | Épingler la copie et sa provenance ; distinguer volume, miroir, montage hôte et fichier. Ne pas traiter un miroir vivant comme un instantané cohérent ou une archive FullPanel. |
| [Portainer — périmètre des sauvegardes](https://docs.portainer.io/faqs/getting-started/what-does-portainers-backup-include) | La sauvegarde contient la configuration Portainer et ses fichiers de stacks, mais pas les conteneurs, images, volumes ni leurs données. | Inventorier et transférer les données séparément. Ne pas afficher « migration complète » à partir du seul backup Portainer. |
| [Portainer — API](https://docs.portainer.io/api/docs) et [exemples](https://docs.portainer.io/api/examples) | L'API authentifiée expose la gestion Portainer et une passerelle vers l'API Docker/Kubernetes des environnements. La documentation distingue éditions et versions. | Vérifier édition/version/droits et limiter chaque lecture à l'environnement sélectionné. Ne pas transmettre un appel Docker arbitraire fourni par le client. |
| [Portainer — référence officielle des stacks](https://github.com/portainer/portainer-skills/blob/main/portainer-api/references/stacks.md) | La référence décrit la lecture des stacks, d'une stack et de son fichier déployé ; les environnements standalone, Swarm et Kubernetes ont des parcours distincts. | Associer la définition, l'environnement et les paramètres à leurs identifiants source stables ; marquer la plateforme avant toute conversion. Vérifier les routes avec le schéma API de la version cible. |
| [Portainer — création de stacks](https://docs.portainer.io/user/docker/stacks/add) | Les stacks peuvent provenir d'un éditeur, d'un fichier, de Git ou d'un template ; les variables peuvent être conservées séparément du fichier Compose. | Inventorier ensemble définition et variables, provenance Git et ressources effectives. Un fichier Compose isolé peut être incomplet. |

FullPanel n'importe actuellement ni ces sauvegardes externes ni une base interne Portainer/Easypanel. Les archives sources ne sont jamais exécutées ou désérialisées en objets applicatifs arbitraires. Un champ masqué, inaccessible ou absent devient une dépendance à fournir ; aucune supposition sur la récupération de mots de passe ou de clés privées.

## Parcours et autorisations

1. **Connecter** : un administrateur choisit la plateforme, l'URL explicite, l'environnement et un identifiant d'accès dédié. Vérifier TLS ou une empreinte SSH explicite ; aucune désactivation silencieuse de vérification ni redirection avec transmission d'identifiants. Les secrets restent chiffrés dans l'état privé, révocables et absents des URLs, journaux et exports de plan.
2. **Inventorier en lecture seule** : collecter les ressources autorisées, leurs liens et leurs limites, avec version source, horodatage et identifiants. L'adaptateur n'appelle que ses opérations de lecture approuvées. Il ne lance aucun backup, exec, déploiement, arrêt, suppression, changement Swarm ni modification DNS à cette étape.
3. **Construire le plan / dry run** : sélectionner les services, résoudre leurs dépendances et présenter chaque correspondance, conflit et action proposée. Le plan n'alloue aucune ressource d'exécution cible. Il distingue « compatible », « adaptation nécessaire », « information manquante » et « non pris en charge » ; toute donnée non copiée est visible.
4. **Préparer la destination** : après validation du plan, réserver les noms et créer uniquement les ressources cibles approuvées, avec labels d'appartenance et journal durable. Conserver les routes de production inactives. Vérifier espace pour copie, restauration et retour arrière avant les transferts.
5. **Copier et restaurer en isolation** : acquérir une copie stable avec SHA-256, taille et format enregistrés. Une création de backup ou suspension d'écritures sur la source est une action distincte explicitement autorisée ; ce n'est plus la découverte en lecture seule. Restaurer dans de nouveaux volumes/services candidats, jamais dans les volumes source ou dans une destination existante sans son parcours de sauvegarde et confirmation.
6. **Valider** : contrôler données, comptes, montages, permissions, connexions internes et requêtes applicatives. Afficher les tests réellement exécutés et les tests manquants ; un conteneur démarré ne suffit pas. Utiliser une URL de validation isolée, sans prendre la route de production à la source.
7. **Basculer explicitement** : afficher les DNS/proxy/ports concernés, le gel des écritures et la dernière synchronisation nécessaires, le plan de retour et l'interruption attendue. Une confirmation dédiée déclenche uniquement les modifications listées. Si le fournisseur DNS n'est pas pris en charge, donner les changements exacts à effectuer puis vérifier leur résultat ; ne pas prétendre une automatisation inexistante.
8. **Observer puis clôturer** : vérifier le trafic et les écritures sur la destination, garder la source et ses sauvegardes pendant une durée choisie, puis clôturer le journal. La migration ne supprime jamais automatiquement la source ; son retrait ultérieur reste une opération séparée.

Les droits FullPanel doivent couvrir toutes les destinations choisies. Les capacités source sont limitées au périmètre autorisé par son fournisseur ; si un jeton source est plus large, l'adaptateur applique quand même une liste d'environnements/projets permise. Une révocation avant une nouvelle phase empêche celle-ci de démarrer. Les phases de restauration/bascule utilisent les verrous de service existants et sont incompatibles avec un déploiement ou une sauvegarde concurrente du même service.

## Modèle d'inventaire et correspondances

Chaque objet porte sa plateforme/version, l'instance et l'environnement source, son ID stable, l'heure de lecture, une empreinte de configuration et les preuves disponibles. L'inventaire public ne contient que des références opaques aux secrets. Le plan associe un objet source à un ID FullPanel réservé, une stratégie de transfert et une liste de prérequis. La réexécution d'une même révision du plan retrouve cette association ; elle ne crée pas une seconde application.

| Domaine | Informations et décisions requises |
| --- | --- |
| Services et sources | Type réel, image/digest/architecture, Git/révision/contexte, commande, ressources, état désiré et effectif. Reconstruire une image n'est pas identique à transférer l'image exécutée ; préciser le choix et les restrictions de registre. |
| Compose | Fichier, variables externes, fichiers référencés, secrets/configs, dépendances et noms des enfants. Vérifier le sous-ensemble FullPanel avant import ; jamais supprimer silencieusement une clé non prise en charge. |
| Environnement et secrets | Valeurs partagées, valeurs de service et précédence réelle. Secrets récupérables légalement, masqués ou manquants sont distingués. Ne pas réutiliser automatiquement des accès utilisateurs, jetons de plateforme ou clés de déploiement source. |
| Domaines et TLS | Hôte, chemin, port cible, primaire, middleware et certificat constaté. Les annotations Traefik ne deviennent pas des règles arbitraires ; mapper uniquement les fonctions validées. Prévoir de nouvelles émissions de certificats, sans présumer la réutilisation des clés ACME source. |
| Stockage | Chaque montage nommé, anonyme, Bind ou File, destination, capacité, UID/GID/modes, liens et exigences de cohérence. Volumes anonymes ou chemins hôte non accessibles bloquent le plan tant qu'une stratégie explicite manque. Les archives suivent les contrôles de traversée/liens et les limites de taille/ressources. |
| Bases de données | Moteur/version/extensions/collation, base(s), rôles, format/compression, authentification et volumes réels. Refuser les changements majeurs non validés, les données incohérentes et les profils incomplets ; ne pas confondre dump mono-base et sauvegarde de toutes les bases/comptes. |
| Réseaux et ports | Réseaux, alias, dépendances, protocoles et expositions. Remapper les connexions internes avec vérification effective ; refuser les collisions de ports et les fonctionnalités Swarm/Kubernetes incompatibles. |
| Tâches et accès | Sauvegardes, scripts, cron/timezone, webhooks, permissions et notifications : mapper explicitement les fonctions existantes ou les signaler non migrées. Ne pas activer deux ordonnanceurs ou deux chaînes de déploiement par défaut. |

## Reprise, échecs et retour arrière

Le journal suit découverte, plan, préparation, transfert, restauration, validation, attente de bascule, bascule, observation et clôture. Chaque étape enregistre son intention avant une mutation et son résultat après vérification : ressources exactes, empreintes, checkpoints et erreur masquée. Après interruption, réconcilier l'état réel avant de reprendre ; une étape ambigüe bloque au lieu de répéter aveuglément une mutation.

Revalider le plan si la configuration source ou cible a changé. Une annulation ferme les transferts et conserve les preuves et sauvegardes requises. Le nettoyage ne vise que les ressources exactes créées par ce job et jamais une ressource source, préexistante ou utilisée par un autre job.

Avant l'ouverture des écritures sur la destination, le retour peut rétablir l'ancien routage vers la source conservée, après vérification. Après de nouvelles écritures sur la destination, revenir à l'ancienne source risque de perdre ces changements : exiger un plan de réconciliation ou une acceptation explicite de ce risque. Ne jamais présenter le changement DNS comme une transaction atomique ou garantir l'absence d'interruption. Empêcher deux copies écrivaines concurrentes pour les services qui ne le permettent pas.

## Acceptation du futur lot

| Test | Résultat attendu |
| --- | --- |
| M01-01 — découverte | Deux fixtures officielles versionnées Easypanel/Portainer : inventaire correct ; trace d'appels prouvant l'absence de mutation source ; refus des objets hors périmètre. |
| M01-02 — plan | Source app + base + fichiers + Compose : dépendances/mappings explicites ; secrets absents de l'export ; conflits et fonctions incompatibles bloquants ; aucun objet runtime créé par le dry run. |
| M01-03 — formats | Backup Portainer sans données identifié comme incomplet ; dump Easypanel PostgreSQL personnalisé détecté ; format inconnu, archive piégée et mismatch moteur refusés sans toucher la source ni la cible existante. |
| M01-04 — données | Migration réelle d'app/base/fichiers dans de nouveaux volumes ; comparaison de lignes/documents/fichiers, UID/GID/modes, mots de passe et lecture/écriture applicative ; validation avant routage public. |
| M01-05 — secrets | Identifiants source chiffrés, masqués et révocables ; aucune fuite dans erreurs, journal, plan ou contexte de build ; host/TLS différent et redirection non autorisée refusés. |
| M01-06 — reprise | Interruption réelle à chaque frontière critique puis redémarrage : reprise/réconciliation sans doublons, sans perte de mapping ni suppression de ressource étrangère ; source inchangée hors actions explicitement choisies. |
| M01-07 — dérive et concurrence | Changement de source après plan, collision de domaine/port, permissions révoquées, destination occupée et manque d'espace : blocage utile avant mutation dangereuse. |
| M01-08 — bascule | Confirmation distincte, dernière copie cohérente, routage exact et contrôle HTTP/TLS ; aucune source supprimée. Tester retour avant écritures nouvelles et refus d'un retour aveugle après écritures. |
| M01-09 — nettoyage | Succès, annulation et erreur : seules les ressources temporaires du job sont supprimées ; sauvegardes de sécurité conservées selon politique explicite, source et ressources tierces intactes. |

Ces tests constituent des critères à réaliser, pas des résultats obtenus. Le premier lot devra annoncer une matrice explicite de versions, types de services et formats réellement éprouvés ; les autres adaptateurs et types restent hors support jusqu'à leurs propres preuves.
