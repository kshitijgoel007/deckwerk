#!/usr/bin/env python3
"""Generate reference.pptx: a PowerPoint deck with known geometry.

The importer regression test asserts exact canvas positions against what this
script placed, so every number here is a fact the test relies on. Regenerate
with the project venv after `pip install python-pptx`:

    ./.venv-import/bin/python test/fixtures/pptx/make_reference.py

The slide is 16:9 at 13.333 x 7.5 inches (12192000 x 6858000 EMU), which the
importer maps to a 1920 x 1080 canvas: one inch is 144 px and one point 2 px.
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

OUT = Path(__file__).with_name("reference.pptx")


def main() -> None:
    prs = Presentation()
    prs.slide_width = Emu(12192000)
    prs.slide_height = Emu(6858000)

    # Slide 1: title placeholders, so role tagging has ground truth.
    title_slide = prs.slides.add_slide(prs.slide_layouts[0])
    title_slide.shapes.title.text = "Reference deck"
    title_slide.placeholders[1].text = "Known geometry for the importer"

    # Slide 2: plain shapes at inch-aligned positions.
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2))
    rect.fill.solid()
    rect.fill.fore_color.rgb = RGBColor(0xFF, 0x00, 0x00)
    rect.line.fill.background()
    rect.name = "red-rect"

    ellipse = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5), Inches(1), Inches(2), Inches(2))
    ellipse.fill.solid()
    ellipse.fill.fore_color.rgb = RGBColor(0x00, 0x00, 0xFF)
    ellipse.line.color.rgb = RGBColor(0x00, 0x00, 0x00)
    ellipse.line.width = Pt(3)
    ellipse.name = "blue-ellipse"

    rotated = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(8), Inches(1), Inches(2), Inches(1))
    rotated.rotation = 30
    rotated.fill.solid()
    rotated.fill.fore_color.rgb = RGBColor(0x00, 0x80, 0x00)
    rotated.line.fill.background()
    rotated.name = "rotated-rect"

    rounded = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(4), Inches(2), Inches(1))
    rounded.fill.solid()
    rounded.fill.fore_color.rgb = RGBColor(0x80, 0x80, 0x80)
    rounded.line.fill.background()
    rounded.name = "rounded-rect"

    triangle = slide.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, Inches(4), Inches(4), Inches(2), Inches(2))
    triangle.fill.solid()
    triangle.fill.fore_color.rgb = RGBColor(0xFF, 0xA5, 0x00)
    triangle.line.fill.background()
    triangle.name = "triangle"

    arrow = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(7), Inches(4), Inches(10), Inches(6))
    arrow.line.color.rgb = RGBColor(0x00, 0x00, 0x00)
    arrow.line.width = Pt(2)
    tail = arrow.line._get_or_add_ln().makeelement(qn("a:tailEnd"), {"type": "triangle"})
    arrow.line._get_or_add_ln().append(tail)
    arrow.name = "arrow"

    text = slide.shapes.add_textbox(Inches(8), Inches(0.25), Inches(4), Inches(0.5))
    text.name = "hello"
    paragraph = text.text_frame.paragraphs[0]
    run = paragraph.add_run()
    run.text = "Hello "
    run.font.size = Pt(24)
    run.font.bold = True
    run.font.color.rgb = RGBColor(0x12, 0x34, 0x56)
    run2 = paragraph.add_run()
    run2.text = "world"
    run2.font.size = Pt(24)
    run2.font.italic = True
    run2.font.color.rgb = RGBColor(0x12, 0x34, 0x56)
    slide.notes_slide.notes_text_frame.text = "Speaker notes for slide two."

    # Slide 3: a picture, a cropped picture and a group.
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    png = io.BytesIO()
    Image.new("RGB", (400, 200), (10, 200, 30)).save(png, "PNG")
    png.seek(0)
    picture = slide.shapes.add_picture(png, Inches(1), Inches(1), Inches(4), Inches(2))
    picture.name = "picture"
    png.seek(0)
    cropped = slide.shapes.add_picture(png, Inches(6), Inches(1), Inches(2), Inches(2))
    cropped.crop_left = 0.25
    cropped.crop_right = 0.25
    cropped.name = "cropped"
    group = slide.shapes.add_group_shape()
    a = group.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(4), Inches(1), Inches(1))
    a.name = "group-a"
    a.fill.solid()
    a.fill.fore_color.rgb = RGBColor(0x00, 0xFF, 0xFF)
    b = group.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(3), Inches(5), Inches(1), Inches(1))
    b.name = "group-b"
    b.fill.solid()
    b.fill.fore_color.rgb = RGBColor(0xFF, 0x00, 0xFF)
    # Shrink the group to half its child extent to exercise chOff/chExt scaling.
    xfrm = group._element.grpSpPr.xfrm
    xfrm.get_or_add_off().x = Inches(6)
    xfrm.get_or_add_off().y = Inches(4)
    xfrm.get_or_add_ext().cx = Inches(1.5)
    xfrm.get_or_add_ext().cy = Inches(1)
    xfrm.get_or_add_chOff().x = Inches(1)
    xfrm.get_or_add_chOff().y = Inches(4)
    xfrm.get_or_add_chExt().cx = Inches(3)
    xfrm.get_or_add_chExt().cy = Inches(2)

    # Slide 4: bullets in a body placeholder, plus a table.
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Bullets"
    body = slide.placeholders[1].text_frame
    body.text = "First point"
    second = body.add_paragraph()
    second.text = "Nested point"
    second.level = 1
    third = body.add_paragraph()
    third.text = "Second point"
    table = slide.shapes.add_table(2, 2, Inches(7), Inches(4), Inches(4), Inches(1.5)).table
    table.cell(0, 0).text = "A1"
    table.cell(0, 1).text = "B1"
    table.cell(1, 0).text = "A2"
    table.cell(1, 1).text = "B2"

    # Slide 5: hidden.
    hidden = prs.slides.add_slide(prs.slide_layouts[6])
    hidden.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)).text_frame.text = "Hidden slide"
    hidden._element.set("show", "0")

    prs.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
