# Forge

Forge is a small Node.js app that gates a Unity code workspace behind GitHub sign-in. It can list repositories, browse and edit text files, create a GitHub commit, and run Unity's batch-mode editor against a temporary checkout.

## Run locally

Requires Node.js 20 or newer and Git. Unity checks also require an installed and activated Unity Editor on the machine running the backend.

1. Create a GitHub OAuth App under **GitHub → Settings → Developer settings → OAuth Apps**.
2. Set the app's authorization callback URL to `http://localhost:3000/auth/github/callback`.
3. Copy `.env.example` to `.env` and fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a random `SESSION_SECRET` (at least 32 characters). Set `UNITY_EDITOR_PATH` to the Unity Editor executable if you want compilation checks.
4. Run `npm start`, then open `http://localhost:3000`.

The OAuth app requests GitHub's `repo` scope so the app can read private repositories and push commits. Review that permission on GitHub's consent page before authorizing.

## Unity checks

The backend clones the selected branch into a temporary directory, overlays unsaved script edits, then launches Unity with `-batchmode -nographics -quit -accept-apiupdate -projectPath`. Unity import and compilation happen on the backend host. Set `UNITY_EDITOR_PATH` to a licensed Editor installation there. The temporary checkout is deleted after the check. Git LFS contents are skipped, and submodules are not initialized, so a project that needs either may not compile in this first version.

## Hosting

The project includes a Render Blueprint (`render.yaml`) for the Node.js web app. Connect the GitHub repository in Render, then create the service from the Blueprint. The service can start before GitHub OAuth is configured. After Render assigns the app URL, create a GitHub OAuth App with callback URL `https://YOUR-APP.onrender.com/auth/github/callback`. Add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL` to the Render service environment, using that exact callback URL, then redeploy. Keep `COOKIE_SECURE=true` for HTTPS. The free web service can sleep when idle, so the first visit after inactivity may take longer.

The Render service provides the login page, GitHub repository browsing, editing, and commits. Unity checks also require an installed and activated Editor on the backend host. The included free Render service does not install Unity; set `UNITY_EDITOR_PATH` only if the host has an Editor available. The current session store is in memory, so signing in again is required after a server restart; use a persistent session store before running multiple server instances.

The browser never receives the GitHub access token. This starter keeps sessions in the backend process and uses GitHub's REST Git Database API to create a commit on the selected branch.
