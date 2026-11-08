# Domaines communautaires FullPanel

État du broker DNS : **planifié, non implémenté et non vérifié**. Une application Heroku destinée au site et à l’API a été créée ; aucun code ni dyno n’y est encore déployé. Feuille de route **M04**. Spécification demandée pour la communauté ; elle ne modifie pas le DOCX de référence ni les preuves actuelles de R07/R08.

Décision utilisateur : **conserver le DNS chez GoDaddy et appeler son API uniquement depuis le backend central**. Aucune migration Route53 n'est prévue par défaut. Le jalon ports, interface et SSH a été livré sur AWS ; les identifiants de l'API GoDaddy ne sont pas configurés pour le broker.

## Objectif et périmètre

`fullpanel.dev`, déclaré acheté chez GoDaddy par le propriétaire du projet, doit servir plusieurs installations indépendantes de FullPanel. Le serveur AWS actuellement utilisé est une installation parmi d'autres ; il n'est ni l'identité du domaine communautaire ni la destination de tous ses sous-domaines. L'achat déclaré n'établit pas ici les nameservers actifs, l'accès API ou la configuration DNS effective.

Chaque installation reçoit un identifiant public aléatoire et durable, par exemple `s-k7m4q2` (exemple abrégé), puis des noms comme `panel.<id>.fullpanel.dev` et `app-projet.<id>.fullpanel.dev`. L'identifiant n'est pas un secret. En production, prévoir au moins 96 bits aléatoires, un alphabet DNS sûr et une contrainte d'unicité atomique ; aucun identifiant attribué ne sera réaffecté.

Un **jeton secret distinct** autorise les opérations du serveur auprès d'un service central, appelé ici broker DNS. Il n'apparaît jamais dans le domaine, une URL, un QR public ou les journaux. Les installations ne reçoivent jamais les identifiants GoDaddy. Le broker ne transporte pas le trafic des applications et ne reçoit ni identifiants administrateur FullPanel ni clés privées TLS des installations.

L'adhésion est facultative. Les domaines personnels configurés directement restent utilisables sans compte communautaire, y compris quand le broker est arrêté. Aucun remplacement silencieux des domaines actuels, du `baseDomain` ou des routes sslip.io : l'administrateur examine et active le changement.

## Architecture proposée

| Composant | Responsabilité et frontière |
| --- | --- |
| FullPanel local | Choix explicite de l'administrateur, jeton chiffré localement, preuve de contrôle, routes locales, certificats et état visible. |
| API centrale | Inscription, autorisation par installation, quotas, défis, demandes DNS, rotation/révocation et audit. Aucune API DNS arbitraire. |
| Worker central | Vérifications réseau bornées et écritures fournisseur depuis une file durable ; reprise idempotente. |
| PostgreSQL central | Identités, empreintes de jetons, états désirés/appliqués, défis consommés, opérations, réservations définitives et audit. |
| DNS autoritatif | Enregistrements persistants pointant chaque sous-zone vers son IP vérifiée ; réponses indépendantes du broker. |
| Proxy de chaque serveur | Routage exact des noms approuvés, refus des noms inconnus, TLS et protection du panel/applications. |

Le propriétaire a autorisé une application Heroku avec **un seul dyno Basic à 7 USD/mois** pour héberger le site `fullpanel.io` et l’API. L’application `fullpanel-web-api` a été créée en région Europe, stack `heroku-24`, avec `fullpanel.io` et `www.fullpanel.io` déclarés. Aucun code, dyno, add-on, certificat validé ni DNS GoDaddy n’a encore été déployé/configuré. La formation est vide : Heroku refuse de sélectionner le type `web=basic` tant qu’un premier déploiement ne définit pas ce processus. Le plafond autorisé ne couvre pas un worker ou une base payante supplémentaire.

