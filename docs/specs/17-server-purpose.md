# Usage du serveur — Développement, Staging et Production

État : **fonctionnalité future demandée, non implémentée et non vérifiée**. Feuille de route : **M03**. Cette politique est une exigence propre à FullPanel ; aucune absence équivalente dans un autre produit n'est affirmée. Elle complète les spécifications vivantes sans modifier le DOCX de référence.

## Besoin utilisateur

Choisir l'usage du serveur et obtenir automatiquement le niveau d'exposition approprié. Un environnement de développement ou de staging doit rester accessible uniquement aux personnes autorisées, sans contenu livré aux robots d'exploration, de collecte ou de scan. Un serveur de production permet de publier les sites destinés au public et de les rendre indexables.

| Usage | Accès aux applications | Exploration et indexation |
| --- | --- | --- |
| **Développement** | Réseau restreint, HTTPS et authentification Basic obligatoire, appliqués globalement. | `robots.txt` bloquant, en-têtes anti-indexation et aucun contenu applicatif accessible anonymement. |
| **Staging** | Même protection obligatoire ; accès nominatifs pour l'équipe et les personnes autorisées à valider les applications. | Même blocage que le développement, y compris pour les liens de prévisualisation. |
| **Production** | Les applications destinées au public peuvent être exposées sans la barrière globale hors production. Les protections particulières des services privés sont conservées. | Les pages publiques sont explorables selon les règles de leur application ; les interdictions ajoutées uniquement par la politique hors production sont retirées. |

Le **panel d'administration reste authentifié, soumis aux permissions et non indexable dans les trois modes**. Passer en production ne publie ni son API privée, ni les bases de données, sauvegardes, journaux ou secrets.

## Parcours et état visible

Lors de la première configuration, demander **À quoi sert ce serveur ?** avec les trois choix. Développement est présélectionné ; aucune application n'est exposée avant validation et application effective de sa politique. Afficher ensuite le libellé choisi dans la navigation et sur les écrans de déploiement, avec une icône et un texte compréhensibles sans couleur.

Seuls le propriétaire et les administrateurs peuvent changer cet usage ou administrer ses accès. Un opérateur de projet peut renforcer la protection d'un service, jamais supprimer la barrière imposée par un serveur de développement ou de staging.

Séparer le choix enregistré de sa mise en œuvre : **À configurer**, **Application en cours**, **Protection vérifiée**, **Échec de protection**. Le statut doit préciser les routes contrôlées et l'heure de vérification. Un libellé « Staging » dans les réglages ne suffit jamais à annoncer une protection effective.

Sur une installation existante, l'absence du nouveau champ correspond à **Usage à confirmer**. Ne pas requalifier silencieusement un serveur en production ou casser des services existants pendant une mise à jour. Présenter l'inventaire et le plan d'application ; interdire toute nouvelle exposition tant que l'usage n'est pas confirmé. Les accès déjà présents restent explicitement signalés comme non couverts jusqu'à l'activation vérifiée de la politique.

## Protection obligatoire hors production

### 1. Restriction réseau et absence de contournement

Un endpoint accessible depuis tout Internet peut recevoir des tentatives de scan même s'il répond uniquement 401. Le mode strict demandé impose donc un accès par réseau privé/VPN ou une liste d'adresses autorisées, **en plus** de l'authentification HTTP. Ne pas promettre l'invisibilité d'une adresse publique, d'un nom DNS ou d'un certificat déjà publié.

Bloquer les chemins qui contourneraient cette protection : ports Docker directement publiés, ports Compose, interfaces IPv4/IPv6, accès par IP, autre nom d'hôte, ancien conteneur, route historique ou proxy secondaire. Les bases de données et autres protocoles non HTTP restent sur des réseaux privés ; Basic Auth n'est pas une protection pour TCP/UDP arbitraire. Un type de service sans chemin protégé pris en charge doit refuser son exposition plutôt que publier son port.

La vérification doit porter sur les règles et listeners réellement actifs, y compris ceux créés par Docker. Préserver un accès d'administration de secours validé lors de l'application des restrictions. Les ressources étrangères à FullPanel sont inventoriées et signalées ; leur suppression ou modification ne fait pas partie d'un nettoyage automatique. Un accès public inexpliqué ou une topologie non vérifiable empêche d'afficher « Protection vérifiée » pour l'ensemble du serveur.

### 2. HTTPS et authentification Basic

