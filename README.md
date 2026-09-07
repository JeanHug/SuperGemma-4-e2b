# Gemma 4 E2B — Interface de Raisonnement & Déploiement GitHub Pages

Interface conversationnelle moderne et ultra-rapide pour le modèle **Gemma 4 E2B** avec support du raisonnement pas-à-pas (*Thinking / No-Thinking*), streaming temps réel SSE, rendu KaTeX mathématique, métriques matérielles (latence, TPS, durée, tokens), purge du cache KV et compatibilité totale avec **GitHub Pages**.

---

## 🚀 Déploiement sur GitHub Pages

GitHub Pages est un hébergement statique gratuit. Ce projet est préconfiguré pour être déployé en 1 clic grâce à **GitHub Actions**.

### 1. Téléverser le projet sur votre dépôt GitHub vide
Dans votre terminal local (ou via l'interface web GitHub) :

```bash
# 1. Initialisez le dépôt git (si ce n'est pas déjà fait)
git init
git add .
git commit -m "Initial commit: Gemma 4 E2B Web UI"

# 2. Reliez votre dépôt distant et poussez le code
git branch -M main
git remote add origin https://github.com/<VOTRE-UTILISATEUR>/<VOTRE-REPOS>.git
git push -u origin main
```

### 2. Activer GitHub Pages via GitHub Actions
1. Allez sur votre dépôt GitHub dans votre navigateur.
2. Rendez-vous dans **Settings** > **Pages**.
3. Dans la section **Build and deployment** > **Source**, sélectionnez **GitHub Actions**.
4. Dès que vous poussez sur `main`, le workflow `.github/workflows/deploy.yml` se lance automatiquement et déploie le site en quelques secondes sur `https://<votre-utilisateur>.github.io/<votre-repos>/`.

---

## 🌐 Connecter le site GitHub Pages à votre Codespace Gemma 4

Puisque GitHub Pages sert le site statiquement dans le navigateur :

### Option A : Accès direct via le port Codespace public (Recommandé)
1. Dans votre Codespace ou via votre terminal avec le GitHub CLI (`gh`) :
   ```bash
   gh codespace ports visibility 8080:public -c literate-space-lamp-g4px7pr4j4r5cvvr
   ```
2. Sur votre site GitHub Pages, cliquez sur le bouton **API** en haut à droite.
3. Entrez l'URL de votre Codespace :
   ```text
   https://literate-space-lamp-g4px7pr4j4r5cvvr-8080.app.github.dev/v1/chat/completions
   ```
4. Cliquez sur **Enregistrer**. Vous pouvez désormais interroger Gemma 4 en direct depuis n'importe quel appareil !

### Option B : Serveur Node.js complet (Local ou Cloud)
Si vous lancez l'application avec son serveur Node intégré :
```bash
npm install
npm run dev
```
Le serveur proxy gère automatiquement la communication sécurisée avec le Codespace via le token GitHub (`VM_TOKEN`).

---

## 🛠️ Commandes utiles

- `npm run dev` : Lance le serveur de développement local sur le port 3000.
- `npm run build` : Compile le client statique Vite dans `dist/` et le serveur Node.
- `npx vite build` : Compile uniquement le frontend statique prêt pour GitHub Pages.