Le système de fichiers éphémère des dynos exclut un fichier local comme registre durable. Le stockage PostgreSQL, l’identité des utilisateurs et les fonctions du broker restent à implémenter et à financer séparément si nécessaire. Cette création d’application n’est pas une livraison du service DNS. [Heroku, stockage des dynos](https://devcenter.heroku.com/articles/dynos#ephemeral-filesystem).

Pour le site, la cible CNAME de `www.fullpanel.io` est `vast-nodosaurus-g93nns0pavpq2ptv1w3nh6mj.herokudns.com`. [GoDaddy ne permet pas un CNAME de nom `@`](https://www.godaddy.com/help/add-a-cname-record-19236) : la configuration envisagée conserve `www` comme URL canonique avec [redirection de l’apex](https://www.godaddy.com/help/forward-my-godaddy-domain-12123), à vérifier avec HTTPS après déploiement. Ne pas remplacer cette configuration par un A vers une IP Heroku résolue ponctuellement ; voir les [exigences de domaine Heroku](https://devcenter.heroku.com/articles/custom-domains). Ce raccordement du site ne modifie pas la délégation ni les sous-domaines communautaires de `fullpanel.dev`.

## Inscription et preuve de contrôle

1. Un propriétaire ou administrateur local choisit le service communautaire et une IPv4 publique canonique. La première version accepte uniquement IPv4 ; IPv6 exige une preuve et des filtres propres avant activation. L'adresse source d'une requête sortante ou un en-tête forwarded n'est pas une preuve de l'adresse d'hébergement.
2. Le broker rattache une réservation à une identité de récupération authentifiée. Le mécanisme de compte/invitation et sa vérification restent à choisir avant implémentation. Une réservation expire sans publier de DNS ; elle ne peut occuper indéfiniment des quotas.
3. Un défi à usage unique lie réservation, identifiant, IP littérale, nonce aléatoire et expiration courte. Le nonce est un défi temporaire, jamais le jeton d'administration DNS. FullPanel expose la réponse attendue uniquement au chemin fixe `/.well-known/fullpanel-domain-proof`, pendant cette procédure.
4. Le worker contacte directement l'IP demandée sur le port 80, avec un Host construit par le broker ; il n'accepte ni URL, chemin, port ni en-tête choisis librement par le demandeur. Réponse exacte, taille et délais bornés, aucune redirection. Un défi obtenu pour une autre IP, installation ou réservation ne convient pas.
5. Après preuve et transaction d'activation, le broker délivre une fois le jeton aléatoire, via HTTPS ; l'installation le stocke chiffré. Seule son empreinte est conservée côté broker. Les écritures DNS sont journalisées puis relues ; l'UI distingue validation, propagation DNS et certificat prêt.
6. Une modification d'IP exige le jeton actuel et une nouvelle preuve sur la destination. L'ancienne IP reste appliquée tant que la demande n'est pas validée ; aucun tiers ne peut revendiquer une identité simplement parce qu'il détient son ancienne adresse.

La preuve établit un contrôle du point HTTP à un instant donné, pas une propriété exclusive ou permanente de l'IP. NAT, proxy tiers, IP réattribuée et pare-feu peuvent rendre le parcours impossible ou insuffisant. Le renouvellement de cette preuve, distinct d'un heartbeat authentifié, doit être périodique et visible.

## Vérifications réseau sans SSRF

- Rejeter les IP privées, loopback, link-local, CGNAT, multicast, réservées, de documentation et les destinations de métadonnées cloud. Normaliser avant comparaison ; refuser variantes numériques, zones IPv6, IPv4 encapsulée et formats ambigus non pris en charge.
- Connecter le socket à l'IP publique validée, sans résolution DNS fournie par le client, sans proxy d'environnement et sans redirects. Vérifier la destination réellement utilisée ; un nom d'hôte contrôlé par le demandeur ne doit pas réintroduire un rebinding.
- Appliquer également un filtrage réseau sortant indépendant au worker, des délais connexion/lecture/globaux, une petite limite de corps et de concurrence. Les réponses sont comparées au défi attendu, jamais interprétées comme commande, URL ou configuration.
- Toute future vérification par hostname devra valider l'ensemble des A/AAAA, épingler l'adresse jusqu'à la connexion et refuser les réponses mixtes publiques/privées. Les diagnostics DNS passent par un résolveur configuré, jamais un serveur DNS arbitraire fourni par l'utilisateur.
- Les erreurs publiques restent génériques ; aucun corps de réponse distant, secret, header Authorization ou contenu de métadonnées ne rejoint les journaux. Les tests doivent prouver qu'aucune connexion interdite n'a été tentée, pas seulement que le résultat final est refusé.

## Portée DNS et autorisation

Le broker construit les noms depuis l'identité authentifiée. Le client ne transmet ni zone, nom DNS complet, type arbitraire, nameserver ni valeur CNAME. Le premier lot gère seulement un enregistrement A pour `*.<id>.fullpanel.dev`, et éventuellement l'A exact de `panel.<id>.fullpanel.dev`, vers l'IPv4 vérifiée. Pas de wildcard global `*.fullpanel.dev` vers une instance. Le nom `<id>.fullpanel.dev` lui-même n'est pas créé implicitement.

Le wildcard DNS facilite l'adressage des applications ; il n'autorise ni route proxy générique ni certificat wildcard. Les routes locales doivent rester des hosts exacts à un seul label applicatif, avec refus des noms inconnus. Réserver `panel` et les labels d'administration ; valider longueur, alphabet, collisions et noms trompeurs. Les changements de nom d'application ne réaffectent pas automatiquement une ancienne URL à un autre service.

Les identifiants publics ont leur propre espace `s-…` ; les noms centraux (`www`, `api`, `domains`, `status`, `auth`, `support`, `mail`, etc.) sont réservés. Les opérations d'une installation ne peuvent modifier ni un frère, ni l'apex, ni les enregistrements MX/NS/SOA/CAA/TXT du domaine. Le connecteur doit modifier uniquement son RRset exact, sans remplacer la zone complète ni écraser les valeurs étrangères.

Le jeton comporte au moins 256 bits aléatoires. Transport exclusivement `Authorization: Bearer` sur HTTPS vérifié, empreinte SHA-256 ou HMAC versionnée, comparaison constante et métadonnées de rotation sans secret. Rotation/revoke invalidant les requêtes et workers en attente à leur prochaine frontière d'autorisation ; un compteur de génération empêche l'application d'un ancien travail. Une rotation interrompt le jeton précédent ; la reprise après réponse perdue passe par l'identité de récupération, pas par l'identifiant public seul.

La révocation du jeton interdit toute nouvelle mutation ; elle ne doit pas supprimer silencieusement les DNS existants. Retrait DNS et suspension pour abus sont des opérations distinctes, authentifiées et auditées. Les autorisations sont revérifiées après les opérations asynchrones et avant chaque écriture fournisseur.

## API et données à réaliser

Contrat indicatif du broker, distinct de l'API locale actuelle ; toutes les mutations utilisent validation stricte, limites de corps, contrôle d'accès et clé d'idempotence sans secret.

| Opération proposée | Résultat attendu |
| --- | --- |
| `POST /v1/registrations` | Réservation bornée et défi ; aucune publication DNS ni secret GoDaddy. |
| `POST /v1/registrations/:id/verify` | Vérification par worker et activation unique ; jeton remis une fois via canal authentifié. |
| `GET /v1/servers/self` | État propre, IP désirée/appliquée, générations, dates, quotas et opérations ; aucun token brut. |
| `POST /v1/servers/self/address-changes` | Défi pour une nouvelle IP ; ancienne destination inchangée avant validation. |
| `POST /v1/servers/self/token/rotate` | Nouveau secret remis une fois ; ancien immédiatement inutilisable. |
| `POST /v1/servers/self/token/revoke` | Mutations interdites, DNS maintenu selon politique explicitée. |
| `POST /v1/servers/self/renew` | Renouvellement authentifié du bail ; ne remplace pas une preuve réseau expirée. |
| `DELETE /v1/servers/self/dns` | Retrait explicite et journalisé des seuls RRsets possédés ; identifiant jamais libéré. |

Tables minimales : propriétaires, installations, credentials (empreinte/génération/révocation), défis (IP/expiration/consommation), opérations (état/retry/clé d'idempotence), RRsets possédés et tombstones. Transactions, verrous par installation et contraintes uniques couvrent inscription concurrente, rotation et reprise worker. Le succès de l'API fournisseur, la lecture DNS et la disponibilité HTTPS sont trois preuves distinctes ; aucune ne doit être inventée depuis l'autre.

## HTTPS et isolation entre locataires

Chaque serveur conserve ses propres clés TLS. Émettre des certificats pour les **hosts exacts** via HTTP-01, puis vérifier chaîne de confiance, hostname, dates et renouvellement. Le challenge nécessite le port 80 ; il ne permet pas les certificats wildcard. Aucune clé TLS wildcard commune n'est distribuée. Les routes de challenge sont minimales et ne contournent pas l'authentification du contenu applicatif. [Let’s Encrypt, challenges](https://letsencrypt.org/docs/challenge-types/).

`.dev` est préchargé HSTS : un navigateur exige HTTPS avant d'afficher le site. Afficher « Certificat en attente » avec accès local/de secours existant ; ne pas promettre un lien HTTP de secours sous `fullpanel.dev`. La vérification HTTP du broker et HTTP-01 restent des flux techniques distincts du navigateur. [Google Registry, .dev](https://www.registry.google/domains/dev/).

Sans décision PSL effectivement déployée dans les clients, les installations partagent le domaine enregistrable `fullpanel.dev`. Un locataire peut tenter des cookies `Domain=fullpanel.dev` ; des applications sous une même installation peuvent aussi viser `Domain=<id>.fullpanel.dev`. HTTPS et un identifiant aléatoire ne corrigent pas ce risque, et SameSite ne suffit pas à isoler des origines appartenant au même site.

Imposer aux sessions du panel et du broker des cookies host-only préfixés `__Host-`, Secure, HttpOnly et Path=/, sans attribut Domain ; contrôler strictement Origin/CSRF et CORS, refuser les variantes de cookie ambiguës, ne pas partager de session entre hôtes et ne pas utiliser `document.domain`. Tester un locataire malveillant et une application voisine, y compris sur navigateurs mobiles. Ces protections ciblées ne constituent pas une garantie générale d'isolation des applications arbitraires.

Évaluer une inscription dans la section privée de la PSL, avec une frontière distinguant les installations **et** les hosts applicatifs/panel ; documenter les effets d'une entrée simple ou wildcard, les exigences du projet PSL et la propagation aux navigateurs. Aucune inscription ni acceptation n'est présumée. Une URL d'administration sur un domaine enregistrable séparé reste une option si l'isolation requise ne peut être établie. La PSL explique son rôle dans les frontières de cookies ; elle ne doit pas être demandée seulement pour contourner un quota fournisseur. [Public Suffix List](https://publicsuffix.org/learn/).

## Quotas, abus et certificats partagés au niveau du domaine

Définir avant ouverture les limites par compte, IP et installation : réservations, vérifications réseau, changements d'IP, opérations DNS, hosts déclarés et nouvelles émissions. Réponses 429 et Retry-After, file bornée, retries exponentiels avec jitter et budget global fournisseur ; une panne ne déclenche jamais une boucle d'inscription ou de certificats. Les valeurs restent à dimensionner, pas des garanties implicites d'illimité.

Au 2026-11-08, Let’s Encrypt documente **50 nouveaux certificats par domaine enregistrable sur 7 jours, tous comptes confondus**. Des comptes ACME séparés ne suppriment donc pas le budget commun de `fullpanel.dev` dans la situation PSL actuelle supposée. Utiliser staging pour la recette, préserver état ACME et clés lors des redémarrages, coordonner les demandes et examiner un override avant montée en charge ; vérifier les règles applicables à la date de livraison. [Limites Let’s Encrypt](https://letsencrypt.org/docs/rate-limits/).

Un opérateur contrôlant une destination wildcard peut effectuer ses propres demandes HTTP-01 hors broker. Un compteur central de hosts/certificats n'est donc pas une limite imposable à lui seul. Avant ouverture non supervisée, choisir et tester un modèle de maîtrise des abus et d'émission : admission progressive, capacité accordée par l'AC, ou émission coordonnée sur CSR avec clé privée restant locale et restrictions CA réellement vérifiées. Aucune solution CAA/PSL n'est présumée suffisante sans analyse et recette.

Prévoir signalement, contact responsable, suspension motivée, procédure de contestation et audit restreint. Le broker peut retirer une sous-zone abusive sans toucher les autres ; il ne doit pas prétendre révoquer ainsi des certificats déjà émis ou effacer les caches DNS. Les noms et certificats sont publics : aucun secret ni nom métier confidentiel dans les hostnames ; expliciter la visibilité Certificate Transparency.

## Baux, panne et prévention de la reprise hostile

Conserver séparément `lastAuthenticatedAt`, `proofVerifiedAt`, `leaseExpiresAt`, période de grâce et état DNS. Une absence de trafic, une absence de métriques ou un timeout de vérification n'est pas une preuve d'abandon. La durée du bail, les alertes et la grâce restent à définir ; aucun nettoyage fondé uniquement sur « pas d'activité ».

À l'expiration confirmée après avertissements et grâce, une politique publiée peut retirer les RRsets possédés pour éviter de continuer à viser une IP réattribuée. L'identifiant et ses anciens noms demeurent réservés définitivement. La réactivation exige la même autorité de récupération et une nouvelle preuve ; ni la nouvelle possession de l'IP ni l'expiration DNS n'autorisent une réattribution du nom. La récupération d'un compte compromis relève d'une procédure dédiée.

Si le broker, PostgreSQL ou l'API fournisseur est indisponible, les DNS déjà autoritatifs continuent d'être servis et le trafic reste direct. Geler les expirations automatiques pendant une panne centrale connue ; reprendre avec alertes et délai de grâce, pas avec une vague de suppressions. Les renouvellements TLS peuvent néanmoins échouer si leur échéance ou dépendance ACME est atteinte : aucune promesse de disponibilité illimitée.

Des sauvegardes restaurées ne doivent ressusciter ni anciens tokens révoqués ni RRsets retirés. Tester restauration du registre, génération des tokens, journal d'opérations et relecture fournisseur avant reprise des writes. Préserver le contrôle et le renouvellement du domaine parent ; sa perte affecterait toutes les installations.

## Adaptateur GoDaddy et décisions restantes

GoDaddy est le fournisseur DNS retenu. Il annonce depuis avril 2026 un seuil d'un domaine pour l'API DNS/gestion. Cela ne prouve pas l'éligibilité ou les permissions du compte réel, ni que ses nameservers servent actuellement `fullpanel.dev`. Vérifier la délégation effective vers GoDaddy avant toute écriture, sans migration automatique vers un autre fournisseur. [Annonce officielle du 28 avril 2026](https://www.godaddy.com/resources/news/godaddy-dns-api-now-works-with-a-single-domain).

Sa documentation actuelle distingue les API et modes d'authentification, dont PAT/Bearer et identifiants classiques. Choisir les endpoints DNS effectivement documentés, leurs scopes, quotas et TTL, puis tester l'adaptateur en environnement autorisé ; ne pas déduire les droits DNS d'une clé capable de rechercher un domaine. [Guide GoDaddy](https://developer.godaddy.com/en/docs/api-users/quickstart), [référence Domains](https://developer.godaddy.com/en/docs/references/rest/domains).

Les secrets fournisseur restent uniquement dans la configuration sécurisée du broker, avec accès opérateur restreint, rotation et redaction. Aucun secret dans client web, installation, image Docker, source Git ou corps d'erreur. Si le fournisseur ne limite pas la clé à cette zone, reconnaître cette portée plus large et renforcer la séparation du compte, le contrôle des mutations et l'audit.

Restent à décider : stockage durable, capacité/coût au-delà du dyno Basic et SLO, identité et récupération des propriétaires, quotas initiaux, baux/grâce, support IPv6/NAT, état DNS réel, versions/scopes API GoDaddy, stratégie de cookies/PSL, capacité et gouvernance ACME, processus d'abus. L'ouverture communautaire exige la recette ci-dessous ; aucune inscription PSL, émission publique, infrastructure Heroku ou mutation DNS n'est livrée par cette spécification.

## Recette future

| ID | Scénario | Résultat obligatoire |
| --- | --- | --- |
| M04-01 | Deux installations sur deux IP publiques | Sous-zones distinctes, panel et application atteignent chacun le bon serveur ; aucune dépendance à l'instance AWS historique. |
| M04-02 | Inscription concurrente, rejeu, défi expiré ou IP non contrôlée | Une activation au plus, refus sans DNS publié et sans attribution d'une identité existante. |
| M04-03 | IP privée/link-local/métadonnées, encodage ambigu, redirection et rebinding | Aucun socket vers une destination interdite ; vérification bornée et erreurs sans contenu distant. |
| M04-04 | Jeton d'un autre serveur, ancien jeton, rotation pendant worker | Aucun RRset étranger modifié ; ancien travail invalidé, récupération après réponse perdue sans fuite de secret. |
| M04-05 | Nouvelle IP, fournisseur en échec et redémarrage du worker | Preuve avant application, reprise idempotente, état désiré/appliqué honnête, enregistrements étrangers préservés. |
| M04-06 | HTTPS initial, renouvellement, certificat invalide et quota ACME | Hosts exacts vérifiés, clés privées propres, erreurs visibles, aucun fallback navigateur HTTP sous .dev. |
| M04-07 | Cookies parent, application voisine, Origin/CORS et clients avec/sans PSL actualisée | Aucune session panel volée/fixée ni action CSRF ; limites résiduelles et compatibilité documentées avant ouverture. |
| M04-08 | Quotas, réservations massives et émissions hors broker | Limites effectives démontrées, budget partagé surveillé et procédure d'abus testée ; pas de quota fictif. |
| M04-09 | Panne centrale prolongée, expiration et ancienne IP réattribuée | DNS actif préservé pendant panne, reprise avec grâce, retrait seulement selon politique ; noms jamais réaffectés. |
| M04-10 | Restauration PostgreSQL, retrait explicite et mode autonome | Pas de token/record révoqué ressuscité ; seuls RRsets possédés touchés ; domaines personnels restent indépendants. |

Tous ces scénarios sont **pending**. Une réussite locale avec Host forcé ne prouvera ni DNS public, ni TLS public, ni isolation entre installations réelles.
