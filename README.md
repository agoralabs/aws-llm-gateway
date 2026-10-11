# AWS LLM Gateway

Gateway personnelle GitHub Copilot SDK déployée dans AWS via la VM Vagrant `ubuntujammy`.

- API HTTPS : `https://llm.kaiac.io`
- WebSocket de génération : `wss://llm.kaiac.io/v1/ws`
- Infrastructure : Terraform, ALB, ECS Fargate, SQS FIFO, S3, ECR, Secrets Manager, Route 53 et ACM.
- Région par défaut : `us-west-2`.
- Pas de JWT en V1 : le security group de l'ALB autorise uniquement l'IPv4 publique détectée au déploiement.
- Aucun DynamoDB.

## Déploiement

Le déploiement se fait dans la VM, sous root, avec le profil AWS `default`. La configuration AWS (`~/.aws/config` et credentials) doit être disponible pour root dans la VM. Le script ne lit ni n'affiche les credentials.

Depuis PowerShell :

```powershell
cd C:\Dev\vagrant\ubuntujammy
vagrant ssh
```

Dans la VM :

```bash
sudo su
cd /vagrant/aws-llm-gateway
AWS_PROFILE=default AWS_REGION=us-west-2 bash scripts/deploy.sh
```

Le script détecte l'IPv4 publique de sortie de la VM et l'autorise en `/32`. On peut la fournir explicitement avec `CLIENT_IPV4_CIDR=203.0.113.10/32`. Il demande confirmation Terraform avant chaque `apply`.

Au premier lancement, il crée les ressources avec `desired_count=0`, construit/pousse l'image dans ECR et s'arrête si le secret Copilot n'est pas encore renseigné. Après ce premier passage, toujours dans la VM et le même shell root :

```bash
bash scripts/set-copilot-token.sh
AWS_PROFILE=default AWS_REGION=us-west-2 bash scripts/deploy.sh
```

Le token est saisi sans écho et envoyé directement à Secrets Manager via stdin. Il n'est jamais écrit dans Terraform, le dépôt, l'image Docker ou les logs. Lors d'une rotation, relancer le script de saisie puis le déploiement pour réinjecter le secret dans la tâche ECS.

### Certificats TLS du runtime Copilot

L'image `node:22-slim` peut ne pas fournir le magasin de certificats racine système attendu par le runtime natif du Copilot SDK. Celui-ci utilise ce magasin pour établir ses connexions TLS vers GitHub; sans `ca-certificates`, la vérification TLS peut échouer avant l'authentification. Le runtime peut alors afficher `No GitHub OAuth token or Copilot HMAC key provided`, même si `COPILOT_GITHUB_TOKEN` est bien injecté dans la tâche ECS. Le Dockerfile installe `ca-certificates` pour fournir ce magasin système. Si cette erreur apparaît malgré la présence du secret, vérifier aussi les certificats CA de l'image et reconstruire/redéployer l'image après toute modification du Dockerfile.

Le script de déploiement met à jour l'allowlist réseau si l'IP publique change. L'ALB n'a pas de règle d'entrée `0.0.0.0/0` ou `::/0`. Si l'IP change après le déploiement, relancer le déploiement pour mettre à jour la règle.

**Coûts :** le premier `terraform apply` crée un ALB, un VPC, des ressources ECS et d'autres ressources facturables même si la tâche reste à zéro. Vérifier le plan avant de confirmer. Le projet ne déploie rien dans AWS automatiquement à l'ouverture de ce dépôt.

## Architecture et flux des jobs

1. Le client se connecte à l'ALB par WebSocket et envoie `startGeneration`.
2. L'API dépose le prompt et un manifeste `queued` dans S3, puis crée un index `requestId` conditionnel dans S3.
3. Elle envoie uniquement le `jobId` dans la file SQS FIFO et répond `accepted`.
4. Le worker long-polle SQS, lit le prompt dans S3, crée une session Copilot et envoie les deltas à la WebSocket.
5. Le résultat final est écrit dans S3; le manifeste prend le statut terminal; le message est supprimé de SQS.

SQS FIFO sérialise les jobs via un groupe unique. La visibilité du message est prolongée périodiquement durant le traitement. La déduplication native SQS ne couvre que 5 minutes; l'index `requests/{requestId}.json` permet une idempotence durable pendant sa rétention S3 de 30 jours. Les prompts temporaires expirent après un jour; manifestes et résultats après 30 jours.

SQS n'est pas une base d'état : `GET /v1/jobs/{id}` lit le manifeste S3. Si la tâche meurt après le passage à `running`, le message redevient visible; une nouvelle livraison marque le job `interrupted` au lieu de relancer une deuxième génération. Le texte partiel est conservé dans S3 si l'arrêt gracieux a pu s'exécuter.

## Endpoints

### HTTP

