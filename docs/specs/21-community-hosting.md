# Hébergement initial du site et de l’API communautaire

État au 2026-11-08 : **premier site et API d’information déployés et vérifiés sur l’URL Heroku**, release v4 issue du commit `9ecf22a`. Le domaine personnalisé reste à valider. Ce document décrit le premier hébergement de `community/`. Les preuves de livraison sont consignées séparément dans [VERIFICATION.md](../VERIFICATION.md). Il ne déclare pas livré le broker DNS de [M04](19-community-domains.md).

## Périmètre du premier lot

Un site public présente FullPanel, ses capacités réellement disponibles, ses limites et les liens vers le dépôt et la documentation. Le même processus fournit deux endpoints publics de lecture : santé du service et description de ses capacités. Le visiteur ne crée ni compte communautaire, ni identité de serveur, ni domaine.

Ce service est distinct du panneau installé sur chaque serveur : il n’exécute aucun conteneur utilisateur, n’accède à aucun socket Docker et ne reçoit ni clé SSH, ni secret du panel, ni sauvegarde. Le serveur AWS déjà utilisé reste une installation autonome, pas le backend commun de toutes les installations.

Les actions du site doivent ouvrir une destination existante ou indiquer explicitement une fonctionnalité future. Aucun bouton d’inscription DNS ne doit simuler une réussite, collecter un jeton ou afficher un domaine « réservé » sans registre durable.

## Processus Heroku et coût prévu

