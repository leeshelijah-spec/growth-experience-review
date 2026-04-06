# Releasing Growth Experience Review (G.E.R)

## 1. Create a new GitHub repository

Recommended repository name:

- `growth-experience-review`

Suggested description:

- `Weekly mentoring reports and dashboard for Codex archived sessions`

Do not upload the `generated/` contents. They are already ignored in `.gitignore`.

## 2. Initialize the local repository

From the project folder:

```powershell
git init -b main
git add .
git commit -m "Initial G.E.R release"
```

## 3. Connect the GitHub repository

Replace the URL below with your own repository URL:

```powershell
git remote add origin https://github.com/<your-account>/growth-experience-review.git
git push -u origin main
```

## 4. Create the first version tag

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## 5. Create the GitHub release

In GitHub:

1. Open the repository.
2. Open `Releases`.
3. Choose `Draft a new release`.
4. Select tag `v0.1.0`.
5. Use the notes from `release-notes/v0.1.0.md`.

## Before publishing publicly

- choose a license
- confirm no private `generated/` output is included
- review the README once more from a non-developer perspective
