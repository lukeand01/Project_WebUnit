# My Web Unity

My Web Unity is an independent Node.js app that gates a Unity code workspace behind GitHub sign-in. It can list repositories, browse and edit text files, create a GitHub commit, and run Unity's batch-mode editor against a temporary checkout. It is not affiliated with Unity Technologies.

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

## Roslyn C# autocomplete

The Render Blueprint adds a private `webunity-roslyn` service. It runs Microsoft's Roslyn language server in a .NET 10 container; the public Node service authenticates the browser's WebSocket and relays LSP messages to that private worker. The worker clones the selected GitHub repository and branch with the signed-in user's token, starts one isolated language-server process for the workspace, and deletes the temporary checkout when the WebSocket closes. The token stays on the server and is never sent to the browser.

The worker has a `1c-2g` compute plan and is a paid Render service. Keep it private and configure `INTERNAL_SECRET` only through Render's generated environment value. The web service receives the worker host and secret through `fromService` references. Do not sync the new Blueprint service until you are ready to add the worker and its Render plan cost.

The worker automatically loads checked-in `.sln`/`.csproj` files. If a Unity repository does not include generated project files, the worker creates a temporary SDK project for its C# sources. To enable Unity API completion in that case, set `UNITY_REFERENCES_ROOT` on the worker to a directory containing the matching Unity Editor's `Editor/Data/Managed` assemblies. The worker reads the Unity version from `ProjectSettings/ProjectVersion.txt` and looks for the matching version subdirectory. If those assemblies are unavailable, completion still covers the project and .NET types, but Unity-specific types may be unresolved. Generated Unity project files or references must correspond to the project's Unity version.

The Roslyn language-server tool is installed as a prerelease in the worker image, so rebuild and review the image when updating it. The worker allows two concurrent workspaces by default; set `MAX_LSP_SESSIONS` to change that limit.
