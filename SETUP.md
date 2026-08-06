# Setup — Phase 1 foundation

These are the steps **you** do in the Firebase console (I can't create your
project for you — it needs your Google account). Everything stays on the free
**Spark** plan, no credit card. Do them in order.

## 1. Create a clean Firebase project
- console.firebase.google.com → **Add project** → name it (e.g. `partimap-flood`).
- Google Analytics is optional; you can skip it.

## 2. Register a Web app & copy the config
- In the project, click the **Web** icon (`</>`) → register an app (any nickname).
- Copy the `firebaseConfig` object it shows you into **`app/credentials.js`**,
  replacing every `PASTE_HERE`. Also put the project id in **`.firebaserc`**.
- These values are public identifiers, not secrets — safe to keep in the repo.

## 3. Enable Anonymous sign-in (participants)
- Build → **Authentication** → Get started → **Sign-in method** →
  enable **Anonymous**.

## 4. Enable Email/Password & create ONE host account (admin)
- Same Sign-in method screen → enable **Email/Password**.
- Authentication → **Users** → Add user → create one account for the workshop
  host (e.g. `host@yourstudy.org` + a password). Participants never use this.

## 5. Create the Realtime Database (locked)
- Build → **Realtime Database** → Create database.
- Choose location **europe-west1** (matches data residency).
- Start in **locked mode** (we deploy our own rules next).

## 6. Get a service-account key (for the Python side)
- Project settings (gear) → **Service accounts** → **Generate new private key**.
- Save the downloaded file as **`dashboard/serviceAccountKey.json`**.
- It is already gitignored. **Never commit or share it** — it is full admin access.

## 7. Install the Firebase CLI & deploy rules
```bash
npm install -g firebase-tools     # one-time
firebase login
firebase deploy --only database   # pushes database.rules.json
```

## 8. Grant the host the admin claim
```bash
cd dashboard
pip install -r requirements.txt
python set_admin_claim.py host@yourstudy.org
```
(The host must sign out/in once afterward for the claim to apply.)

## 9. Add your comparison images
- Drop the visual-pairwise images into **`images/visual_v1/`** and list them in
  `config/config.json → item_sets.visual_v1.items` (`id`, `label`, `file`).
- Served free by Firebase Hosting — no Cloud Storage / Blaze needed.

## 10. Run the foundation check
```bash
firebase deploy --only hosting    # or: firebase serve  (local test)
```
- Open the hosted URL. On **`index.html`** you should see three green OKs:
  Firebase initialised, Anonymous sign-in, Config loaded + valid.
- If any are red, the details box says exactly what's missing.

When all three are green, Phase 1 is done and I'll start Phase 2
(consent + config-driven registration + resume).
