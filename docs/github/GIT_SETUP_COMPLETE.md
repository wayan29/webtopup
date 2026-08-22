# Git Setup Complete

Jika `npm run github:setup` sudah sukses, verifikasi cepatnya:

```bash
git config --list --global | grep -E "(user\\.|init\\.defaultBranch|push\\.default)"
```

Minimal yang perlu benar:

- `user.name`
- `user.email`
- `init.defaultBranch=main`
- `push.default=simple`

Langkah berikutnya:

1. review [READY_TO_UPLOAD.md](READY_TO_UPLOAD.md)
2. commit perubahan dengan format di [CONTRIBUTING.md](../../CONTRIBUTING.md)
3. upload via [UPLOAD_GUIDE.md](UPLOAD_GUIDE.md)