| Méthode | Chemin | Usage |
|---|---|---|
| `GET` | `/health` | Santé de l'application et du runtime démarré. |
| `GET` | `/v1/models` | Modèles autorisés par `ALLOWED_MODELS`. |
| `GET` | `/v1/jobs/{jobId}` | Lire le manifeste d'un job. |
| `GET` | `/v1/jobs/{jobId}/result` | Télécharger le résultat Markdown depuis S3. |

### WebSocket

Connexion à `wss://llm.kaiac.io/v1/ws`, puis envoyer un message JSON :

```json
{"action":"startGeneration","requestId":"unique-client-id","model":"gpt-5.4","prompt":"Question à Copilot"}
```

Actions disponibles :

```json
{"action":"watchJob","jobId":"job_<uuid>"}
{"action":"getJob","jobId":"job_<uuid>"}
{"action":"cancelJob","jobId":"job_<uuid>"}
```

Le serveur répond par `accepted`, `delta`, puis `completed`, `truncated`, `cancelled`, `interrupted` ou `failed`. `cancelJob` est best-effort. Une coupure WebSocket n'arrête pas un job; se reconnecter puis envoyer `watchJob`.

La V1 n'est pas compatible avec le format de streaming SSE/OpenAI. La génération en direct utilise le protocole WebSocket ci-dessus.

## Console frontend locale

Depuis la racine du projet, lancer `npm run frontend`, puis ouvrir `http://127.0.0.1:4173`. La console appelle directement `https://llm.kaiac.io` par défaut; le champ **Cible API** peut être réglé sur `http://127.0.0.1:8080` pour tester une instance locale. Elle couvre `/health`, `/v1/models`, `/v1/jobs/{jobId}`, `/v1/jobs/{jobId}/result` et les actions WebSocket `startGeneration`, `getJob`, `watchJob`, `cancelJob`.

L'API autorise CORS depuis toutes les origines pour permettre cette interface locale. Après une modification du serveur, relancer le déploiement pour que les nouvelles en-têtes soient actives sur AWS. CORS n'est pas une authentification : l'accès reste limité par le security group à l'IPv4 autorisée, et toute page ouverte depuis ce réseau pourra appeler l'API. Ne pas ouvrir le security group à Internet.

## Déploiement de la console sur Amplify

Le dossier `amplify/` contient un Terraform indépendant qui associe une application Amplify existante à `https://gatewaylab.kaiac.io`. Pour réutiliser l'autorisation GitHub OAuth de la console Amplify sans PAT Terraform, créer l'application dans Amplify Console, connecter le dépôt `agoralabs/aws-llm-gateway` et sa branche `main`, puis récupérer l'App ID. Le fichier racine `amplify.yml` installe les dépendances frontend, construit le bundle et publie `frontend/dist/`. Amplify gère le certificat HTTPS; Terraform crée les enregistrements DNS de validation et le CNAME du site.

Depuis la VM, dans un shell root, fournir l'App ID puis appliquer le Terraform :

```bash
cd /vagrant/aws-llm-gateway/amplify
export AWS_PROFILE=default AWS_REGION=us-west-2
read -r -p "Amplify app ID: " TF_VAR_amplify_app_id
export TF_VAR_amplify_app_id
terraform init
terraform plan
terraform apply
unset TF_VAR_amplify_app_id
```

Terraform ne crée ni ne modifie la liaison GitHub de l'application; cette liaison reste gérée par Amplify Console. La console continue d'appeler directement `https://llm.kaiac.io` et `wss://llm.kaiac.io/v1/ws`; CORS est déjà activé sur l'API. L'ALB du gateway reste limité à l'IPv4 autorisée par son security group : le navigateur doit accéder depuis cette IP, car Amplify héberge les fichiers statiques et ne relaie pas les appels API.

## Collection Postman

Importer dans Postman :

- `postman/aws-llm-gateway.postman_collection.json`
- `postman/aws-llm-gateway.postman_environment.json`

Sélectionner l'environnement **AWS LLM Gateway**. La collection contient les quatre routes HTTP et des demandes WebSocket avec les messages JSON d'exemple dans leur description. Ouvrir la connexion WebSocket puis envoyer le message dans l'onglet Messages de Postman. Aucun header `Authorization` n'est utilisé; l'IP publique du poste doit être autorisée par le security group.

## Terraform

Le répertoire `terraform/` contient le VPC public sur deux AZ, l'ALB/ACM/Route 53, ECS Fargate, ECR, les files FIFO/DLQ, le bucket S3, les rôles IAM et le secret Copilot. Le secret est créé sans valeur par Terraform pour éviter d'écrire le token dans le state. Les fichiers `*.tfvars`, le state local et les plans sont exclus de Git.

Pour valider sans déployer, depuis la VM :

```bash
cd /vagrant/aws-llm-gateway/terraform
terraform init -backend=false
terraform validate
```

Le projet utilise le profil AWS `default` fourni à Terraform par `AWS_PROFILE`; aucun nom de profil n'est encodé dans la configuration.
