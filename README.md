# Pyinsect

A web app that identifies insects in photos with the Pyinsect 2.7 model (154 classes) and
reports invasive species.

| Where | What it does |
|---|---|
| This repo on GitHub Pages (`/`) | Identify: pick photos, the model runs in the browser |
| `relay/worker.js` on Cloudflare | Receives reports and saves them to a **private** repo |
| `https://<worker>/<secret word>/` | The reports page: password-protected, refreshes every 15 s |

This repo is public, so it holds no reports and no tokens. Reports (one `.json` and one `.jpg`
per find) live in `reports/` of a separate private repo that only the relay can read and write.

## Setup

1. **Site repo.** Create a **public** repository and upload everything in this folder
   (`index.html`, `README.md`, `assets/`, `model/`, `relay/`) to its root. Then **Settings →
   Pages → Deploy from a branch → main → / (root)**. The site is live a minute later at
   `https://<your-username>.github.io/<repository>/`.
2. **Reports repo.** Create a second repository and make it **private** (for example
   `pyinsect-reports-data`). Tick "Add a README" so it isn't empty.
3. **Token.** GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
   - Repository access: **Only select repositories** → the private reports repo
   - Repository permissions → **Contents: Read and write** (everything else No access)
4. **Relay.** The token must never be in this repo's files. A free Cloudflare Worker holds it:
   1. Sign up at https://dash.cloudflare.com/sign-up (free).
   2. **Workers & Pages → Create → Start with Hello World**, name it `pyinsect-relay`, **Deploy**.
   3. **Edit code**, replace everything with the contents of `relay/worker.js`, **Deploy**.
   4. **Settings → Variables and Secrets → Add**:
      - `GITHUB_TOKEN`, **Secret**: the token from step 3
      - `GITHUB_REPO`, Text: `<your-username>/<private reports repo>`
      - `ALLOWED_ORIGIN`, Text: `https://<your-username>.github.io`
      - `VIEW_PASSWORD`, **Secret**: the password for the reports page
      - `VIEW_PATH`, **Secret**: a secret word for the page address (letters, digits, `-`, `_`)
   5. Put the worker's address (`https://pyinsect-relay.<something>.workers.dev`) in
      `RELAY_URL` at the top of `assets/reports.js`.
5. **Reports page:** `https://pyinsect-relay.<something>.workers.dev/<VIEW_PATH>/`. Share that
   link and the password only with people who should see reports.

## Notes

- Anyone can use the identifier, and every invasive find is reported automatically.
- The relay only accepts invasive species, JPEG photos up to 1.5 MB and recent reports, and it
  can only add new files to `reports/`, never change or delete existing ones.
- If a report can't be sent (no internet), it waits in the browser and is sent with the next
  report, when the connection comes back, or with **Send waiting reports**.
- To change the password or the secret word, edit `VIEW_PASSWORD` / `VIEW_PATH` in Cloudflare.
  Everyone then has to use the new link and password.
- The invasive species list is `INVASIVE` in `index.html` **and** in `relay/worker.js`. Change
  both, then paste `worker.js` into Cloudflare again (**Edit code → Deploy**).
- The reports page has its own copy of the site's styles inside `relay/worker.js`, so it keeps
  working if the site moves or is renamed.
- To use a newer model, replace `model/insect_model.onnx` and update `CLASS_NAMES` in
  `index.html`. `convert_to_onnx.py` in the app folder converts a `.pth` and writes its class
  list to `assets/models/models.json`.
