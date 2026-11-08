# Adaptateur DNS GoDaddy limité aux sous-zones communautaires

État au 2026-11-08 : **contrat planifié, aucune clé configurée, aucun appel DNS authentifié ni mutation fournisseur exécutés pour cette spécification**. Le fournisseur retenu par l’utilisateur reste GoDaddy. Ce document complète [M04](19-community-domains.md) ; il ne rend pas opérationnelle l’inscription DNS.

## Choix de contrat et authentification

Le contrat de RRset retenu pour le prochain adaptateur est **v1, GET/PUT/DELETE par domaine, type et nom**, confirmé par le [Swagger classique officiel](https://classic-developer.godaddy.com/swagger/swagger_domains.json). L’authentification explicitement documentée dans son [guide classique](https://classic-developer.godaddy.com/getstarted) est `Authorization: sso-key <API_KEY>:<API_SECRET>`. Le compte est celui du propriétaire de `fullpanel.dev`, sans `X-Shopper-Id` de revendeur. Aucun scope fin par sous-zone n’est établi par ce contrat classique ; la restriction par installation doit donc être appliquée par le broker.

Ce choix de contrat n’est **pas une garantie de pérennité de sso-key** : la [documentation actuelle des versions et scopes](https://developer.godaddy.com/en/docs/api-users/domains) accepte encore cette authentification en v1/v2 mais annonce sa dépréciation en 2026 et recommande les PAT. Avant activation, vérifier le mécanisme réellement disponible pour le compte et ces opérations. Aucun essai automatique de plusieurs credentials ou versions après un 401/403 ; si le mécanisme classique n’est plus disponible, revoir et tester explicitement l’adaptateur.

Les pages v3 consultées utilisent PAT/Bearer, une liste filtrée par type/nom, un `recordId` pour remplacement/suppression et un POST pour création. Ce n’est pas un substitut transparent au PUT de RRset v1. Les scopes publics répertoriés sont `domains.domain:read` et `domains.dns:update` pour lecture et mutations DNS ; ils ne prouvent ni une restriction à `fullpanel.dev`, ni une équivalence des endpoints. Une évolution PAT/v3 exige son propre contrat et ses tests, sans ajouter les scopes achat ou modification des nameservers. Sources : [liste v3](https://developer.godaddy.com/en/docs/references/rest/domains/v3/list-dns-records), [remplacement v3](https://developer.godaddy.com/en/docs/references/rest/domains/v3/replace-dns-record), [suppression v3](https://developer.godaddy.com/en/docs/references/rest/domains/v3/delete-dns-record).

GoDaddy annonce l’accès DNS/gestion avec un domaine depuis avril 2026 ; l’éligibilité effective, les permissions, l’état actif du domaine et ses DNS autoritatifs doivent être contrôlés avant production. Le seuil ne signifie pas que le compte ou la clé a déjà été testé. [Annonce officielle du 28 avril 2026](https://www.godaddy.com/resources/news/godaddy-dns-api-now-works-with-a-single-domain).

Les conditions du guide classique contiennent des restrictions relatives aux services proposés à des tiers et aux usages payants. Leur applicabilité au service communautaire doit être examinée avant ouverture ; l’éligibilité technique d’un compte à un domaine ne vaut pas autorisation de cet usage. Ce document n’en déduit aucune conclusion juridique.

## Périmètre immuable des requêtes

Constantes de l’adaptateur : origine HTTPS de production `https://api.godaddy.com`, domaine `fullpanel.dev`, type `A`. OTE possède une origine distincte, `https://api.ote-godaddy.com`, et des clés distinctes ; aucune bascule entre environnements n’est automatique. La présence du domaine dans OTE et la fidélité de ses comportements doivent être établies par la recette, pas présumées.

Le nom relatif est construit exclusivement depuis l’identifiant interne authentifié : `*.s-<32hex>`, avec exactement 32 caractères hexadécimaux minuscules après `s-`. Exemple structurel : `*.s-0123456789abcdef0123456789abcdef`. Il n’est jamais accepté comme chaîne libre du client. Le nom complet correspondant est `*.s-<32hex>.fullpanel.dev`.

Le chemin autorisé est uniquement `/v1/domains/fullpanel.dev/records/A/{nom-relatif-encodé}`. Encoder le segment avec une fonction d’encodage URL, sans concaténer une URL ou un chemin transmis par l’utilisateur. Refuser toute variante d’apex, de zone, de type, de nom, de port, d’origine ou de schéma. Pas de redirection HTTP, même vers un autre domaine GoDaddy ; TLS vérifié et délais/corps bornés.

| Méthode | Contrat v1 documenté | Usage FullPanel |
| --- | --- | --- |
| GET | Réponse 200, tableau de `DNSRecord` ; pagination `offset`/`limit`. | Lire uniquement le RRset A exact, valider chaque élément et établir son contenu complet. |
| PUT | Tableau de `DNSRecordCreateTypeName` ; remplace le RRset exact ; succès 200. | Une seule IPv4 publique vérifiée, corps `[{ "data": "<IPv4 vérifiée>", "ttl": 600 }]`. Aucun champ de nom/type libre. |
| DELETE | Supprime le RRset exact ; succès 204. | Retrait explicitement autorisé d’un RRset dont l’état actuel correspond à la propriété enregistrée. |

Les routes `/records` et `/records/A` sont exclues : leur portée de remplacement serait respectivement la zone ou tous ses A. Aucun POST/PATCH, aucun achat, transfert, nameserver, apex, MX/TXT/CAA ou domaine du site `fullpanel.io` dans cet adaptateur. [Schémas et opérations v1](https://classic-developer.godaddy.com/swagger/swagger_domains.json).

**TTL proposé : 600 secondes.** Le schéma classique exige un entier positif sans préciser de minimum ; la documentation générale actuelle indique une plage de 600 à 86 400 secondes sur les DNS GoDaddy. Le minimum réellement accepté et la valeur relue sont donc à tester. Ne pas promettre une propagation immédiate ; TTL et caches négatifs restent distincts d’un succès API. [Comportement DNS documenté](https://developer.godaddy.com/en/docs/api-users/domains).

## Lecture avant écriture et propriété

Le registre durable conserve propriétaire, identifiant serveur, génération du token, dernier RRset appliqué (nom/type/IP/TTL), opération en cours et résultat des lectures fournisseur. Un nom ressemblant à notre préfixe, une IP identique ou une réponse DNS publique ne prouvent pas à eux seuls la propriété.

1. Verrouiller l’installation dans le registre ; vérifier autorité actuelle, génération, preuve de contrôle de l’IPv4 et absence d’autre mutation. Journaliser l’intention avant l’appel fournisseur.
2. Lire le RRset exact. Valider tableau, type A, nom relatif attendu, IPv4 canonique et TTL entier ; refuser tout champ essentiel absent ou réponse tronquée. Parcourir la pagination jusqu’à une fin attestée avec limites strictes ; plus d’un enregistrement entraîne un conflit, jamais la sélection arbitraire du premier.
3. Première création : seul un GET 200 dont le résultat complet est `[]` permet de tenter le PUT. Tout RRset déjà présent sans propriété durable est étranger, même si son IP correspond. Ne pas l’adopter automatiquement.
4. Mise à jour ou suppression : comparer intégralement le RRset actuel au dernier état possédé. Toute différence, valeur supplémentaire ou modification externe bloque la mutation et demande une résolution explicite. L’IP précédente n’est pas une preuve suffisante à elle seule.
5. Revérifier l’autorisation/génération avant l’écriture ; après succès, relire le même RRset et comparer à l’état désiré. Marquer séparément intention, écriture acceptée et lecture confirmée. Une résolution autoritative ultérieure est une autre preuve ; un récursif en cache ne remplace pas cette relecture.
6. Timeout après envoi : résultat indéterminé. Relire et réconcilier à partir de l’intention persistée avant toute répétition. Un échec ne permet jamais de nettoyer un autre nom ou d’élargir la route API.

Le Swagger ne documente pas de précondition atomique de type ETag/If-Match sur ces mutations. Le verrou FullPanel ne protège pas contre une édition GoDaddy simultanée entre GET et PUT/DELETE. Exiger l’usage exclusif de cet espace de noms par le broker, détecter la dérive et reconnaître cette limite ; ne pas annoncer une garantie atomique contre tout administrateur fournisseur concurrent. En cas de doute, conserver un conflit et ne pas écraser.

## Absence et erreurs

- **GET 200 + tableau vide complet** : absence observée. Le PUT peut être tenté selon les règles précédentes, mais sa création sur RRset absent doit être validée réellement : le libellé documentaire « remplacer » ne suffit pas à certifier cette sémantique.
- **GET/PUT 404** : ressource non trouvée, cause non distinguée par le schéma ; ne pas convertir en liste vide. **DELETE 404** désigne le domaine non trouvé, pas une suppression idempotente réussie.
- **401/403** : configuration/autorisation à corriger ; aucun fallback de credential ni retry en boucle. **409/422** : conflit, éligibilité ou entrée invalide ; conserver l’erreur sans mutation corrective de portée plus large.
- **429** : respecter le délai fournisseur, backoff avec jitter et budget partagé. **500/504, réseau interrompu** : état éventuellement indéterminé ; relecture avant nouvelle mutation. Les erreurs publiées ne contiennent ni secret, ni header, ni corps fournisseur brut.
- Après DELETE 204, ne déclarer le retrait confirmé qu’après constat d’absence via le contrat testé. Si le fournisseur répond autrement à un RRset absent, garder l’état « confirmation indisponible » jusqu’à clarification ; ne pas inventer une réussite.

Le guide classique indique 60 requêtes/minute par endpoint ; l’annonce d’avril donne une autre unité pour son débit. Adopter une limite initiale conservatrice **au plus 30 requêtes/minute pour l’ensemble des workers**, lectures et retries inclus, et vérifier quotas réels du compte avant dimensionnement. Ne pas créer plusieurs clés pour contourner une limite. Ce plafond interne est un choix FullPanel, pas une promesse fournisseur.

## Configuration opérateur sans secret dans le chat

Étape pratique future : l’opérateur configure lui-même les valeurs dans **Heroku Dashboard → application centrale → Settings → Config Vars**, après confirmation de l’application cible et du mode d’authentification retenu. Pour le profil classique décrit : `GODADDY_API_KEY`, `GODADDY_API_SECRET`, et un indicateur d’activation explicite initialement désactivé. Une configuration incomplète reste désactivée.

Ne jamais demander de coller ces valeurs dans le chat, une issue, un formulaire visiteur, une commande journalisée ou le dépôt. La question utile est uniquement : « Les deux variables de production sont-elles configurées dans l’application Heroku cible, sans communiquer leurs valeurs ? » Aucun utilisateur d’une installation cliente ne reçoit ces secrets ; seul son jeton de broker lui appartient. Rotation, accès opérateurs et redaction sont obligatoires ; la portée potentiellement plus large de la clé GoDaddy reste un risque du compte central à maîtriser.

## Recette préalable à toute activation

| Cas | Résultat à prouver |
| --- | --- |
| Contrat fournisseur | Authentification réellement acceptée, wildcard relatif accepté, TTL relu, pagination et forme d’absence établies ; aucun test fondé seulement sur des mocks. |
| Nom/type/zone étrangers | Refus avant requête réseau ; aucune route à portée zone/type ni redirection suivie. |
| RRset absent puis créé | Intention durable, PUT ciblé, relecture exacte, absence d’impact sur les autres records ; preuve DNS séparée. |
| RRset étranger, multivaleur ou modifié | Conflit explicite, zéro PUT/DELETE ; même IP étrangère non adoptée. |
| Rotation, concurrence et crash | Ancien token/travail refusé à la frontière d’écriture ; redémarrage réconcilie l’intention, sans écrasement ni double opération aveugle. |
| Suppression et ressource absente | 204 puis absence confirmée ; aucun 404 réinterprété comme succès et aucun nom réattribué. |
| Quota, timeout et secret manquant | File bornée, retries contrôlés, statut honnête, aucune fuite ni activation implicite. |

Toutes ces preuves sont **pending**. Les sources ont été consultées publiquement le 2026-11-08 ; aucune credential, donnée de compte ou infrastructure privée n’a été consultée pendant cette recherche.