Imposer HTTPS avec certificat vérifiable avant de proposer une authentification Basic. Sur HTTP, ne servir ni contenu applicatif ni challenge Basic ; le trafic autorisé peut seulement être redirigé vers HTTPS ou refusé. Basic encode les identifiants sans les chiffrer à lui seul. [RFC 7617](https://www.rfc-editor.org/rfc/rfc7617.html)

Les accès sont dédiés, révocables et limités aux projets autorisés, sans réutiliser les mots de passe du panel. Stocker des empreintes de mots de passe et ne jamais inclure les identifiants dans une URL, un journal, une capture ou le contexte de construction d'une image. Prévoir limitation des tentatives, rotation, retrait d'un utilisateur et fermeture des accès persistants concernés.

La barrière d'accès doit couvrir toutes les méthodes, chemins, fichiers statiques, PDF/images, API et ouvertures WebSocket, avec refus avant contact avec l'application pour un client non autorisé. Le même résultat doit s'appliquer à tous les alias, domaines générés, routes exactes et wildcards pris en charge. Aucun traitement favorable d'un User-Agent de robot, de `HEAD`, d'`OPTIONS`, d'un en-tête transféré ou d'une variante de chemin.

**Compatibilité avec l'authentification des applications :** Basic global et Bearer applicatif ne peuvent pas être simplement superposés dans le même en-tête `Authorization`. Le développement doit définir une passerelle d'accès : authentification Basic initiale sur une route réservée, puis session d'accès courte, sécurisée, limitée au domaine et contrôlée à chaque requête. Cette session permet de conserver l'authentification propre à l'application ; elle doit être invalidée lors d'une révocation ou rotation. Ne pas transférer le secret Basic d'infrastructure à l'application, ni supprimer aveuglément son Bearer ou ses propres identifiants. Le protocole, la protection contre la fixation de session et les collisions de routes sont des prérequis à valider, pas une capacité actuelle.

Une API, un webhook ou un client ne pouvant pas satisfaire la barrière reste bloqué avec un diagnostic explicite. Aucun chemin public d'exemption automatique pour rendre une intégration fonctionnelle. Une éventuelle solution d'accès machine doit fournir une protection équivalente et faire l'objet d'une spécification et d'une validation dédiées.

### 3. Robots, indexation et caches

Pour chaque nom d'hôte géré, le proxy doit imposer à la racine `/robots.txt` le contenu suivant, même si l'application est servie sous un sous-chemin ou fournit un fichier plus permissif :

```text
User-agent: *
Disallow: /
```

Ce fichier reste soumis à la même barrière d'accès. Un client anonyme est refusé ; un client autorisé reçoit le fichier généré. Ajouter `X-Robots-Tag: noindex, nofollow, nosnippet` aux réponses hors production, y compris les refus et erreurs HTTP lorsque ceux-ci peuvent être émis. Les en-têtes plus permissifs de l'application ne doivent pas neutraliser la politique. Ne pas placer une directive `noindex` dans `robots.txt` comme si elle était prise en charge par Google. [Google — noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)

Ces consignes complètent le contrôle d'accès. `robots.txt` ne force pas les robots malveillants à obéir et une URL déjà connue peut apparaître dans les résultats sans exploration de son contenu. Un robot bloqué par l'authentification ou par `robots.txt` ne peut pas lire le `noindex` d'une page. Ne jamais rendre temporairement un site privé public pour lui faire lire cette directive. [Google — limites de robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro)

Empêcher le cache partagé du contenu protégé, notamment avec `Cache-Control: private, no-store`. À l'activation, invalider les caches maîtrisés et vérifier les éventuels CDN ou origines alternatives. Un cache externe non maîtrisé ou un contenu déjà publié exige un traitement distinct ; la politique ne peut pas garantir l'effacement des copies et index antérieurs. Le résultat annoncé est le refus de l'accès non autorisé au contenu, pas une garantie absolue qu'aucune adresse n'est connue d'un moteur ou d'un scanner.

### 4. Certificats sans ouverture applicative

Le profil réseau privé privilégie une validation DNS-01 pour un domaine contrôlé, ou un certificat approuvé par les clients. L'émission HTTP-01 demande un accès public de validation sur le port 80 ; elle ne doit pas devenir une exception silencieuse aux restrictions réseau. Si un parcours HTTP-01 est explicitement retenu, seul le challenge exact géré par le proxy peut répondre, jamais une route applicative ni un préfixe `/.well-known/` entier. Une erreur de certificat maintient le refus d'accès. [Let's Encrypt — types de challenges](https://letsencrypt.org/docs/challenge-types/)

Le **profil strict sans endpoint public** exige DNS-01 ou un certificat approuvé et ne permet pas cette exception HTTP-01. Une variante avec validation publique doit être choisie et approuvée explicitement ; elle ne peut pas être affichée comme le profil strict sans endpoint public, même si le contenu applicatif reste protégé.

## Production et changement de mode

Pour les applications publiques en production, retirer uniquement le blocage et la barrière injectés par cette politique. Conserver les authentifications propres aux applications, les protections volontaires des services privés et les règles SEO fournies par leurs propriétaires. Ne pas remplacer arbitrairement un `robots.txt`, une balise ou un en-tête `noindex` intentionnel par `Allow: /` ou `index`. Un site explorable n'est pas une promesse d'indexation ou de classement.

Le passage **Développement/Staging → Production** affiche les domaines qui deviendront publics et ceux qui resteront privés, avec confirmation explicite du nom du serveur. Préparer et valider les changements avant l'ouverture. Une vérification après application contrôle l'absence de barrière hors production sur les sites choisis et le maintien des protections du panel et des services privés.

Le passage **Production → Développement/Staging** ferme d'abord l'accès anonyme, applique les restrictions et invalide les caches contrôlés, puis vérifie l'ensemble avant d'annoncer la réussite. Une interruption peut être nécessaire ; l'interface l'indique avant confirmation. Un échec ne rétablit pas automatiquement une exposition publique.

L'application nécessite un journal durable avec version de politique, périmètre, étapes, résultats et reprise après interruption. Préserver l'accès d'administration de secours. Les nouveaux déploiements, restaurations, modèles, migrations et rollbacks utilisent toujours la **politique serveur actuelle**, jamais celle embarquée dans une ancienne release. Une modification d'usage ou de droits en cours d'opération impose une revalidation avant activation.

## Écarts actuels et interactions

Le code actuel ne fournit pas cette garantie : Basic Auth est facultatif et attaché à chaque route ; les publications de ports peuvent contourner Traefik ; Compose utilise des ports explicites ; l'exposition du panel possède une configuration séparée. Un rollback réapplique des paramètres de routage historiques. La mise en œuvre devra couvrir tous ces chemins, et pas uniquement ajouter un sélecteur dans Settings.

- **R08 — URL de test :** les URL HTTP actuellement générées ne satisfont pas cette politique. En développement/staging, une URL devra emprunter un accès HTTPS restreint et protégé ; sinon sa publication sera bloquée avec l'étape manquante. Ne jamais demander un mot de passe Basic sur l'URL HTTP actuelle.
- **M01 — migration :** inventorier les expositions source, appliquer la politique cible aux candidats avant toute ouverture et refuser une conversion qui la contourne.
- **M02 — mobile :** l'application devra satisfaire les restrictions réseau et la barrière d'accès avant l'association QR et les API de suivi. Une paire valide ne crée aucune exemption. Afficher l'usage du serveur et l'état effectif de protection.
- **Administration et automatisation :** conserver l'authentification du panel, les permissions par projet et les signatures/jetons propres aux intégrations ; documenter les intégrations bloquées plutôt que les rendre anonymes.

## Critères d'acceptation du futur lot

| ID | Scénario | Résultat attendu |
| --- | --- | --- |
| M03-01 | Première installation et mise à jour d'une installation existante | Usage explicitement choisi ; aucune nouvelle exposition avant activation ; ancien serveur non requalifié silencieusement et inventaire des accès existants visible. |
| M03-02 | Développement et staging, avec/sans identifiants valides | Depuis un réseau autorisé : refus anonyme, refus du mauvais secret, accès TLS correct avec autorisation ; aucun contenu applicatif ni secret livré avant le contrôle. |
| M03-03 | Client extérieur, accès par IP, autre hôte, IPv6, TCP/UDP ou port direct | Aucune voie d'accès anonyme aux workloads ; restrictions actives vérifiées au-delà du seul proxy, Compose compris. Une topologie non couverte bloque la certification de protection. |
| M03-04 | Routes, fichiers, sous-chemins, méthodes, chemins encodés et WebSocket | Politique non contournable ; accès applicatif normal après authentification ; rejet des variantes adverses et absence d'exemption liée au User-Agent. |
| M03-05 | Fichier robots permissif, en-têtes contradictoires et caches | `/robots.txt` imposé par hôte après authentification ; noindex imposé aux réponses concernées ; cache partagé interdit et purge des caches contrôlés vérifiée. |
| M03-06 | Application utilisant Bearer, cookies ou sa propre authentification | Barrière globale toujours appliquée ; identité applicative conservée ; secret Basic d'infrastructure absent de l'amont et des journaux ; client incompatible bloqué explicitement. |
| M03-07 | Certificat absent/expiré, HTTP et validation ACME | Aucun challenge Basic en clair ni ouverture de secours ; restriction réseau conservée et exception de challenge éventuelle strictement bornée. |
| M03-08 | Bascule vers production | Confirmation des domaines publics ; retrait des seules contraintes injectées ; règles SEO applicatives et services privés conservés ; panel toujours authentifié et non indexable. |
| M03-09 | Retour hors production, échec partiel et crash à chaque étape | Accès fermé avant migration, journal repris sans fenêtre publique non autorisée, état d'échec honnête et canal de secours disponible. |
| M03-10 | Déploiement, restauration, rollback ancien, ajout de domaine et migration | Politique serveur courante imposée à chaque activation ; aucune ancienne release ou route générée ne restaure un accès public hors production. |
| M03-11 | Révocation, rotation, réduction des droits et opérateur projet | Aucun retrait de la protection globale par l'opérateur ; secrets et sessions précédents invalidés, connexions concernées fermées et aucun accès à un projet non autorisé. |
| M03-12 | Scan extérieur, ressource étrangère et contenu déjà indexé | Preuves d'accès/refus réellement collectées, périmètre et limites affichés ; aucun effacement ou blocage arbitraire d'une ressource étrangère et aucune promesse de désindexation instantanée. |

Tous ces critères sont à réaliser. Le changement présent ajoute une spécification et une entrée de feuille de route ; il ne change aucun accès ni routage existant.