Le format initial est **un seul processus `web` sur un dyno Basic**, servant le site et l’API depuis le même déploiement. Le tarif public consulté est de **7 USD par mois pour Basic**, hors autres services, taxes et évolution tarifaire. Le premier contrôle de formation a confirmé un unique `web.1` Basic et aucun add-on. Le propriétaire a ensuite autorisé et provisionné PostgreSQL Essential-0 à 5 USD/mois pour le prochain lot de registre, soit 12 USD/mois au total ; le site et les endpoints actuels ne l’utilisent pas encore. Aucun worker séparé ou dyno supplémentaire n’est prévu. [Tarifs Heroku](https://www.heroku.com/pricing/).

Le processus écoute sur le port fourni par l’environnement Heroku et accepte les connexions sur l’interface attendue par la plateforme. Il s’arrête proprement lors d’un redémarrage ou d’une nouvelle release. Les ressources statiques du site sont assemblées et versionnées dans le paquet déployé, puis servies depuis ce résultat immuable ; aucun bundler n’est requis, et aucune compilation ni installation de dépendances n’est déclenchée par une requête visiteur.

Le runtime et le buildpack doivent être explicitement compatibles avec l’application ; la commande de lancement, la racine du projet `community/` et les fichiers embarqués doivent être vérifiés avant déploiement. Le paquet communautaire ne doit pas embarquer les données locales ou les secrets d’une installation FullPanel.

La première URL peut être celle attribuée par Heroku. L’association du site à `fullpanel.io` et `www.fullpanel.io`, ses enregistrements GoDaddy et son certificat public exigent leurs propres preuves : un déploiement réussi sur une URL Heroku ne valide pas automatiquement les domaines personnalisés. `fullpanel.dev` reste réservé au futur service DNS communautaire. Aucun changement des domaines des installations existantes ne fait partie de cette étape.

## Contrat public en lecture seule

| Route | Signification | Limite de la réponse |
| --- | --- | --- |
| `GET /api/health` | Réponse `{ "status": "ok", "service": "fullpanel-community" }` : le processus web répond. | Ne certifie ni accès GoDaddy, ni registre PostgreSQL, ni DNS utilisateur, ni capacité à émettre un certificat. |
| `GET /api/v1/info` | `apiVersion: "v1"`, `name: "FullPanel"`, licence/dépôt publics, liens GitHub fixes et `release.commit` facultatif. | `communityDomains: { status: "planned", registrationEnabled: false }` : aucune inscription, allocation ou mutation DNS disponible. |

Le contrat transmis par le backend inclut `openSource: { license: "Apache-2.0", repository: "https://github.com/mehdinajeddine/fullpanel" }`, les liens fixes vers ce dépôt, ses issues et `LICENSE`, et `release: { commit: string | null }`. La variable optionnelle `COMMUNITY_RELEASE_COMMIT` n’accepte qu’un SHA de 40 chiffres hexadécimaux ; sa valeur déclarée ne remplace pas une vérification de la release hébergée. Les tests doivent rester alignés avec ces schémas.

Les routes de réservation/inscription éventuellement exposées sous `/api/v1/community-domains` doivent répondre **503** avec le code `COMMUNITY_DOMAINS_UNAVAILABLE`, sans analyser ni conserver le corps envoyé. Ce refus explicite n’est pas une API d’inscription livrée. Le statut « planned » du broker et son indicateur désactivé ne deviennent pas « opérationnel » parce que `/api/health` répond 200 ; un simple champ de configuration ne doit pas activer une fonction absente.

Ces routes ne requièrent aucun identifiant personnel et ne renvoient que des informations publiques. Aucun dump de variables d’environnement, identifiant de compte fournisseur, clé, adresse interne ou stack trace ne doit apparaître. Les routes API inconnues répondent comme API inconnues, jamais avec le HTML de la page d’accueil. Les méthodes de mutation ne doivent produire aucun effet de bord ; les éventuelles réponses HEAD/OPTIONS restent sans mutation.

La configuration du site ne doit pas créer de CORS permissif avec credentials, de session partagée entre domaines ni de proxy vers une URL arbitraire. Les limites de requête et les en-têtes de sécurité sont vérifiés sur le serveur réellement déployé ; un contrôle de code local n’établit pas à lui seul les protections du routeur d’hébergement.

## Persistance et secrets

Ce premier service peut être sans registre applicatif parce qu’il ne réserve rien et ne modifie aucun DNS. Les logs d’exploitation ne constituent pas un registre d’installations. Le système de fichiers des dynos est éphémère ; une inscription stockée dans un fichier ou dans la mémoire du processus serait perdue au redémarrage. [Heroku, système de fichiers des dynos](https://devcenter.heroku.com/articles/dynos#ephemeral-filesystem).

Avant toute activation du broker, il faut un registre durable avec transactions, contraintes uniques, empreintes de jetons, défis consommables, réservations non réattribuables, état DNS désiré/appliqué et journal de reprise. Sa sauvegarde et sa restauration doivent être testées. PostgreSQL est envisagé dans M04 ; ni sa création, ni son coût, ni son exploitation ne sont implicitement couverts par le dyno Basic initial.

**Aucun identifiant GoDaddy n’est configuré pour ce lot.** Leur absence est attendue et ne doit pas faire échouer les endpoints d’information. Le fournisseur retenu pour la suite reste GoDaddy, avec API uniquement côté backend ; aucune clé ne doit être demandée au navigateur ou distribuée aux installations. Une activation ultérieure requiert contrat API/scopes vérifiés et recette M04, pas seulement l’ajout d’un secret dans Heroku.

## Livraison et preuves attendues

1. Build reproductible du site et du serveur depuis `community/`, lancement avec un port fourni, test des deux endpoints et des routes inconnues.
2. Vérification que le site et `/api/v1/info` présentent les mêmes capacités, avec broker planifié et désactivé ; aucune route d’inscription ou de mutation DNS fonctionnelle.
3. Vérification du périmètre déployé : un `web` Basic, commande correcte, aucun worker/add-on ajouté implicitement et absence de secrets GoDaddy dans la configuration de ce lot.
4. Sur l’URL publique réellement obtenue : HTTPS valide, page et ressources chargées, réponses API correctes, absence d’erreur de console et affichage lisible sur ordinateur/mobile.
5. Redémarrage ou nouvelle release : site/API reviennent sans perte de réservation, puisqu’aucune réservation n’est acceptée ; aucune fausse dépendance à un fichier local persistant.
6. Si un domaine personnalisé est ajouté : DNS autoritatif et certificat vérifiés séparément, sans modification du routage des installations clientes.

Les résultats, URL, release et date doivent être consignés après exécution. En l’absence de ces preuves, décrire ce lot comme préparé ou en cours ; la simple présence de code, de tests locaux ou d’une session CLI autorisée ne prouve pas le déploiement.
