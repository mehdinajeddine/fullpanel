# FullPanel — état de reprise au gel du 8 novembre 2026

Le propriétaire demande de figer le développement et de sauvegarder le travail sur GitHub, avec 2 % de quota restant. La boucle est à mettre en pause après commit/push. Ne reprendre les déploiements ou le développement que sur nouvelle demande.

## Lot conservé dans ce commit

- Registre PostgreSQL interne : réservations permanentes, isolation par propriétaire, idempotence, jetons hachés, rotation/révocation atomiques et historique conservé.
- Vérificateur de contrôle IPv4 borné et contrôle HTTP `/api/ready`, avec site disponible lorsque la base ne répond pas.
- 28 tests communautaires sous Node 24 et 11 tests PostgreSQL réels réussis. Revue indépendante sans défaut bloquant identifié sur ce périmètre.
- Notices complètes des 14 dépendances npm, contrôle au build et tests PostgreSQL ajoutés à la CI.
- Contrat GoDaddy documenté dans [la spécification 22](specs/22-godaddy-dns-adapter.md), sans appel authentifié ni mutation DNS.

Ces modules ne fournissent pas encore une inscription communautaire : authentification des propriétaires, défis persistants/consommation atomique, reprise des opérations DNS, quotas, sauvegarde/restauration et intégration au panel restent à réaliser. La matrice [FEATURE-PARITY.md](FEATURE-PARITY.md) conserve les autres écarts du projet.

## État réellement hébergé

Le [site communautaire](https://fullpanel-web-api-4e0abb9d60c3.herokuapp.com/) utilise toujours le code `9ecf22a`, release Heroku v4, puis configuration v5 pour PostgreSQL. **Le code du présent lot n’a pas été redéployé.** L’inscription publique reste désactivée.

La migration v1 du seul schéma `fullpanel_registry` a été appliquée et relue sur PostgreSQL 18.4 avec TLS et hostname vérifiés. Sa seconde exécution n’a rien modifié. Cinq tables, zéro installation/jeton ; vues de supervision du fournisseur préservées. Les preuves sont décrites dans [VERIFICATION.md](VERIFICATION.md). Ne pas relancer le script privé de première migration qui exige un registre initialement absent : utiliser, si nécessaire, la CLI idempotente `node community/registry/migrate.mjs` avec les secrets uniquement dans l’environnement.

Budget autorisé : **un web Basic + un PostgreSQL Essential-0**, 12 USD/mois au total. Aucun worker supplémentaire. L’installation AWS et ses applications n’ont pas été modifiées par ce lot ; son arrêt automatique prévu pour le 15 novembre 2026 à 21:12:07 UTC reste à préserver.

## Prochaine livraison, après reprise explicite

1. Vérifier le résultat de la CI du commit gelé. Les tests locaux sont passés ; ne pas présumer le résultat distant.
2. Configurer `COMMUNITY_DATABASE_CA_FILE=/usr/lib/ssl/certs/ca-certificates.crt` sur Heroku-24, sans afficher `DATABASE_URL`. Le client exige une chaîne TLS et un hostname valides ; aucun contournement de cette vérification.
3. Déployer uniquement le sous-arbre `community/` dans `fullpanel-web-api`, avec le SHA source dans `COMMUNITY_RELEASE_COMMIT`. Ne jamais pousser le panel Docker racine sur cette application.
4. Vérifier le site, `/api/health`, `/api/ready`, `/api/v1/info`, les ressources et la formation Heroku. L’inscription doit toujours répondre 503. Consigner la release réellement vérifiée.
5. Poursuivre M04 sans activer les écritures publiques avant authentification, preuve consommable et orchestration testées.

## DNS externe en attente

Le propriétaire ne voit pas ses domaines dans son compte GoDaddy et a reçu un brouillon de demande au support ; aucun ticket n’a été envoyé par l’agent. L’accès au compte et aux DNS doit être rétabli avant raccordement.

Pour `www.fullpanel.io`, la cible CNAME Heroku déjà attribuée est `vast-nodosaurus-g93nns0pavpq2ptv1w3nh6mj.herokudns.com`. Le domaine est attaché, ACM activé mais validation DNS/certificat en attente. L’apex `fullpanel.io` doit être redirigé par GoDaddy en HTTPS/301 vers `www`. Le canonical reste le hostname Heroku jusqu’à validation effective. `fullpanel.dev` reste réservé au service communautaire futur ; aucun wildcard global vers l’instance AWS.

Les dossiers locaux sans rapport `.claude/` et `specs/` sont laissés hors commit. Les secrets et reçus opérateur restent dans `.local/`, ignoré par Git.
