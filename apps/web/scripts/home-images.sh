#!/usr/bin/env bash
# 把 demo/images 的首頁情境照轉成 WebP 多種寬度，輸出到 apps/web/public/home/（隨 Web 部署的靜態資源）。
# 需要 ImageMagick（magick）。重跑會覆寫既有檔案。
set -euo pipefail
cd "$(dirname "$0")/../../.."

out=apps/web/public/home
mkdir -p "$out"

# 主視覺：1660x948 的原圖縮成 640、1024、1600 寬
for n in 1 2 3; do
  for w in 640 1024 1600; do
    magick "demo/images/hero-$n.jpg" -resize "${w}x" -quality 78 "$out/hero-$n-$w.webp"
  done
done

# 編輯式橫幅：1122x1402 的原圖縮成 480、800、1122 寬（不放大）
for w in 480 800 1122; do
  magick demo/images/banner.jpg -resize "${w}x" -quality 78 "$out/banner-$w.webp"
done
