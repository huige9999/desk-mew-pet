---
name: sync-svn
description: Sync desk-mew-pet project from WSL to Windows mirror using rsync. Use when user says "帮我同步到SVN" or "sync to SVN" or asks to sync the desk-mew-pet project.
---

# Sync SVN

Synchronize desk-mew-pet source code from WSL to Windows mirror workspace.

## Command

Execute rsync directly:

```bash
rsync -av --delete \
  --no-perms --no-owner --no-group \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.idea' \
  --exclude '.vscode' \
  --exclude 'dist' \
  --exclude 'target' \
  ~/projects/person/desk-mew-pet/ /mnt/d/mirrorOfWSL/desk-mew-pet/
```

## Notes

- Source path (WSL): `~/projects/person/desk-mew-pet`
- Target path (mounted): `/mnt/d/mirrorOfWSL/desk-mew-pet` (Windows D: drive is mounted at /mnt/d/)
- Windows path: `D:\mirrorOfWSL\desk-mew-pet`
- Excludes `node_modules` and build artifacts
