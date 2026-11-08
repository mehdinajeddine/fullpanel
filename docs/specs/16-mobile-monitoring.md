# FullPanel Mobile — suivi du panel par QR code

État : **fonctionnalité future demandée, non développée et non testée**. Identifiant de feuille de route : **M02**. Applications iOS et Android visées ; technologie et distribution à décider lors du développement. Cette extension complète la feuille de route sans modifier le DOCX de référence.

## Besoin utilisateur

Depuis son téléphone, retrouver en quelques secondes l'état de son serveur, de ses projets et de ses services, sans recopier une adresse ou une clé API. L'utilisateur ouvre FullPanel sur son ordinateur, affiche un QR code et le scanne dans l'application mobile pour associer son téléphone.

Le premier lot permet la **consultation en lecture seule**. Déployer, redémarrer, restaurer, ouvrir un terminal ou modifier la configuration depuis le téléphone reste hors de ce lot.

## Parcours d'association

1. Dans le panel, ouvrir **Mon compte → Appareils mobiles → Associer un téléphone**. La session doit être authentifiée et récente.
2. Le panel affiche un QR code temporaire, un compte à rebours et le nom du serveur. Une nouvelle génération invalide le code précédent.
3. Dans l'application FullPanel Mobile, choisir **Ajouter un panel**, puis scanner le QR code. Proposer également un lien d'association temporaire si l'appareil ne peut pas utiliser sa caméra.
4. Le téléphone affiche le nom et l'adresse du serveur déjà contenus dans le QR, puis un code de confirmation identique à celui affiché dans le panel. Aucun compte, projet ou état de service n'est renvoyé à ce stade.
5. Dans le panel authentifié, l'utilisateur vérifie le code et le téléphone, choisit les projets accessibles et confirme. Le scan seul ne donne aucun accès. Le serveur crée ensuite un accès propre à cet appareil, lié au compte et limité au suivi ; le téléphone peut alors afficher ce compte et ces projets.
6. Le tableau de bord mobile s'ouvre avec l'heure de dernière synchronisation. Le téléphone apparaît dans la liste des appareils avec son nom, sa date d'association, sa dernière activité et une action **Révoquer l'accès**.

Un téléphone peut suivre plusieurs panels indépendants. Le nom du panel reste visible sur chaque écran ; les données et les accès des différents serveurs sont isolés.

L'[usage du serveur et sa politique de protection M03](17-server-purpose.md) devront être affichés. Sur un panel de développement ou de staging, le téléphone doit satisfaire les restrictions réseau et la barrière d'accès avant l'association et le suivi ; le QR ne crée aucune exemption.

## Ce que l'application affiche

| Vue | Informations utiles |
| --- | --- |
| Mes panels | Connexion de chaque panel, incidents connus et dernière synchronisation. Un panel injoignable apparaît comme inaccessible, sans conclure que ses applications sont arrêtées. |
| Vue d'ensemble | Services en cours d'exécution, arrêtés, en déploiement ou en échec ; opérations récentes et éléments nécessitant une attention. |
| Projets et services | Liste limitée aux projets autorisés, source de déploiement non sensible, état du conteneur et dernier résultat de déploiement. L'état applicatif n'est affiché comme sain que si une sonde réelle le confirme. |
| Ressources | CPU, mémoire et disque lorsque ces mesures sont disponibles, avec leur périmètre et leur date. Une valeur indisponible n'est jamais remplacée par un zéro. Les historiques nécessitent une collecte persistante à développer. |
| Déploiements et sauvegardes | Résultat, date, durée et erreurs résumées sans secrets. Aucun téléchargement de sauvegarde ni affichage des variables, jetons, clés privées ou journaux bruts dans ce premier lot. |

Les états utilisent une icône et un libellé en plus de la couleur. Une actualisation manuelle reste disponible. Hors connexion, montrer les dernières données autorisées avec **Données non actualisées** et leur horodatage, puis les effacer à l'expiration du cache ; ne jamais garder un voyant de connexion active sans preuve récente.

## Association, accès et confidentialité

