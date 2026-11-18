"""Render captured CLI text, without changing or synthesizing its evidence."""
import pathlib
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

source, destination = map(pathlib.Path, sys.argv[1:])
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
font = ImageFont.truetype(font_path, 18)
small = ImageFont.truetype(font_path, 14)
lines = []
for line in source.read_text().splitlines():
    lines.extend(textwrap.wrap(line, 100, replace_whitespace=False, drop_whitespace=False) or [""])
pages = [lines[offset:offset + 28] for offset in range(0, len(lines), 28)]
frames = []
for page, content in enumerate(pages):
    frame = Image.new("RGB", (1180, 730), "#111820")
    draw = ImageDraw.Draw(frame)
    draw.text((30, 18), "QAMap / qa brief", font=font, fill="#a5d6ff")
    draw.line((30, 52, 1150, 52), fill="#354252")
    for row, line in enumerate(content):
        color = "#d8e2ef"
        if line.startswith("+"): color = "#a5e3aa"
        elif line.startswith("-") and "|" in line: color = "#ffb4b4"
        elif line.startswith(("==", "###", "$")): color = "#a5d6ff"
        draw.text((30, 72 + row * 21), line, font=font, fill=color)
    draw.text((30, 692), "Actual static output / playback speed is illustrative", font=small, fill="#a2afbf")
    draw.text((1050, 692), f"{page + 1}/{len(pages)}", font=small, fill="#a2afbf")
    frames.append(frame)
frames[0].save(destination, save_all=True, append_images=frames[1:], duration=4500, loop=0, optimize=True)
if destination.stat().st_size >= 2_000_000:
    raise RuntimeError("Demo exceeds the 2 MB documentation budget")
