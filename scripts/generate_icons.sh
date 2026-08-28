#!/bin/bash

# Генерация простых иконок через ImageMagick
# Если ImageMagick не установлен, выполни: apt install imagemagick

mkdir -p web/icons

# Генерация иконки 192x192
convert -size 192x192 xc:'#7c6cff' \
    -fill white \
    -draw "circle 96,96 96,40" \
    -fill '#7c6cff' \
    -draw "polygon 70,110 110,80 130,90 90,120" \
    web/icons/icon-192.png

# Генерация иконки 512x512
convert -size 512x512 xc:'#7c6cff' \
    -fill white \
    -draw "circle 256,256 256,106" \
    -fill '#7c6cff' \
    -draw "polygon 186,293 293,213 346,240 240,320" \
    web/icons/icon-512.png

echo "Icons generated successfully!"