- **QR à usage unique**, valable deux minutes au maximum, avec version de format, adresse HTTPS explicite du panel, nom d'affichage, identifiant opaque et secret aléatoire. Conserver seulement l'empreinte du secret côté serveur. Aucun mot de passe, cookie de session, jeton permanent ou secret de projet dans le QR. Le lien de remplacement suit les mêmes règles et n'est pas journalisé.
- L'association suit les états `pending → claimed → approved → consumed`, avec sorties `expired` et `cancelled`. Réserver et consommer le code de façon atomique ; deux téléphones ne peuvent pas obtenir un accès à partir du même code. Ne pas consommer un code par un simple GET ou un aperçu de lien.
- L'application génère une clé propre à l'appareil ; l'approbation lie le compte, le panel et cet appareil. L'échange initial et les renouvellements doivent prouver la possession de cette clé. Le protocole et sa validation seront définis avant implémentation.
- Utiliser HTTPS avec vérification du certificat et du nom du serveur. Refuser les adresses mal formées, schémas arbitraires et redirections transmettant des identifiants à un autre serveur. Ne pas désactiver TLS pour rendre un scan fonctionnel.
- Créer des accès mobiles distincts des cookies navigateur et des clés d'automatisation. Enregistrer côté serveur les projets choisis lors de l'approbation. L'autorisation est l'intersection des droits actuels du compte, de cette sélection et des seules opérations de consultation mobile ; le téléphone ne peut pas élargir sa sélection. Même un propriétaire ne reçoit aucun droit de mutation sur ce canal.
- Vérifier cette autorisation à chaque requête et à l'ouverture ou au renouvellement des flux. Réduction des droits, désactivation du compte ou révocation de l'appareil retirent l'accès serveur dès la requête suivante et ferment les flux concernés. Les données déjà vues hors ligne ne peuvent pas être effacées à distance tant que le téléphone reste déconnecté ; limiter et chiffrer le cache.
- Stocker les identifiants et la clé de l'appareil dans le stockage sécurisé du système mobile ; prévoir expiration, renouvellement, révocation et suppression locale à la déconnexion. Ne pas inclure de secrets dans les journaux, liens d'ouverture ou notifications.
- Tracer les associations, refus et révocations sans conserver le contenu du QR. Limiter les tentatives et la fréquence de création des codes. Un redémarrage du panel invalide les associations non achevées, sans réactiver un appareil révoqué.

## Connexion et limites du premier lot

La connexion est directe entre l'application et le panel. Le téléphone doit pouvoir joindre son adresse HTTPS : accès public configuré, réseau local approprié ou VPN géré par l'utilisateur. Scanner un QR code ne configure ni DNS, ni certificat, ni tunnel et ne rend pas un serveur local accessible depuis Internet. Afficher un diagnostic distinct pour adresse inaccessible, certificat invalide, code expiré ou droits retirés.

Les API mobiles devront fournir des réponses minimales adaptées au suivi, avec horodatage, disponibilité et périmètre de chaque mesure. Aucun endpoint mobile, écran d'association ou identifiant d'appareil n'existe actuellement. La consultation utilisera une actualisation bornée au premier plan ; le mécanisme de flux, sa fréquence et les budgets réseau/batterie seront validés sur appareils réels.

Les **notifications d'incident** sont une extension ultérieure : opt-in par panel, filtres, déduplication, retour à la normale et contenu discret sur l'écran verrouillé. Elles nécessitent une architecture de livraison distincte à définir. Si le panel lui-même est hors ligne, seule une infrastructure de surveillance indépendante peut détecter et transmettre cette indisponibilité ; ne pas promettre cette alerte avec la seule connexion directe. Aucun relais hébergé ou service push n'est inclus implicitement dans le premier lot.

## Critères d'acceptation du futur lot

| ID | Scénario | Résultat attendu |
| --- | --- | --- |
| M02-01 | Association nominale sur iOS et Android | Scan, identification du panel, confirmation concordante dans les deux interfaces et accès aux seuls projets autorisés ; aucune saisie de clé permanente. |
| M02-02 | Code expiré, remplacé, déjà utilisé, scan concurrent ou lien préchargé | Refus utile, aucune double association ; un aperçu de lien ne consomme pas le code. Un scan non approuvé n'accède à aucune donnée du panel. |
| M02-03 | QR photographié, appareil substitué, changement d'origine ou rejeu | Aucun accès sans approbation et preuve de possession ; vérification TLS maintenue et aucun identifiant transmis à un autre serveur. |
| M02-04 | Viewer, opérateur, administrateur, propriétaire et plusieurs panels | Périmètres stricts, aucune mutation autorisée, aucun secret ou journal brut dans les réponses ; aucune donnée mélangée entre comptes ou panels. Un appareil ne peut pas élargir les projets sélectionnés, même si son compte accède à davantage de projets. |
| M02-05 | Révocation, droits réduits, compte désactivé et redémarrage | Accès serveur et renouvellement refusés immédiatement selon les règles ci-dessus ; flux fermés, cache expiré/effacé selon sa politique et aucune réactivation après redémarrage. |
| M02-06 | Services actifs, arrêtés, en échec, mesures absentes et données anciennes | Informations conformes au runtime et horodatées ; états inconnus distincts d'un succès, d'un arrêt ou d'une mesure à zéro. |
| M02-07 | Passage Wi-Fi/mobile, VPN absent, certificat invalide, veille et retour au premier plan | Messages précis, cache signalé, reprise sans boucle de requêtes ni collecte illimitée en arrière-plan ; absence de fausse promesse d'accès distant. |
| M02-08 | Accessibilité et confidentialité sur appareils réels | Libellés utilisables avec lecteur d'écran et sans distinction des couleurs ; cache/identifiants protégés, traces sans secrets et suppression locale à la déconnexion. |

Ces critères sont à réaliser. Ils ne constituent ni une fonctionnalité disponible aujourd'hui, ni des résultats de tests obtenus.
