# Upload Guide

## Opsi Cepat

```bash
npm run github:upload
```

## Opsi Manual

```bash
git init
git add .
git commit -m "chore(repo): bootstrap repository"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

## Catatan

- jalankan dari root project
- cek `git status` dulu sebelum commit
- jangan push dari worktree yang masih berisi file sensitif atau artefak build

## Setelah Upload

1. Tambahkan description repository
2. Tambahkan topics GitHub
3. Aktifkan branch protection untuk `main`
4. Gunakan PR template untuk update berikutnya
